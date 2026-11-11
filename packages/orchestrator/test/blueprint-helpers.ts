import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { extractSubmission } from "@seshat/core";
import { toyAnswer } from "../../graph/test/helpers.ts";
import { m12Answer } from "./m12-helpers.ts";
import { proofOf } from "./m0-helpers.ts";

/**
 * A blueprint: three holes. `aux_right` declares that it may use `aux_left`, and it comes first, so that its work is done before its
 * dependency is proved. `aux_third` is closed by the battery (the simulated Lean accepts any proof of it). The main proof names `aux_right` and `aux_third`.
 */
export const BP_AUX = `-- uses: aux_left
lemma aux_right (n : ℕ) : n + 0 = 0 + n := by
  sorry

lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry

lemma aux_third (n : ℕ) : n * 1 = n := by
  sorry`;

export const BP_PROOF = "exact main_ok aux_right aux_third";

/** The stub of `aux_left`, as a hole session is told to start with it. */
export const LEFT_STUB = `lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry`;

/** A hole that is false: its negation is proved by `neg_ok`, and by nothing the battery tries. */
export const WRONG_AUX = `lemma aux_wrong (n : ℕ) : n + 0 = n + 1 := by
  sorry`;

/** A hole that nothing proves: its sessions end too hard. */
export const HARD_AUX = `lemma aux_hard (n : ℕ) : n + 2 = 2 + n := by
  sorry`;

const error = (text: string): FakeLeanAnswer => ({ messages: [{ severity: "error", pos: { line: 1, column: 0 }, text }] });

/**
 * The simulated Lean of the blueprint tests, on top of `m12Answer`:
 * - `hole_ok` proves a hole; `dep_ok` is a proof that uses `aux_left`, so it checks only when `aux_left` is in the file (a stub with `sorry`
 *   is a warning, a proof a pass); the link lemma of a hole that uses it (`h_aux_1`) holds when its proof uses `dep_ok`;
 * - `neg_ok` proves a negation (a file that states one);
 * - any proof of `n * 1 = n` is accepted (the battery closes it), and any proof of the negation of `n + 0 = n + 1`... is not (only `neg_ok`).
 */
export function blueprintAnswer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  if (code.includes("aux_m2_")) return toyAnswer(code);
  if (proof.includes("h_aux_1") && proof.includes("dep_ok")) return {};
  if (proof.includes("neg_ok")) return code.includes("¬") ? {} : error("type mismatch: the negation is not stated");
  if (proof.includes("dep_ok")) {
    const { aux } = extractSubmission(code);
    if (!aux.includes("lemma aux_left")) return error("unknown identifier 'aux_left'");
    return aux.includes("sorry") ? { axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: 1, column: 2 }, goal: "n : ℕ\n⊢ stub" }] } : {};
  }
  if (!proof.includes("sorry") && !proof.includes("main_ok") && code.includes("n * 1 = n") && !code.includes("h_aux_1")) return {};
  return m12Answer(code);
}
