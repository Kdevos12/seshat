import type { Json } from "@seshat/core";

/**
 * The one way the remote and pattern backends reach a service: https only, no credentials in the address, no redirect, a cap on the size of
 * the answer, a time limit. Nothing else is sent than the request the backend writes (the query), and nothing that the service says is
 * followed.
 */
export type Fetch = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 8_000;
/** The most bytes read from one answer. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

export class SearchHttpError extends Error {
  /** The service could not be reached or answered too late or too badly; the call is skipped, and the check goes on. */
  constructor(message: string) {
    super(message);
    this.name = "SearchHttpError";
  }
}

/** The address as a URL, or an error that says why a service at this address is not used. */
export function serviceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SearchHttpError(`${JSON.stringify(raw)} is not an address`);
  }
  if (url.protocol !== "https:") throw new SearchHttpError(`${url.origin} is not https: a search service is reached over https only`);
  if (url.username !== "" || url.password !== "") throw new SearchHttpError("an address with a user name or a password is refused");
  return url;
}

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** One request, and the JSON the service answered. */
export async function requestJson(url: URL, init: { body?: Json; signal?: AbortSignal }, options: HttpOptions = {}): Promise<unknown> {
  const doFetch = options.fetch ?? ((input, init2) => fetch(input, init2));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  const signal = init.signal === undefined ? timeout.signal : AbortSignal.any([init.signal, timeout.signal]);
  const why = () => (signal.reason instanceof Error ? signal.reason.message : String(signal.reason));
  try {
    let response: Response;
    try {
      response = await doFetch(url.href, {
        method: init.body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal,
      });
    } catch (error) {
      throw new SearchHttpError(`${url.origin}: ${signal.aborted ? why() : error instanceof Error ? error.message : String(error)}`);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchHttpError(`${url.origin}: a redirect (HTTP ${response.status}) is not followed`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchHttpError(`${url.origin}: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchHttpError(`${url.origin}: the answer is larger than ${maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      for (;;) {
        const next = await reader?.read();
        if (next === undefined || next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader?.cancel().catch(() => undefined);
          throw new SearchHttpError(`${url.origin}: the answer is larger than ${maxBytes} bytes`);
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof SearchHttpError) throw error;
      throw new SearchHttpError(`${url.origin}: ${signal.aborted ? why() : "the answer could not be read"}`);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new SearchHttpError(`${url.origin}: the answer is not JSON`);
    }
  } finally {
    clearTimeout(timer);
  }
}
