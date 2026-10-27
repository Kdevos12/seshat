import type { LeanCheckOptions, LeanCheckResult, LeanChecker, LeanMessage, LeanSnippet } from "@seshat/core";
import type { Magma } from "../src/index.ts";

/** What the files of the Lean evaluator ask about: a magma, or a natural number. */
export type Instance = { kind: "magma"; magma: Magma } | { kind: "nat"; value: number };

export interface SimulatedDecideOptions {
  /** Whether the statement holds on an instance, or `undefined` for one `decide` cannot settle. */
  truth: (instance: Instance) => boolean | undefined;
  /** An error to report on the first line of every file, as a definition that does not elaborate would. */
  preambleError?: string;
  /** A file with more examples than this goes over its time limit. */
  timeoutAbove?: number;
}

const EXAMPLE = /^example : (¬ )?@m11_stmt (.*) := by decide$/u;
const MAGMA_ARGS = /^\(Fin (\d+)\) ⟨fun a b => \(\[([\d, ]*)\] : List \(Fin \d+\)\)\.getD \(a\.val \* \d+ \+ b\.val\) 0⟩$/u;

/**
 * Stands in for Lean on the files of `evaluateWithLean`: it reads the `example` lines, decides
 * each one from `truth` as `decide` would, and answers with an error at the line of each example
 * that `decide` would not prove. It checks the layout of the files (one example on one line), not
 * that real Lean accepts the syntax, which only a Lean server can say.
 */
export class SimulatedDecide implements LeanChecker {
  readonly implementation = "simulated-decide";
  readonly version = "0";
  readonly calls: LeanSnippet[] = [];
  readonly #options: SimulatedDecideOptions;

  constructor(options: SimulatedDecideOptions) {
    this.#options = options;
  }

  async check(snippets: readonly LeanSnippet[], _options?: LeanCheckOptions): Promise<LeanCheckResult[]> {
    return snippets.map((snippet) => {
      this.calls.push(snippet);
      const lines = snippet.code.split("\n");
      const messages: LeanMessage[] = [];
      if (this.#options.preambleError !== undefined) {
        messages.push({ severity: "error", pos: { line: 1, column: 0 }, text: this.#options.preambleError });
      }
      const examples = lines.filter((l) => EXAMPLE.test(l)).length;
      if (this.#options.timeoutAbove !== undefined && examples > this.#options.timeoutAbove) {
        return { id: snippet.id, status: "timeout", messages: [], sorries: [], timeMs: 1, error: "timeout" };
      }
      lines.forEach((line, k) => {
        const match = EXAMPLE.exec(line);
        if (match === null) return;
        const negated = match[1] !== undefined;
        const text = match[2] as string;
        const table = MAGMA_ARGS.exec(text);
        const instance: Instance = table !== null
          ? { kind: "magma", magma: { size: Number(table[1]), table: (table[2] as string).split(",").map((v) => Number(v.trim())) } }
          : { kind: "nat", value: Number(text) };
        const truth = this.#options.truth(instance);
        const proved = truth === undefined ? false : truth !== negated;
        if (!proved) {
          messages.push({
            severity: "error",
            pos: { line: k + 1, column: 30 },
            text: truth === undefined ? "failed to reduce to true/false" : "decide failed: the proposition is false",
          });
        }
      });
      const status = messages.some((m) => m.severity === "error") ? "lean_error" : "valid";
      return { id: snippet.id, status, messages, sorries: [], timeMs: 1 };
    });
  }
}
