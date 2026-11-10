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

  constructor(message: string, options: { unreachable?: boolean } = {}) {
    super(message);
    this.name = "LitError";
    this.unreachable = options.unreachable ?? false;
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
}

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

  /** The text an address answers (a GET), bounded; throws `LitError`. */
  async text(address: string, signal?: AbortSignal): Promise<string> {
    const refused = refusalOf(address, this.#o.allowedHosts);
    if (refused !== undefined) throw new LitError(`${refused}: no request was sent`);
    const turn = this.#queue.then(async () => {
      const wait = this.#last + this.#o.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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
          headers: { Accept: "application/json, application/atom+xml, text/plain", "User-Agent": this.#o.userAgent },
          redirect: "error",
          signal: merged,
        });
      } catch (error) {
        throw new LitError(`${address}: ${merged.aborted ? String(merged.reason instanceof Error ? merged.reason.message : merged.reason) : error instanceof Error ? error.message : String(error)}`, { unreachable: true });
      }
      if (!response.ok) {
        const busy = response.status >= 500 || response.status === 408 || response.status === 429;
        await response.body?.cancel().catch(() => undefined);
        throw new LitError(`${address}: HTTP ${response.status}`, { unreachable: busy });
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
    const text = await this.text(address, signal);
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new LitError(`${address}: the answer is not JSON`);
    }
  }
}
