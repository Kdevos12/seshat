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

/**
 * What the transport says when it lost the response: undici's `terminated` (the body's stream cut) and `fetch
 * failed`, Node's socket errors, the OpenAI SDK's `Connection error.` and `Request timed out.`, a stream that
 * closed before its last event. Matched at the start of the message or as a whole word, never as any text that
 * says "timed out": an error of the harness or of a test's model that happens to say so is not the network's.
 */
const TRANSPORT =
  /^(terminated|fetch failed|socket hang up|other side closed|premature close|connection error\b|request timed out\b|network error\b|stream ended (without|before)\b)|\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/i;

/** What a provider says mid-stream when it is busy, without a status. */
const BUSY = /^(overloaded|server_busy|the server is (currently )?(busy|overloaded))\b/i;

/** The status the error starts with, as pi-ai writes a provider's HTTP error: `503 ...`, `503: ...` or `Provider (503): ...`. */
const STATUS = /^\s*(?:[\w .-]+ \()?(\d{3})\)?[\s:]/;

/**
 * Whether a failed response was lost by the transport or the server, so that the same request can be sent again:
 * the body stream cut (undici's `terminated`), a reset or refused connection, `fetch failed`, a 5xx, a 429, a 408.
 * Every other error is the request's or the harness's and is not sent again: a 4xx (a bad request, a refused key,
 * a balance too low), a context too long, a quota or billing limit even with a 429, an error that only mentions a
 * timeout or a status, and an abort. pi-ai's classifier (`isRetryableAssistantError`) is too wide to decide alone,
 * since it matches "timeout" or "500" anywhere in the text; it serves here to refuse the quota and billing limits.
 */
export function isTransient(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return false;
  const text = message.errorMessage;
  if (isContextOverflow(message)) return false;
  const status = STATUS.exec(text)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    if (code === 408) return true;
    return (code === 429 || (code >= 500 && code < 600)) && isRetryableAssistantError(message);
  }
  return TRANSPORT.test(text) || BUSY.test(text);
}

export interface RetryingStreamOptions {
  /** Sends the request: the same model, context and options each time, so that the provider's prompt cache still answers. */
  send: () => AssistantMessageEventStream;
  policy: RetryPolicy;
  /** The request's signal: an abort ends the wait at once. */
  signal: AbortSignal | undefined;
  /**
   * Whether the cut response's request may still be sent: asked before the wait, during it (every
   * `POLL_MS`) and after it, so that a stop, the end of a turn or a spent budget ends the wait at once.
   */
  mayResend: (cut: AssistantMessage) => boolean;
  /** Told of a cut response whose request is sent again, immediately before the send: the caller charges it. */
  resend: (cut: AssistantMessage, retry: RequestRetry) => void;
}

/** How often the wait asks `mayResend` again. */
const POLL_MS = 100;

/**
 * The stream of a request that is sent again, with the same context, when a transient error cuts its response
 * ([isTransient]). The events of the sends follow each other as one response: `start` once, then the content of
 * each send, which replaces the partial message of the one before it, and the last send's `done` or `error`. A
 * cut response whose request is not sent again (not transient, no retry left, or `mayResend` said no before the
 * send) ends the stream as it came, to be charged as any answer; its error says how many times the request was sent.
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
        cut = fallback(error);
      }
      // A stream that ended with no answer is answered as a failure, so that the session ends instead of waiting.
      cut ??= fallback(new Error("the response stream ended without an answer"));
      const delayMs = Math.min(o.policy.baseDelayMs * 2 ** (retry - 1), o.policy.maxDelayMs);
      const again =
        retry <= o.policy.retries &&
        isTransient(cut) &&
        o.mayResend(cut) &&
        (await wait(delayMs, o.signal, () => o.mayResend(cut))) &&
        o.mayResend(cut);
      if (!again) {
        const final: AssistantMessage = retry > 1 && cut.stopReason === "error"
          ? { ...cut, errorMessage: `${cut.errorMessage ?? "the request failed"} (the request was sent ${retry} times)` }
          : cut;
        out.push({ type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final });
        out.end(final);
        return;
      }
      o.resend(cut, { retry, error: (cut.errorMessage ?? "").slice(0, 1000), delayMs });
    }
  })();
  return out;
}

/** Waits `ms`; answers false at once when the signal is aborted or `keep` turns false. */
function wait(ms: number, signal: AbortSignal | undefined, keep: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const finish = (value: boolean) => {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    const poll = setInterval(() => {
      if (!keep()) finish(false);
    }, POLL_MS);
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
