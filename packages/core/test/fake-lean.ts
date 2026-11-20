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

/**
 * Mathlib's `extract_goal`, simulated for the tests that lift `have` steps (plan change DP1): the info messages Lean prints for the `extract_goal` of a
 * file, one for each, in file order, at its line, in the form Lean 4.27's Mathlib prints (`theorem _example.extracted_1 ... := sorry`, read on a real Lean on
 * 2026-11-20). The statement is the one the real tactic would print for a step `have h : T := by extract_goal; sorry`:
 * the binders of the first `theorem`, the earlier `have`s of the proof, the names introduced by `intro` and by a case `| ctor a b =>`, each of type `ℕ`
 * (all the simulation knows), then `T`. An `intro _` introduces an inaccessible name (`x✝`), which the real tactic prints too and no later check reads.
 * It is a script of what Lean answers, not a model of Lean: what it does not read stays out of the context.
 */
export function extractGoalMessages(code: string): LeanMessage[] {
  const lines = code.split("\n");
  const head = lines.findIndex((l) => /^\s*theorem\s/.test(l));
  const binders: string[] = [];
  if (head >= 0) {
    const text = (lines[head] as string).replace(/^\s*theorem\s+\S+\s*/, "");
    let depth = 0;
    let group = "";
    for (const c of text) {
      if ("([{⟨".includes(c)) depth++;
      if (depth > 0) group += c;
      else if (c === ":") break;
      if (")]}⟩".includes(c) && --depth === 0) {
        binders.push(group);
        group = "";
      }
    }
  }
  const context: string[] = [...binders];
  const messages: LeanMessage[] = [];
  let count = 0;
  lines.forEach((line, k) => {
    if (k <= head) return;
    const intro = /^\s*intro\s+(.+)$/.exec(line);
    if (intro !== null) for (const x of (intro[1] as string).split(/\s+/)) context.push(`(${x === "_" ? "x✝" : x} : ℕ)`);
    const branch = /^\s*\|\s*\S+\s+([^=]*)=>/.exec(line);
    if (branch !== null) for (const x of (branch[1] as string).trim().split(/\s+/).filter((w) => w !== "")) context.push(`(${x} : ℕ)`);
    const step = /have\s+(\S+)\s*:\s*(.*?)\s*:=/.exec(line);
    if (step !== null && line.includes("extract_goal")) {
      count += 1;
      messages.push({ severity: "info", pos: { line: k + 1, column: line.indexOf("extract_goal") }, text: `theorem _example.extracted_${count} ${context.join(" ")} : ${step[2]} := sorry`.replace(/ {2}:/, " :") });
    }
    if (step !== null) context.push(`(${step[1]} : ${step[2]})`);
  });
  return messages;
}
