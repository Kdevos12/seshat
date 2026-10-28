import { extractSubmission } from "@seshat/core";
import { toyAnswer } from "../../graph/test/helpers.ts";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { proofOf } from "./m0-helpers.ts";

/** The sketch the outer prover submits: two named holes, and a main proof that the simulated Lean accepts once they are given. */
export const AUX = `lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry

lemma aux_right (n : ℕ) : n + 0 = 0 + n := by
  sorry`;

export const SKETCH_PROOF = "exact main_ok";

/**
 * The simulated Lean of the M12 tests. A reference checks. A sketch whose aux has `sorry` and whose main proof is `main_ok`
 * checks with only those holes open. The link lemma of the decomposition (its proof introduces the holes as `h_aux_k`) is
 * accepted when it ends with the sketch's main proof. `hole_ok` proves a hole. A composed proof is what `toyAnswer` says.
 */
export function m12Answer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  if (code.includes("aux_m2_")) return toyAnswer(code);
  if (proof.includes("h_aux_1")) return proof.includes("main_ok") ? {} : { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "unsolved goals" }] };
  const { aux } = extractSubmission(code);
  if (aux.includes("sorry") && proof.includes("main_ok")) {
    return { axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: 1, column: 2 }, goal: "n : ℕ\n⊢ 0 + n = n" }] };
  }
  if (proof.includes("hole_ok")) return {};
  return toyAnswer(code);
}
