import type { LeanCheckOptions, LeanCheckResult, LeanChecker, LeanSnippet } from "@seshat/core";

/** What the scripted Lean does with a tactic. */
export interface Script {
  /** Closes the goal. */
  ok?: boolean;
  /** How long the check takes. */
  delayMs?: number;
  /** The `Try this:` text it prints. */
  suggests?: string;
  /** A parse error: the tactic does not exist. */
  unknown?: boolean;
  /** Time Lean reports. */
  timeMs?: number;
  /** Goes over Lean's time limit. */
  timeout?: boolean;
}

/** The tactic of a snippet written by `snippetFor`: the lines after `:= by`. */
export function tacticOf(code: string): string {
  const at = code.indexOf(":= by\n");
  return at < 0 ? "" : code.slice(at + ":= by\n".length).split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");
}

/**
 * Stands in for Lean on the battery's files: the table says, tactic by tactic, what Lean does. A
 * check waits `delayMs` and is cut short when its signal aborts. It reads the layout of the file
 * (`example <statement> := by <tactic>`), not Lean's syntax, which only a Lean server can judge.
 */
export class ScriptedLean implements LeanChecker {
  readonly implementation = "scripted-lean";
  readonly version = "0";
  readonly calls: Array<{ id: string; code: string; tactic: string; started: number }> = [];
  inflight = 0;
  maxInflight = 0;
  readonly #table: Record<string, Script>;

  constructor(table: Record<string, Script>) {
    this.#table = table;
  }

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    return Promise.all(snippets.map((s) => this.#one(s, options)));
  }

  async #one(snippet: LeanSnippet, options: LeanCheckOptions): Promise<LeanCheckResult> {
    const tactic = tacticOf(snippet.code);
    this.calls.push({ id: snippet.id, code: snippet.code, tactic, started: Date.now() });
    const script = this.#table[tactic] ?? {};
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if ((script.delayMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, script.delayMs);
          options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (options.signal?.aborted) return { id: snippet.id, status: "server_error", messages: [], sorries: [], timeMs: 0, error: "aborted" };
      }
      const timeMs = script.timeMs ?? script.delayMs ?? 5;
      if (script.timeout === true) return { id: snippet.id, status: "timeout", messages: [], sorries: [], timeMs, error: "timeout" };
      if (script.unknown === true) {
        return { id: snippet.id, status: "lean_error", messages: [{ severity: "error", pos: { line: 4, column: 2 }, text: `unknown tactic` }], sorries: [], timeMs };
      }
      if (script.ok === true) {
        const messages = script.suggests !== undefined ? [{ severity: "info" as const, pos: { line: 4, column: 2 }, text: `Try this: ${script.suggests}` }] : [];
        return { id: snippet.id, status: "valid", messages, sorries: [], timeMs };
      }
      return { id: snippet.id, status: "lean_error", messages: [{ severity: "error", pos: { line: 4, column: 2 }, text: "unsolved goals" }], sorries: [], timeMs };
    } finally {
      this.inflight--;
    }
  }
}
