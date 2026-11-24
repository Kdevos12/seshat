import { AUX_BEGIN, PROOF_END } from "@seshat/core";
import { extractGoalMessages, type FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { blueprintAnswer } from "./blueprint-helpers.ts";
import { proofOf } from "./m0-helpers.ts";

/**
 * The simulated Lean of the tests that lift `have` steps (plan changes DP1, DP2), on top of `blueprintAnswer`:
 * - a file whose PROOF still has a `sorry` or an `extract_goal` is a sketch of steps: each `sorry` of the file is one hole, each `extract_goal` prints the
 *   statement Mathlib would (`extractGoalMessages`), and a step `have h : T := by <tactic>` is an error unless `T` is `n * 1 = n`, which every tactic closes
 *   (so the battery closes that one step and no other);
 * - a file whose AUX region holds `✝` (an inaccessible name that an extracted statement cannot use) does not compile;
 * - any other file is what `blueprintAnswer` says (a sketch whose holes are in AUX, a hole's file, the link lemma).
 */
export function liftAnswer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  const lines = code.split("\n");
  const first = lines.findIndex((l) => l.trim() === AUX_BEGIN.trim());
  const last = lines.findIndex((l) => l.trim() === PROOF_END.trim());
  const region = lines.map((l, k) => ({ l, k })).filter(({ l, k }) => k > first && k < last && !l.includes("HARNESS"));
  const error = (k: number, text: string): FakeLeanAnswer => ({ messages: [{ severity: "error", pos: { line: k + 1, column: 0 }, text }] });
  const unreadable = region.find(({ l }) => l.includes("✝") && !l.includes("extract_goal"));
  if (unreadable !== undefined && !proof.includes("extract_goal")) return error(unreadable.k, "unexpected token '✝'; expected ')'");
  if (!/\bsorry\b/.test(proof) && !proof.includes("extract_goal") && !proof.includes("first |")) return blueprintAnswer(code);
  for (const { l, k } of region) {
    const step = /have\s+\S+\s*:\s*(.*?)\s*:=\s*by\s+(.*)$/.exec(l);
    if (step !== null && !/^(sorry|extract_goal|\(set_option pp\.)/.test(step[2] as string) && step[1] !== "n * 1 = n" && !(step[2] as string).startsWith("apply aux_")) return error(k, "the tactic failed to close the goal");
  }
  const messages = extractGoalMessages(code);
  const sorries = region.flatMap(({ l, k }) => (/(?<![\p{L}\p{N}_])sorry(?![\p{L}\p{N}_])/u.test(l) ? [{ pos: { line: k + 1, column: l.indexOf("sorry") }, goal: "n : ℕ\n⊢ a step" }] : []));
  return sorries.length === 0 ? { messages } : { messages, axioms: ["propext", "sorryAx"], sorries };
}
