import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idSuffix, importHeader, LIB_PREFIX, lemmaText, libraryName, parseAuxRegion } from "../src/index.ts";

const REGION = `/-- Doubling is adding. -/
theorem aux_two_mul (n : ℕ) : 2 * n = n + n := by
  omega

lemma aux_add_zero (n : ℕ) : n + 0 = n := Nat.add_zero n

def aux_double (n : ℕ) : ℕ := n + n

theorem helper (n : ℕ) : n = n := rfl

theorem aux_with_hole (n : ℕ) : n = n + 0 := by
  sorry

theorem aux_uses_sibling (n : ℕ) : aux_double n = 2 * n := by
  unfold aux_double
  omega

theorem aux_bare : 1 + 1 = 2 := by
  norm_num
`;

describe("the auxiliary region", () => {
  const { lemmas, skipped } = parseAuxRegion(REGION);

  it("gives the lemmas that stand alone, with a statement in signature form and a tactic proof", () => {
    assert.deepEqual(lemmas.map((l) => l.name), ["aux_two_mul", "aux_add_zero", "aux_bare"]);
    assert.deepEqual(lemmas[0], { name: "aux_two_mul", statement: "(n : ℕ) : 2 * n = n + n", proof: "omega", doc: "Doubling is adding.", uses: [] });
    // A term proof is a tactic block: the validator's own reading.
    assert.equal(lemmas[1]?.proof, "exact Nat.add_zero n");
  });

  it("says why each other declaration is left out", () => {
    const why = Object.fromEntries(skipped.map((s) => [s.name, s.reason]));
    assert.match(why.aux_double ?? "", /a def, not a lemma/);
    assert.match(why.helper ?? "", /does not start with aux_/);
    assert.match(why.aux_with_hole ?? "", /empty or has a hole/);
    assert.match(why.aux_uses_sibling ?? "", /uses aux_double, declared beside it/);
  });

  it("reads a lemma whose statement has no binders", () => {
    const only = parseAuxRegion("theorem aux_bare : 1 + 1 = 2 := by\n  norm_num\n");
    assert.deepEqual(only.lemmas.map((l) => [l.name, l.statement, l.proof]), [["aux_bare", ": 1 + 1 = 2", "norm_num"]]);
  });

  it("skips a declaration with no proof", () => {
    const r = parseAuxRegion("theorem aux_open (n : ℕ) : n = n\n");
    assert.equal(r.lemmas.length, 0);
    assert.equal(r.skipped.length, 1);
  });
});

describe("a library lemma's name and text", () => {
  it("names a lemma after its statement id, once", () => {
    assert.equal(idSuffix("st0_9f3a1c77deadbeef"), "9f3a1c");
    assert.equal(libraryName("aux_two_mul", "st0_9f3a1c77deadbeef"), `${LIB_PREFIX}two_mul_9f3a1c`);
    // A library name given again keeps its stem, and gains the suffix a second time: callers pass the submission's name.
    assert.equal(libraryName("aux_lib_two_mul", "st0_9f3a1c77deadbeef"), `${LIB_PREFIX}two_mul_9f3a1c`);
    assert.equal(libraryName("aux_", "st0_00"), `${LIB_PREFIX}lemma_00`);
  });

  it("is a lemma a prover can paste, which reads back as the lemma it came from", () => {
    const text = lemmaText({ name: "aux_lib_two_mul_9f3a1c", statement: "(n : ℕ) : 2 * n = n + n", proof: "induction n with\n  | zero => rfl\n  | succ k ih => omega", doc: "Doubling is adding." });
    assert.equal(
      text,
      "/-- Doubling is adding. -/\ntheorem aux_lib_two_mul_9f3a1c (n : ℕ) : 2 * n = n + n := by\n  induction n with\n    | zero => rfl\n    | succ k ih => omega",
    );
    const [again] = parseAuxRegion(text).lemmas;
    assert.deepEqual([again?.name, again?.statement, again?.proof], ["aux_lib_two_mul_9f3a1c", "(n : ℕ) : 2 * n = n + n", "induction n with\n  | zero => rfl\n  | succ k ih => omega"]);
  });

  it("reads the imports of a problem's file as its header", () => {
    assert.equal(importHeader("import Mathlib\nimport Foo.Bar\n\nopen Nat\n\ntheorem t : True := trivial\n"), "import Mathlib\nimport Foo.Bar");
    assert.equal(importHeader("theorem t : True := trivial\n"), "");
  });
});
