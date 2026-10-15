import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVariant, proposeEdge } from "../src/index.ts";
import { claim, HEADER, world } from "./helpers.ts";

const BASE = "(n : ℕ) : n + 0 = n";

describe("variants", () => {
  it("make a claim and its edge, which stays proposed until Lean checks the link lemma", async () => {
    const w = world();
    const base = await claim(w, BASE);
    const strong = await createVariant(w.memory, { from: base, relation: "strengthening", statement: "(n : ℕ) : n + 0 = n ∧ 0 + n = n" });
    assert.equal(strong.created, true);
    assert.deepEqual([strong.edge.kind, strong.edge.from, strong.edge.to, strong.edge.status], ["strengthens", strong.claimId, [base], "proposed"]);
    assert.equal(strong.edge.link?.statement, ": (∀ (n : ℕ), n + 0 = n ∧ 0 + n = n) → (∀ (n : ℕ), n + 0 = n)");
    const made = w.memory.claim(strong.claimId);
    assert.deepEqual([made?.parentId, made?.header, made?.origin, made?.kind, made?.status], [base, HEADER, "line:M2", "formal", "open"]);

    const special = await createVariant(w.memory, { from: base, relation: "special_case", statement: "(n : ℕ) (h : 0 < n) : n + 0 = n" });
    assert.deepEqual([special.edge.kind, special.edge.from, special.edge.to], ["special_case_of", special.claimId, [base]]);
    assert.equal(special.edge.link?.statement, ": (∀ (n : ℕ), n + 0 = n) → (∀ (n : ℕ) (h : 0 < n), n + 0 = n)");

    const general = await createVariant(w.memory, { from: base, relation: "generalization", statement: "(n m : ℕ) : n + m = m + n", gloss: "commutes" });
    assert.deepEqual([general.edge.kind, general.edge.from, general.edge.to], ["special_case_of", base, [general.claimId]]);
    assert.equal(w.memory.claim(general.claimId)?.gloss, "commutes");

    // Nothing is checked: no edge propagates yet.
    assert.deepEqual(w.memory.edges({ minStatus: "lean_checked" }), []);
    assert.equal(w.memory.edges({ from: base }).length + w.memory.edges({ to: base }).length, 3);
    w.close();
  });

  it("make the negation of a claim without being given its statement", async () => {
    const w = world();
    const base = await claim(w, BASE);
    const negation = await createVariant(w.memory, { from: base, relation: "negation" });
    assert.equal(w.memory.claim(negation.claimId)?.statement, ": ¬ (∀ (n : ℕ), n + 0 = n)");
    assert.deepEqual([negation.edge.kind, negation.edge.from, negation.edge.to], ["negation_of", negation.claimId, [base]]);
    // `Iff.rfl` proves it: the two sides are the same proposition.
    assert.equal(negation.edge.link?.statement, ": (¬ (∀ (n : ℕ), n + 0 = n)) ↔ ¬ (∀ (n : ℕ), n + 0 = n)");
    w.close();
  });

  it("return the claim and the edge that exist when asked twice", async () => {
    const w = world();
    const base = await claim(w, BASE);
    const first = await createVariant(w.memory, { from: base, relation: "negation" });
    const again = await createVariant(w.memory, { from: base, relation: "negation" });
    assert.equal(again.created, false);
    assert.equal(again.claimId, first.claimId);
    assert.equal(again.edge.edgeId, first.edge.edgeId);
    assert.equal(w.memory.edges({ to: base }).length, 1);
    // The same edge asked for directly.
    assert.equal(proposeEdge(w.memory, { kind: "negation_of", from: first.claimId, to: base }).edgeId, first.edge.edgeId);
    w.close();
  });

  it("refuse what has no meaning", async () => {
    const w = world();
    const base = await claim(w, BASE);
    const prose = (await w.memory.ensureClaim({ statement: "Addition has a unit.", origin: "test", kind: "informal" })).claimId;
    await assert.rejects(createVariant(w.memory, { from: "clm_nowhere", relation: "negation" }), /unknown claim/);
    await assert.rejects(createVariant(w.memory, { from: prose, relation: "negation" }), /informal/);
    await assert.rejects(createVariant(w.memory, { from: base, relation: "strengthening" }), /needs its statement/);
    await assert.rejects(createVariant(w.memory, { from: base, relation: "special_case", statement: BASE }), /has the statement of claim/);
    assert.throws(() => proposeEdge(w.memory, { kind: "implies", from: base, to: prose }), /informal/);
    w.close();
  });
});
