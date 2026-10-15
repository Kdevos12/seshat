import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applied, closedProp, linkFor, linkStatement, negationStatement, paren, parseSignature, variantEdge, VARIANT_RELATIONS } from "../src/index.ts";

describe("statements in signature form", () => {
  it("are cut at the first colon outside brackets, with the explicit binders named", () => {
    const sig = parseSignature("(n : ℕ) : n + 0 = n");
    assert.deepEqual([sig.binders, sig.type, sig.args], ["(n : ℕ)", "n + 0 = n", ["n"]]);

    const rich = parseSignature("{α : Type*} [Group α] (a b : α) (h : ∀ x : α, x * 1 = x) :  a * b = b * a  -- commutes");
    assert.deepEqual(rich.args, ["a", "b", "h"]);
    assert.equal(rich.binders, "{α : Type*} [Group α] (a b : α) (h : ∀ x : α, x * 1 = x)");
    assert.equal(rich.type, "a * b = b * a");

    assert.deepEqual(parseSignature(": 1 + 1 = 2"), { binders: "", type: "1 + 1 = 2", args: [] });
    // An anonymous hypothesis is filled by Lean from the context.
    assert.deepEqual(parseSignature("(n : ℕ) (_ : 0 < n) : 0 < n * n").args, ["n", "‹_›"]);
    assert.throws(() => parseSignature("n + 0 = n"), /no ':' outside brackets/);
    assert.throws(() => parseSignature("(n : ℕ) :"), /nothing after the ':'/);
  });

  it("are written as one proposition, negated, and applied to their binders", () => {
    const sig = parseSignature("(n : ℕ) : n + 0 = n");
    assert.equal(closedProp(sig), "∀ (n : ℕ), n + 0 = n");
    assert.equal(paren(sig), "(∀ (n : ℕ), n + 0 = n)");
    assert.equal(closedProp(parseSignature(": True")), "True");
    assert.equal(negationStatement("(n : ℕ) : n + 0 = n"), ": ¬ (∀ (n : ℕ), n + 0 = n)");
    assert.equal(applied("exact L X", sig), "exact L X n");
    assert.equal(applied("h", parseSignature(": True")), "h");
  });
});

describe("variants and the link lemma of an edge", () => {
  const F = "(n : ℕ) : n + 0 = n";
  const T = ": True";
  const f = "(∀ (n : ℕ), n + 0 = n)";

  it("puts the variant at the end the relation says", () => {
    assert.deepEqual(VARIANT_RELATIONS, ["strengthening", "special_case", "generalization", "negation"]);
    assert.deepEqual(variantEdge("strengthening", "claim", "variant"), { kind: "strengthens", from: "variant", to: "claim" });
    assert.deepEqual(variantEdge("special_case", "claim", "variant"), { kind: "special_case_of", from: "variant", to: "claim" });
    assert.deepEqual(variantEdge("generalization", "claim", "variant"), { kind: "special_case_of", from: "claim", to: "variant" });
    assert.deepEqual(variantEdge("negation", "claim", "variant"), { kind: "negation_of", from: "variant", to: "claim" });
  });

  it("is a statement of the shape each propagation rule relies on", () => {
    assert.equal(linkStatement("implies", F, [T]), `: ${f} → (True)`);
    assert.equal(linkStatement("strengthens", F, [T]), `: ${f} → (True)`);
    assert.equal(linkStatement("special_case_of", F, [T]), `: (True) → ${f}`);
    assert.equal(linkStatement("instance_of", F, [T]), `: (True) → ${f}`);
    assert.equal(linkStatement("equiv", F, [T]), `: ${f} ↔ (True)`);
    assert.equal(linkStatement("negation_of", F, [T]), `: ${f} ↔ ¬ (True)`);
    assert.equal(linkStatement("refuted_by", F, [T]), `: (True) → ¬ ${f}`);
    assert.equal(linkStatement("decomposes_into", F, [": 1 = 1", ": 2 = 2"]), `: (1 = 1) → (2 = 2) → ${f}`);
    // Provenance edges have no lemma.
    for (const kind of ["uses", "derived_from", "cites"] as const) assert.equal(linkStatement(kind, F, [T]), undefined);
    assert.throws(() => linkStatement("implies", F, []), /has no target/);
  });

  it("is named after the edge's kind and the ends of the ids", () => {
    const link = linkFor("implies", { id: "clm_01ABCDEFGH", statement: F }, [{ id: "clm_01XYZ123456", statement: T }]);
    assert.equal(link?.name, "link_implies_CDEFGH_123456");
    assert.equal(link?.statement, `: ${f} → (True)`);
    assert.equal(linkFor("cites", { id: "a", statement: F }, [{ id: "b", statement: T }]), undefined);
  });
});
