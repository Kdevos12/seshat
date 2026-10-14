import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanMessage, ValidationReport } from "@seshat/core";
import { classifyFailure, FAILURE_CLASSES, type FailureContext } from "../src/index.ts";

function error(text: string): LeanMessage {
  return { severity: "error", pos: { line: 12, column: 2 }, text };
}

function report(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    verdict: "invalid", method: "repl", reasons: [], axioms: [], messages: [], sorries: [], checked: "", submissionHash: "h",
    editsOutsideRegions: false, holes: false, leanStatus: "lean_error", ...overrides,
  };
}

const withErrors = (...texts: string[]) => report({ messages: texts.map(error), reasons: [`lean: ${texts.length} error(s)`] });

const GOAL = "n : ℕ\nih : n + 0 = n\n⊢ n + 1 + 0 = n + 1";

/** [the report, the class, the detail]. */
const CASES: Array<[string, ValidationReport, string, string]> = [
  ["refused before Lean", report({ leanStatus: undefined as never, reasons: ["proof: 'native_decide' is not allowed"] }), "refused", "refused before Lean: proof: 'native_decide' is not allowed"],
  ["Lean not reached", report({ leanStatus: "server_error" }), "lean_unavailable", "Lean could not be reached"],
  ["Lean's time limit", report({ leanStatus: "timeout" }), "timeout", "Lean time limit"],
  ["heartbeats", withErrors("(deterministic) timeout at `whnf`, maximum number of heartbeats (200000) has been reached"), "timeout", "heartbeat limit"],
  ["recursion depth", withErrors("maximum recursion depth has been reached\nuse `set_option maxRecDepth <num>` to increase limit"), "timeout", "recursion depth limit"],
  ["unsolved goals at a case", withErrors(`unsolved goals\ncase succ\n${GOAL}`), "unsolved_goals", "unsolved goals at case succ"],
  ["unsolved goals at two cases", withErrors(`unsolved goals\ncase zero\n⊢ 0 + 0 = 0\n\ncase succ\n${GOAL}`), "unsolved_goals", "unsolved goals at cases zero, succ"],
  ["unsolved goals, no case", withErrors("unsolved goals\nn : ℕ\n⊢ n + 0 = n"), "unsolved_goals", "unsolved goals"],
  ["unknown identifier", withErrors("unknown identifier 'Nat.foo_bar'"), "unknown_identifier", "unknown identifier Nat.foo_bar"],
  ["unknown constant", withErrors("unknown constant 'Nat.foo'"), "unknown_identifier", "unknown constant Nat.foo"],
  ["invalid field", withErrors("invalid field 'foo', the environment does not contain 'Nat.foo'\n  n"), "unknown_identifier", "invalid field foo"],
  ["type mismatch", withErrors("type mismatch\n  h\nhas type\n  a = b : Prop\nbut is expected to have type\n  b = a : Prop"), "type_mismatch", "type mismatch"],
  ["application type mismatch", withErrors("application type mismatch\n  f x\nargument\n  x\nhas type ℕ : Type\nbut is expected to have type ℤ : Type"), "type_mismatch", "application type mismatch"],
  ["missing instance", withErrors("failed to synthesize\n  HAdd ℕ ℤ ?m.123\nAdditional diagnostic information may be available using the `set_option diagnostics true` command."), "type_mismatch", "failed to synthesize an instance"],
  ["syntax", withErrors("unexpected token 'at'; expected term"), "syntax", "syntax error"],
  ["unknown tactic", withErrors("unknown tactic"), "syntax", "syntax error"],
  ["linarith", withErrors("linarith failed to find a contradiction\ncase a\nn : ℕ\n⊢ False"), "tactic_failed", "linarith failed"],
  ["omega", withErrors("omega could not prove the goal:\na possible counterexample may satisfy the constraints"), "tactic_failed", "omega failed"],
  ["simp", withErrors("simp made no progress"), "tactic_failed", "simp made no progress"],
  ["rfl", withErrors("The rfl tactic failed. Possible reasons:\n- The goal is not a reflexive relation"), "tactic_failed", "rfl failed"],
  ["rewrite", withErrors("tactic 'rewrite' failed, did not find instance of the pattern in the target expression\n  ?a + 0"), "tactic_failed", "rewrite failed"],
  ["aesop", withErrors("aesop: failed to prove the goal after exhaustive search."), "tactic_failed", "aesop failed"],
  ["extra tactics", withErrors("no goals to be proved"), "tactic_failed", "no goals left"],
  ["an error of a kind not listed", withErrors("some message of a future Lean"), "other", "unclassified Lean error"],
  ["one sorry", report({ holes: true, sorries: [{ pos: { line: 3, column: 2 }, goal: "⊢ True" }] }), "holes", "1 sorry left"],
  ["two sorries", report({ holes: true, sorries: [{ pos: { line: 3, column: 2 }, goal: "⊢ True" }, { pos: { line: 5, column: 2 }, goal: "⊢ True" }] }), "holes", "2 sorries left"],
  ["a forbidden axiom", report({ leanStatus: "valid", reasons: ["lean: Demo.add_zero' depends on Lean.ofReduceBool, Classical.ofNonempty"] }), "axioms", "depends on Lean.ofReduceBool, Classical.ofNonempty"],
  ["a changed statement", report({ leanStatus: "valid", reasons: ["lean: the statement no longer elaborates to the original type"] }), "statement_changed", "statement changed"],
  ["nothing Lean said", report({ leanStatus: "valid", reasons: ["lean: could not read the axioms of Demo.add_zero'"] }), "other", "lean: could not read the axioms of Demo.add_zero'"],
  // When Lean reports several errors, the most basic one is the cause.
  ["a syntax error before unsolved goals", withErrors(`unsolved goals\ncase succ\n${GOAL}`, "unexpected token 'at'; expected term"), "syntax", "syntax error"],
  ["an unknown identifier before a type mismatch", withErrors("type mismatch\n  h", "unknown identifier 'foo'"), "unknown_identifier", "unknown identifier foo"],
  ["a failed tactic before unsolved goals", withErrors("unsolved goals\n⊢ False", "omega could not prove the goal"), "tactic_failed", "omega failed"],
  ["errors win over a sorry", report({ ...withErrors("type mismatch\n  h"), holes: true, sorries: [{ pos: { line: 3, column: 2 }, goal: "⊢ True" }] }), "type_mismatch", "type mismatch"],
];

describe("classifyFailure", () => {
  it("names the class and the detail of a failed check from Lean's messages", () => {
    for (const [name, input, cls, detail] of CASES) {
      assert.deepEqual(classifyFailure(input), { class: cls, detail }, name);
    }
  });

  it("covers every class of the vocabulary but the one that needs the target", () => {
    assert.deepEqual(
      [...new Set(CASES.map(([, , cls]) => cls))].sort(),
      FAILURE_CLASSES.filter((cls) => cls !== "restates_target").sort(),
    );
  });

  it("returns nothing for a valid check", () => {
    assert.equal(classifyFailure(report({ verdict: "valid", leanStatus: "valid" })), undefined);
  });

  it("recognizes an auxiliary lemma that restates the target, up to spacing and comments", () => {
    const context: FailureContext = {
      statement: "(n : ℕ) : n + 0 = n",
      aux: "theorem aux_helper (m : ℕ) : m = m := rfl\n\n/-- the same -/\ntheorem aux_main  (n : ℕ) :\n  n + 0 = n := by -- again\n  sorry",
    };
    const holes = report({ holes: true, sorries: [{ pos: { line: 3, column: 2 }, goal: "⊢ True" }] });
    assert.deepEqual(classifyFailure(holes, context), { class: "restates_target", detail: "auxiliary lemma aux_main restates the target" });
    // The same check fails the same way with other lemmas, and without the context.
    assert.equal(classifyFailure(holes, { ...context, aux: "theorem aux_helper (m : ℕ) : m = m := rfl" })?.class, "holes");
    assert.equal(classifyFailure(holes)?.class, "holes");
    assert.equal(classifyFailure(withErrors("type mismatch\n  h"), context)?.class, "restates_target");
    // A lemma that cannot be cut is ignored.
    assert.equal(classifyFailure(holes, { ...context, aux: "theorem aux_broken (n : ℕ)" })?.class, "holes");
  });
});
