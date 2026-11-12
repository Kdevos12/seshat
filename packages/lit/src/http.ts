import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "@seshat/core";

/**
 * The only way `lit.search` reaches a site. Everything a site answers is hostile text (Global Constraint 16): the request goes
 * to an allowed host over https only (a loopback address is allowed so that a test can run a fake server), a redirect is an error
 * (it would go to a host nobody checked), the answer is read up to a size limit and refused beyond it, and only a text type is read.
 */
export type Fetch = typeof fetch;

export class LitError extends Error {
  /** The site could not be reached or is busy (no answer, 5xx, 408, 429); otherwise it answered with something refused. */
  readonly unreachable: boolean;
  /** The HTTP status of a refused answer, when there was one. */
  readonly status: number | undefined;

  constructor(message: string, options: { unreachable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "LitError";
    this.unreachable = options.unreachable ?? false;
    this.status = options.status;
  }
}

export interface FetcherOptions {
  /** The hosts this backend may talk to, by hostname. */
  allowedHosts: readonly string[];
  fetch?: Fetch;
  /** The most bytes of an answer read. Default 1 MiB. */
  maxBytes?: number;
  timeoutMs?: number;
  /** The least time between two requests. Default 1000 ms; the tests use 0. */
  minIntervalMs?: number;
  userAgent?: string;
  /** Headers added to every request, read at call time (a key from the environment). Never part of the cache key, an address or an error message. */
  headers?: () => Record<string, string>;
  /** When set, an HTTP 429 is retried once after this many milliseconds. Default 0: no retry. */
  retry429Ms?: number;
  /** The pause between requests and before a retry; injectable so that a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Answers kept on disk: the directory, how many days an answer stays fresh, and the backend's id (part of the key). Absent: no cache. */
  cache?: { dir: string; days: number; backend: string };
}

/** What a request gave: the text, the HTTP status it came with, and whether it was read from the cache. */
export interface Answer {
  body: string;
  status: number;
  cached: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_MAX_BYTES = 1024 * 1024;
const TEXT_TYPES = /^(?:application\/(?:json|xml|atom\+xml|[\w.+-]*\+json|[\w.+-]*\+xml)|text\/[\w.+-]+)(?:\s*;.*)?$/i;
const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "[::1]";

/** Why a request to this address is refused before it is sent, or undefined. */
export function refusalOf(address: string, allowedHosts: readonly string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `${address} is not an address`;
  }
  if (url.username !== "" || url.password !== "") return `${url.origin} carries credentials in the address`;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) return `${url.origin} is not https`;
  if (!allowedHosts.includes(url.hostname)) return `the host ${url.hostname} is not among the allowed hosts (${allowedHosts.join(", ") || "none"})`;
  return undefined;
}

export class Fetcher {
  readonly #o: Required<Pick<FetcherOptions, "maxBytes" | "timeoutMs" | "minIntervalMs" | "userAgent">> & FetcherOptions;
  #last = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FetcherOptions) {
    this.#o = {
      maxBytes: DEFAULT_MAX_BYTES,
      timeoutMs: 20_000,
      minIntervalMs: 1_000,
      userAgent: "seshat-harness (research tool)",
      ...options,
    };
  }

  /** The file of the cache for an address (the sha256 of backend, method and address), or undefined without a cache. */
  #cacheFile(address: string): string | undefined {
    const c = this.#o.cache;
    return c === undefined ? undefined : join(c.dir, `${createHash("sha256").update(`${c.backend}\n${"GET"}\n${address}`).digest("hex")}.json`);
  }

  #fromCache(address: string): Answer | undefined {
    const file = this.#cacheFile(address);
    const c = this.#o.cache;
    if (file === undefined || c === undefined) return undefined;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { fetchedAt?: unknown; status?: unknown; body?: unknown };
      if (typeof stored.fetchedAt !== "string" || typeof stored.body !== "string" || typeof stored.status !== "number") return undefined;
      const age = Date.now() - Date.parse(stored.fetchedAt);
      if (!(age >= 0 && age < c.days * 86_400_000) || stored.body.length > this.#o.maxBytes) return undefined;
      return { body: stored.body, status: stored.status, cached: true };
    } catch {
      return undefined;
    }
  }

  #toCache(address: string, status: number, body: string): void {
    const file = this.#cacheFile(address);
    if (file === undefined || this.#o.cache === undefined) return;
    try {
      mkdirSync(this.#o.cache.dir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ fetchedAt: new Date().toISOString(), status, body }));
      renameSync(temporary, file);
    } catch {
      // a cache that cannot be written is no cache
    }
  }

  /** The text an address answers (a GET), bounded; throws `LitError`. */
  async text(address: string, signal?: AbortSignal): Promise<string> {
    return (await this.answer(address, signal)).body;
  }

  /** The answer to an address, from the cache when a fresh file is there, otherwise from the site (and then kept); throws `LitError`. A failure is never kept. */
  async answer(address: string, signal?: AbortSignal): Promise<Answer> {
    const refused = refusalOf(address, this.#o.allowedHosts);
    if (refused !== undefined) throw new LitError(`${refused}: no request was sent`);
    const hit = this.#fromCache(address);
    if (hit !== undefined) return hit;
    let body: string;
    try {
      body = await this.#request(address, signal);
    } catch (error) {
      const retry = this.#o.retry429Ms ?? 0;
      if (!(error instanceof LitError && error.status === 429 && retry > 0)) throw error;
      await (this.#o.sleep ?? defaultSleep)(retry);
      body = await this.#request(address, signal);
    }
    this.#toCache(address, 200, body);
    return { body, status: 200, cached: false };
  }

  async #request(address: string, signal?: AbortSignal): Promise<string> {
    const turn = this.#queue.then(async () => {
      const wait = this.#last + this.#o.minIntervalMs - Date.now();
      if (wait > 0) await (this.#o.sleep ?? defaultSleep)(wait);
      this.#last = Date.now();
    });
    this.#queue = turn.catch(() => undefined);
    await turn;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${this.#o.timeoutMs} ms`)), this.#o.timeoutMs);
    const merged = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await (this.#o.fetch ?? fetch)(address, {
          method: "GET",
          headers: { Accept: "application/json, application/atom+xml, text/plain", "User-Agent": this.#o.userAgent, ...(this.#o.headers?.() ?? {}) },
          redirect: "error",
          signal: merged,
        });
      } catch (error) {
        throw new LitError(`${address}: ${merged.aborted ? String(merged.reason instanceof Error ? merged.reason.message : merged.reason) : error instanceof Error ? error.message : String(error)}`, { unreachable: true });
      }
      if (!response.ok) {
        const busy = response.status >= 500 || response.status === 408 || response.status === 429;
        await response.body?.cancel().catch(() => undefined);
        throw new LitError(`${address}: HTTP ${response.status}`, { unreachable: busy, status: response.status });
      }
      const type = response.headers.get("content-type") ?? "";
      if (!TEXT_TYPES.test(type.trim())) {
        await response.body?.cancel().catch(() => undefined);
        throw new LitError(`${address}: the answer is of type ${JSON.stringify(type.slice(0, 60))}, not a text type`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > this.#o.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new LitError(`${address}: the answer is ${declared} bytes, over the limit of ${this.#o.maxBytes}`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader === undefined) return "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.#o.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new LitError(`${address}: the answer is over the limit of ${this.#o.maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof LitError) throw error;
        throw new LitError(`${address}: ${merged.aborted ? "no answer in time" : "the answer was cut"}`, { unreachable: true });
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    } finally {
      clearTimeout(timer);
    }
  }

  async json(address: string, signal?: AbortSignal): Promise<Json> {
    return parseJson((await this.answer(address, signal)).body, address);
  }
}

export function parseJson(text: string, address: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new LitError(`${address}: the answer is not JSON`);
  }
}
