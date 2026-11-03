import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAILURE_CLASSES } from "@seshat/memory";
import { CRITICS, CRITICS_BY_CLASS, REPAIR_TABLE, selectRepairs, type Situation } from "../src/index.ts";

const base: Situation = { failureClass: "unsolved_goals", detail: "unsolved goals", statement: "(n : ℕ) : 0 + n = n" };
const critics = (s: Partial<Situation>) => selectRepairs({ ...base, ...s }, 4).map((r) => r.critic);

describe("the table of typed repairs", () => {
  it("has the four critics of Ireland and Bundy, each with a title, classes and a directive", () => {
    assert.deepEqual([...CRITICS].sort(), ["case_split", "generalization", "induction_revision", "lemma_speculation"]);
    assert.deepEqual(REPAIR_TABLE.map((r) => r.critic), ["induction_revision", "generalization", "lemma_speculation", "case_split"]);
    for (const r of REPAIR_TABLE) assert.ok(r.title.length > 3 && r.classes.length > 0 && r.directive(base).length > 40);
  });

  it("places every class of failure: the local errors of syntax and the checks that never ran have no critic", () => {
    assert.deepEqual(Object.keys(CRITICS_BY_CLASS).sort(), [...FAILURE_CLASSES].sort());
    for (const none of ["refused", "lean_unavailable", "timeout", "syntax", "holes", "axioms", "statement_changed", "restates_target", "other"] as const) assert.deepEqual(CRITICS_BY_CLASS[none], [], none);
    assert.deepEqual([...CRITICS_BY_CLASS.unsolved_goals].sort(), ["case_split", "generalization", "induction_revision", "lemma_speculation"]);
    assert.deepEqual(selectRepairs({ ...base, failureClass: "syntax", detail: "syntax error" }), []);
  });

  it("revises the induction when the step case of an induction is left open", () => {
    const got = selectRepairs({ ...base, strategy: "induction", detail: "unsolved goals at case succ", goal: "case succ\nn : ℕ\n⊢ 0 + (n + 1) = n + 1" });
    assert.equal(got[0]?.critic, "induction_revision");
    assert.match(got[0]?.directive ?? "", /strong induction|revert/);
    assert.match(got[0]?.reason ?? "", /step case/);
  });

  it("generalizes when the induction hypothesis is in the goal and does not apply", () => {
    const got = critics({ strategy: "induction", detail: "unsolved goals at case succ", goal: "case succ\nih : f n 0 = n\n⊢ f (n + 1) 0 = n + 1" });
    assert.equal(got[0], "generalization");
    assert.ok(!got.includes("induction_revision"));
  });

  it("speculates a lemma for a stuck equation outside an induction, and for a lemma name that does not exist", () => {
    assert.deepEqual(critics({ failureClass: "tactic_failed", detail: "linarith failed", goal: "linarith failed\na b : ℕ\n⊢ f a * f b = f (a * b)" }), ["lemma_speculation"]);
    const unknown = selectRepairs({ ...base, failureClass: "unknown_identifier", detail: "unknown identifier Nat.mul_foo_bar" });
    assert.equal(unknown[0]?.critic, "lemma_speculation");
    assert.match(unknown[0]?.directive ?? "", /does not exist/);
    assert.deepEqual(critics({ failureClass: "unknown_identifier", detail: "unknown identifier foo" }), []);
  });

  it("splits cases when the goal has a disjunction, a conditional or a parity", () => {
    assert.deepEqual(critics({ goal: "⊢ n % 2 = 0 ∨ n % 2 = 1" }), ["case_split"]);
    assert.deepEqual(critics({ goal: "⊢ (if n = 0 then 1 else n) ≥ 1" }), ["case_split"]);
    assert.ok(critics({ detail: "unsolved goals at case inl", goal: "case inl\n⊢ P" }).includes("case_split"));
  });

  it("suggests at most the number asked, and nothing for a failure no shape matches", () => {
    assert.equal(selectRepairs({ ...base, strategy: "induction", detail: "unsolved goals at case succ", goal: "ih n ∨ x" }, 1).length, 1);
    assert.deepEqual(critics({ goal: "⊢ P" }), []);
  });
});
