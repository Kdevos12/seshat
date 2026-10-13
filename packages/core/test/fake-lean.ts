import type { LeanChecker, LeanCheckResult, LeanMessage, LeanSnippet, LeanSorry } from "../src/index.ts";

export interface FakeLeanAnswer {
  /** Axioms printed by `#print axioms`; null prints nothing. */
  axioms?: string[] | null;
  /** Type printed by `#check`; null prints nothing. */
  type?: string | null;
  messages?: LeanMessage[];
  sorries?: LeanSorry[];
  error?: { status: "timeout" | "server_error" | "repl_error"; message: string };
}

/**
 * Stands in for a Lean REPL: answers the harness's check commands at the lines where Lean would,
 * with what the test decides. Records every snippet it receives.
 */
export class FakeChecker implements LeanChecker {
  readonly implementation = "fake-lean";
  readonly version = "0";
  readonly calls: LeanSnippet[] = [];
  private readonly answer: (code: string) => FakeLeanAnswer;

  constructor(answer: (code: string) => FakeLeanAnswer = () => ({})) {
    this.answer = answer;
  }

  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    return snippets.map((snippet) => {
      this.calls.push(snippet);
      const answer = this.answer(snippet.code);
      if (answer.error) {
        return { id: snippet.id, status: answer.error.status, messages: [], sorries: [], timeMs: 1, error: answer.error.message };
      }
      const lines = snippet.code.split("\n");
      const axiomsLine = lines.findLastIndex((l) => l.startsWith("#print axioms ")) + 1;
      const checkLine = lines.findLastIndex((l) => l.startsWith("#check @")) + 1;
      const name = (lines[axiomsLine - 1] ?? "").slice("#print axioms ".length).trim();
      const messages: LeanMessage[] = [...(answer.messages ?? [])];
      const axioms = answer.axioms === undefined ? ["propext", "Classical.choice", "Quot.sound"] : answer.axioms;
      if (axioms !== null && axiomsLine > 0) {
        const text = axioms.length === 0 ? `'${name}' does not depend on any axioms` : `'${name}' depends on axioms: [${axioms.join(", ")}]`;
        messages.push({ severity: "info", pos: { line: axiomsLine, column: 0 }, text });
      }
      const type = answer.type === undefined ? "T" : answer.type;
      if (type !== null && checkLine > 0) messages.push({ severity: "info", pos: { line: checkLine, column: 0 }, text: `@${name} : ${type}` });
      const sorries = answer.sorries ?? [];
      const status = messages.some((m) => m.severity === "error") ? "lean_error" : sorries.length > 0 ? "sorry" : "valid";
      return { id: snippet.id, status, messages, sorries, timeMs: 1 };
    });
  }
}
