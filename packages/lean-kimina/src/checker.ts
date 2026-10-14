import type {
  LeanChecker,
  LeanCheckOptions,
  LeanCheckResult,
  LeanCheckStatus,
  LeanMessage,
  LeanPosition,
  LeanSnippet,
  LeanSorry,
} from "@seshat/core";

/**
 * Wire format of Kimina Lean Server 2.x (`POST /api/check`), from its source
 * (project-numina/kimina-lean-server, server/routers/check.py and kimina_client/models.py).
 *
 * The server cuts each snippet into a header (the leading `import` and blank lines) and a body. It
 * keeps one REPL per header, so the imports are paid once, and shifts the body's positions back, so
 * lines in the answer are lines of the snippet as sent.
 */
interface WirePos {
  line: number;
  column: number;
}

interface WireMessage {
  severity: "trace" | "info" | "warning" | "error";
  pos: WirePos;
  endPos?: WirePos | null;
  data: string;
}

interface WireSorry {
  pos: WirePos;
  endPos?: WirePos | null;
  goal: string;
}

interface WireResult {
  id: string;
  time?: number;
  error?: string | null;
  response?: { messages?: WireMessage[] | null; sorries?: WireSorry[] | null } | { message: string } | null;
}

export interface KiminaOptions {
  /** Default: `LEAN_SERVER_API_URL`, then `http://localhost:8000`. */
  url?: string;
  /** Default: `LEAN_SERVER_API_KEY`. Sent as `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Lean seconds per snippet when the caller does not say. Default 60. */
  timeoutSec?: number;
  /** Extra time on top of the Lean timeout before the HTTP request is abandoned. Default 30 s. */
  httpSlackMs?: number;
  /** Retries after a network failure, a 429 (no free REPL) or a 5xx. Default 3. */
  retries?: number;
  /** Recorded in every ToolRun, e.g. `2.0.0+lean-v4.33.1`. */
  version?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class KiminaChecker implements LeanChecker {
  readonly implementation = "kimina-lean-server";
  readonly version: string;
  readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutSec: number;
  private readonly httpSlackMs: number;
  private readonly retries: number;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: KiminaOptions = {}) {
    this.url = (options.url ?? process.env.LEAN_SERVER_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.LEAN_SERVER_API_KEY;
    this.timeoutSec = options.timeoutSec ?? 60;
    this.httpSlackMs = options.httpSlackMs ?? 30_000;
    this.retries = options.retries ?? 3;
    this.version = options.version ?? "2.x";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetch(`${this.url}/health`, { headers: this.headers(), ...(signal ? { signal } : {}) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * One result per snippet, in order. A failure of the server or of the network is a result with
   * status `server_error` (or `timeout`), never an exception: the caller decides whether to retry.
   */
  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    if (snippets.length === 0) return [];
    if (new Set(snippets.map((s) => s.id)).size !== snippets.length) throw new Error("snippet ids must be unique");
    const timeoutSec = Math.max(1, Math.ceil(options.timeoutSec ?? this.timeoutSec));
    const body = JSON.stringify({
      snippets: snippets.map(({ id, code }) => ({ id, code })),
      timeout: timeoutSec,
      debug: false,
      reuse: true,
    });
    const started = Date.now();
    let failure = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1));
      if (options.signal?.aborted) return snippets.map((s) => failed(s.id, "server_error", "aborted", Date.now() - started));
      const signals = [AbortSignal.timeout(timeoutSec * 1000 + this.httpSlackMs)];
      if (options.signal) signals.push(options.signal);
      let response: Response;
      try {
        response = await this.fetch(`${this.url}/api/check`, {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        failure = `request failed: ${(error as Error).message}`;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        failure = `HTTP ${response.status}: ${await safeText(response)}`;
        continue;
      }
      if (!response.ok) {
        const text = `HTTP ${response.status}: ${await safeText(response)}`;
        return snippets.map((s) => failed(s.id, "server_error", text, Date.now() - started));
      }
      let payload: { results?: WireResult[] };
      try {
        payload = (await response.json()) as { results?: WireResult[] };
      } catch (error) {
        failure = `invalid JSON: ${(error as Error).message}`;
        continue;
      }
      const byId = new Map((payload.results ?? []).map((r) => [r.id, r]));
      return snippets.map((s) => {
        const raw = byId.get(s.id);
        return raw ? toResult(raw) : failed(s.id, "server_error", "no result for this snippet", Date.now() - started);
      });
    }
    return snippets.map((s) => failed(s.id, "server_error", failure, Date.now() - started));
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function failed(id: string, status: LeanCheckStatus, error: string, timeMs: number): LeanCheckResult {
  return { id, status, messages: [], sorries: [], timeMs, error };
}

function position(pos: WirePos): LeanPosition {
  return { line: pos.line, column: pos.column };
}

/** Same classification as `ReplResponse.analyze()` in kimina-client. */
export function toResult(raw: WireResult): LeanCheckResult {
  const timeMs = Math.round((raw.time ?? 0) * 1000);
  if (raw.error) return failed(raw.id, /timed out/.test(raw.error) ? "timeout" : "server_error", raw.error, timeMs);
  const response = raw.response;
  if (!response) return failed(raw.id, "server_error", "neither a response nor an error", timeMs);
  if ("message" in response) return failed(raw.id, "repl_error", response.message, timeMs);
  const messages: LeanMessage[] = (response.messages ?? []).map((m) => ({
    severity: m.severity,
    pos: position(m.pos),
    ...(m.endPos ? { endPos: position(m.endPos) } : {}),
    text: m.data,
  }));
  const sorries: LeanSorry[] = (response.sorries ?? []).map((s) => ({
    pos: position(s.pos),
    ...(s.endPos ? { endPos: position(s.endPos) } : {}),
    goal: s.goal,
  }));
  const status: LeanCheckStatus = messages.some((m) => m.severity === "error")
    ? "lean_error"
    : sorries.length > 0
      ? "sorry"
      : "valid";
  return { id: raw.id, status, messages, sorries, timeMs };
}
