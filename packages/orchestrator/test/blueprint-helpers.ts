import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { extractSubmission } from "@seshat/core";
import { m12Answer } from "./m12-helpers.ts";
import { proofOf } from "./m0-helpers.ts";

/** A blueprint: three holes, `aux_right` declares that it may use `aux_left`, and the main proof names `aux_right` and `aux_third`. */
export const BP_AUX = `lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry

-- uses: aux_left
lemma aux_right (n : ℕ) : n + 0 = 0 + n := by
  sorry

lemma aux_third (n : ℕ) : n * 1 = n := by
  sorry`;

export const BP_PROOF = "exact main_ok aux_right aux_third";

const error = (text: string): FakeLeanAnswer => ({ messages: [{ severity: "error", pos: { line: 1, column: 0 }, text }] });

/**
 * The simulated Lean of the blueprint tests, on top of `m12Answer`: a proof with `hole_ok` proves a hole; `dep_ok` is a proof that
 * uses a dependency (`aux_left`), so it checks only when the dependency is in the file, as a stub (`sorry`) or as a proof; `neg_ok` proves
 * a negation. A file whose only `sorry` lie in stubs is accepted with warnings. A link lemma (`h_aux_1`) of a hole that uses a dependency holds when
 * its proof uses `dep_ok`.
 */
export function blueprintAnswer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  if (proof.includes("h_aux_1") && proof.includes("dep_ok")) return {};
  if (proof.includes("neg_ok")) return code.includes("¬") ? {} : error("type mismatch: the negation is not stated");
  if (proof.includes("dep_ok")) {
    const { aux } = extractSubmission(code);
    if (!aux.includes("lemma aux_left")) return error("unknown identifier 'aux_left'");
    return aux.includes("sorry") ? { axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: 1, column: 2 }, goal: "n : ℕ\n⊢ stub" }] } : {};
  }
  return m12Answer(code);
}
