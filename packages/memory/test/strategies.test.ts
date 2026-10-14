import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStrategy, isStrategy, premisesOf, STRATEGIES, type Strategy } from "../src/index.ts";

/** [the proof, the label, the aux region when there is one]. */
const CASES: Array<[string, Strategy, string?]> = [
  // Induction wins over whatever closes its cases.
  ["induction n with\n| zero => simp\n| succ n ih => omega", "induction"],
  ["intro n\ninduction' n with n ih\n· simp\n· rw [ih]; ring", "induction"],
  ["exact Nat.le_induction (by simp) (fun n _ ih => by omega) n hn", "induction"],
  ["exact Nat.strong_induction_on n fun n ih => by omega", "induction"],
  ["exact aux_sum n", "induction", "theorem aux_sum (n : ℕ) : n + 0 = n := by\n  match n with\n  | 0 => rfl\n  | n + 1 => by simpa using aux_sum n"],
  // Extremal principles and pigeonhole.
  ["obtain ⟨m, hm⟩ := Nat.find_spec h\nexact Nat.find_min h hm", "extremal"],
  ["exact Finset.exists_ne_map_eq_of_card_lt_of_maps_to hc hf", "extremal"],
  ["have := Finset.exists_max_image s f hs\nomega", "extremal"],
  // A negation settled by a witness.
  ["push_neg\nuse 3\ndecide", "counterexample"],
  ["exact not_forall.mpr ⟨3, by decide⟩", "counterexample"],
  // Contradiction, cases.
  ["by_contra h\npush_neg at h\nomega", "contradiction"],
  ["exfalso\nlinarith", "contradiction"],
  ["rcases h with h | h\n· simp [h]\n· omega", "cases"],
  ["by_cases h : n = 0\n· simp [h]\n· omega", "cases"],
  ["interval_cases n <;> simp", "cases"],
  ["match n with\n| 0 => rfl\n| _ + 1 => rfl", "cases"],
  ["obtain h | h := Nat.lt_or_ge n 3\n· omega\n· omega", "cases"],
  // Generalization, construction.
  ["generalize n + 0 = m\nsimp", "generalization"],
  ["revert h\nsimp", "generalization"],
  ["use 3\nnorm_num", "construction"],
  ["exact ⟨3, by norm_num⟩", "construction"],
  ["refine ⟨2, ?_⟩\nomega", "construction"],
  // Bounds, algebra, rewriting.
  ["nlinarith [sq_nonneg (a - b), sq_nonneg (a + b)]", "bounds"],
  ["positivity", "bounds"],
  ["exact Nat.le_of_lt_succ h", "bounds"],
  ["calc a ≤ b := h1\n  _ ≤ c := h2", "bounds"],
  ["ring", "algebra"],
  ["field_simp\nring", "algebra"],
  ["linear_combination 2 * h", "algebra"],
  ["calc a = b := h1\n  _ = c := h2", "algebra"],
  ["rw [Nat.add_zero]", "rewriting"],
  ["simp only [Nat.add_zero]", "rewriting"],
  ["exact Nat.add_zero n", "rewriting"],
  ["unfold f\nsimp", "rewriting"],
  // Computation, automation.
  ["decide", "computation"],
  ["norm_num", "computation"],
  ["norm_num [Nat.factorial]", "computation"],
  ["rfl", "computation"],
  ["omega", "automation"],
  ["simp", "automation"],
  ["intro n\nsimp\nomega", "automation"],
  ["aesop", "automation"],
  ["exact?", "automation"],
  ["linarith", "automation"],
  // Nothing recognizable.
  ["exact h", "other"],
  ["intro x\nexact x", "other"],
  ["sorry", "other"],
];

describe("classifyStrategy", () => {
  it("gives each proof the label of the technique that shapes it", () => {
    for (const [proof, label, aux] of CASES) {
      assert.equal(classifyStrategy({ proof, ...(aux !== undefined ? { aux } : {}) }), label, JSON.stringify(proof));
    }
  });

  it("covers every label of the vocabulary", () => {
    assert.deepEqual([...new Set(CASES.map(([, label]) => label))].sort(), [...STRATEGIES].sort());
  });

  it("does not read comments, and is deterministic", () => {
    const commented = "-- by_cases and induction are not used here\n/- rcases h with h | h -/\nomega";
    assert.equal(classifyStrategy({ proof: commented }), "automation");
    assert.equal(classifyStrategy({ proof: commented }), classifyStrategy({ proof: commented }));
  });

  it("reads the auxiliary lemmas with the proof", () => {
    const aux = "theorem aux_step (n : ℕ) : n + 0 = n := by\n  induction n with\n  | zero => rfl\n  | succ n ih => omega";
    assert.equal(classifyStrategy({ proof: "exact aux_step n", aux }), "induction");
  });

  it("knows the labels", () => {
    assert.ok(STRATEGIES.every(isStrategy));
    assert.equal(isStrategy("simp"), false);
  });
});

describe("premisesOf", () => {
  it("lists the lemmas a proof names, once, in order", () => {
    assert.deepEqual(premisesOf({ proof: "rw [Nat.add_comm, mul_comm]\nexact add_pos ha hb\nrw [Nat.add_comm]" }), [
      "Nat.add_comm",
      "mul_comm",
      "add_pos",
    ]);
    assert.deepEqual(premisesOf({ proof: "simpa using (add_comm a b).symm" }), ["add_comm"]);
  });

  it("leaves out hypotheses, tactics and the prover's own lemmas", () => {
    assert.deepEqual(premisesOf({ proof: "have h_pos : 0 < n := by omega\nexact mul_pos h_pos h_pos" }), ["mul_pos"]);
    assert.deepEqual(premisesOf({ proof: "norm_num [Nat.succ_le_iff]\npush_neg at h\nexact h.symm" }), ["Nat.succ_le_iff"]);
    assert.deepEqual(premisesOf({ proof: "exact aux_main n", aux: "theorem aux_main (n : ℕ) : n = n := rfl" }), []);
    assert.deepEqual(premisesOf({ proof: "intro n hn\nobtain ⟨k, hk_eq⟩ := h n\nomega" }), []);
  });
});
