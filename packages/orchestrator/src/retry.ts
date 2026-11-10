import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

/**
 * How a session's request is sent again after a transient error (documentation/m0-loop.md, "Transient errors"):
 * at most `retries` more times, after `baseDelayMs`, then twice as long each time, never more than `maxDelayMs`.
 * `retries: 0` sends each request once.
 */
export interface RetryPolicy {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Three more sends, after 2, 4 and 8 seconds. */
export const REQUEST_RETRY: RetryPolicy = { retries: 3, baseDelayMs: 2_000, maxDelayMs: 30_000 };

/** One send again of a request: its number (1 for the first), what cut the response before it, and the wait before it. */
export interface RequestRetry {
  retry: number;
  error: string;
  delayMs: number;
}

/** Node's socket errors, which pi-ai's classifier does not name: a reset, refused or unreachable connection, a broken pipe. */
const SOCKET_ERRORS = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)\b/;

/** HTTP statuses of a client error that a later send can cure: a timeout, a conflict, too many requests. */
const TRANSIENT_4XX = new Set([408, 409, 429]);

/**
 * Whether a failed response was cut by the transport or the server, not refused for its request: the body stream
 * cut (undici's `terminated`), a reset or refused connection, `fetch failed`, a 5xx, a 429. A 4xx other than 408, 409 and
 * 429 (a bad request, a refused key), a context too long, and a quota or billing limit are not transient. The
 * classifier is pi-ai's (`isRetryableAssistantError`), with the request's own errors taken out first: its
 * patterns match a status anywhere in the text, and a 400 that quotes a number such as 75000 would match `500`.
 */
export function isTransient(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return false;
  const status = /^\s*(\d{3})\b/.exec(message.errorMessage)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    if (code >= 400 && code < 500 && !TRANSIENT_4XX.has(code)) return false;
  }
  if (isContextOverflow(message)) return false;
  return isRetryableAssistantError(message) || SOCKET_ERRORS.test(message.errorMessage);
}

export interface RetryingStreamOptions {
  /** Sends the request: the same model, context and options each time, so that the provider's prompt cache still answers. */
  send: () => AssistantMessageEventStream;
  policy: RetryPolicy;
  /** The request's signal: an abort during a wait ends the stream as aborted. */
  signal: AbortSignal | undefined;
  /**
   * Asked of a response a transient error cut, before it is sent again: true sends it again, and the caller has
   * charged the cut response; false keeps the cut response as the answer, charged as any answer is.
   */
  retry: (cut: AssistantMessage, retry: RequestRetry) => boolean;
  /** Told of the message that ends the stream when the wait before a send is aborted: it is no response, and has no cost. */
  abandoned: (message: AssistantMessage) => void;
}

/**
 * The stream of a request that is sent again, with the same context, when a transient error cuts its response
 * ([isTransient]). The events of the sends follow each other as one response: `start` once, then the content of
 * each send, which replaces the partial message of the one before it, and the last send's `done` or `error`. A
 * cut response that is not sent again ends the stream, its error saying how many times the request was sent.
 */
export function retryingStream(o: RetryingStreamOptions): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let started = false;
    for (let retry = 1; ; retry += 1) {
      let cut: AssistantMessage | undefined;
      try {
        for await (const event of o.send()) {
          if (event.type === "start") {
            if (!started) out.push(event);
            started = true;
          } else if (event.type === "error") {
            cut = event.error;
            break;
          } else if (event.type === "done") {
            out.push(event);
            out.end(event.message);
            return;
          } else {
            out.push(event);
          }
        }
      } catch (error) {
        // pi-ai's streams end with an error event rather than throwing; a stream that throws is answered as one.
        out.push({ type: "error", reason: "error", error: fallback(error) });
        out.end();
        return;
      }
      // A stream that ended with no answer is answered as a failure of the request, so that the session ends instead of waiting.
      cut ??= fallback(new Error("the response stream ended without an answer"));
      const delayMs = Math.min(o.policy.baseDelayMs * 2 ** (retry - 1), o.policy.maxDelayMs);
      const again =
        retry <= o.policy.retries &&
        o.signal?.aborted !== true &&
        isTransient(cut) &&
        o.retry(cut, { retry, error: (cut.errorMessage ?? "").slice(0, 1000), delayMs });
      if (!again) {
        const final: AssistantMessage = retry > 1 && cut.stopReason === "error"
          ? { ...cut, errorMessage: `${cut.errorMessage ?? "the request failed"} (the request was sent ${retry} times)` }
          : cut;
        out.push({ type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final });
        out.end(final);
        return;
      }
      if (!(await sleep(delayMs, o.signal))) {
        const { errorMessage: _cut, ...rest } = cut;
        const aborted: AssistantMessage = {
          ...rest,
          content: [],
          stopReason: "aborted",
          errorMessage: "aborted while waiting to send the request again",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        o.abandoned(aborted);
        out.push({ type: "error", reason: "aborted", error: aborted });
        out.end(aborted);
        return;
      }
    }
  })();
  return out;
}

/** Waits, or answers false at once when the signal is aborted. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fallback(error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
