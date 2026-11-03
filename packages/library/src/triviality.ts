import type { ProblemContext } from "@seshat/lines";

/** The answer of a non-triviality test. */
export interface TrivialityVerdict {
  trivial: boolean;
  /** The cheapest tactic that closed it, when it is trivial. */
  by?: string;
}

/** What a test is asked about: a lemma's statement under the imports it stands on. */
export interface TrivialityQuestion {
  statement: string;
  /** `import X` lines. */
  header: string;
}

/**
 * Whether the battery's cheapest automation closes a statement (plan Task 9: a library lemma must be
 * non-trivial). It is injected: the default is `cheapTacticTest`; Task 6's battery plugs in here once it
 * is merged (documentation/library.md, "The non-triviality test"). A test that cannot tell (Lean did not
 * answer) rejects, and the candidate stays pending.
 */
export type TrivialityTest = (question: TrivialityQuestion, problem: ProblemContext) => Promise<TrivialityVerdict>;

/** The default tactics, cheapest first. */
export const CHEAP_TACTICS: readonly string[] = ["rfl", "trivial", "decide", "simp", "omega", "norm_num", "ring", "linarith", "positivity"];

interface CheckOutput {
  results: Array<{ id: string; status: string }>;
}

/**
 * The default test: one `lean.check` call (through the registry, as `line:M3`) with the statement closed by
 * each of the cheap tactics in a file of its own; the lemma is trivial when any of them is `valid`. The
 * check has a short time limit, since a tactic that needs long is not cheap. A call whose files all came
 * back as a server or REPL error says nothing, and the test rejects.
 */
export function cheapTacticTest(options: { tactics?: readonly string[]; timeoutSec?: number } = {}): TrivialityTest {
  const tactics = options.tactics ?? CHEAP_TACTICS;
  return async (question, problem) => {
    const snippets = tactics.map((tactic, i) => ({
      id: `triv:${i}`,
      code: `${question.header}\n\ntheorem seshat_triviality ${question.statement} := by\n  ${tactic}\n`,
    }));
    const { output } = await problem.registry.invoke(
      "lean.check",
      { snippets, timeoutSec: options.timeoutSec ?? 10 },
      { actor: `line:${problem.line}`, ...(problem.signal !== undefined ? { signal: problem.signal } : {}) },
    );
    const results = (output as unknown as CheckOutput).results;
    const closed = results.findIndex((r) => r.status === "valid");
    if (closed >= 0) return { trivial: true, by: tactics[Number(results[closed]?.id.split(":")[1])] ?? tactics[closed] ?? "?" };
    if (results.every((r) => r.status === "repl_error" || r.status === "server_error")) throw new Error("Lean did not answer the triviality check");
    return { trivial: false };
  };
}
