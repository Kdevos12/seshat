import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanMessage, ValidationReport } from "@seshat/core";
import {
  attemptDepth,
  betterOf,
  FAILURE_CLASSES,
  FAILURE_DEPTH,
  failureDepth,
  improves,
  type LeanState,
  leanState,
  VALID_DEPTH,
} from "../src/index.ts";

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
const hole = { pos: { line: 3, column: 2 }, goal: "⊢ True" };
const state = (depth: number, errors = 0, holes = 0): LeanState => ({ depth, errors, holes });

describe("how deep a failure is", () => {
  it("orders the classes from a parse error up to a complete proof", () => {
    const ladder = ["syntax", "unknown_identifier", "type_mismatch", "tactic_failed", "unsolved_goals", "holes", "axioms"];
    assert.deepEqual(ladder.map(failureDepth), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(failureDepth("axioms") < VALID_DEPTH);
  });

  it("gives every class a depth, and 0 to what says nothing about the proof", () => {
    assert.deepEqual(Object.keys(FAILURE_DEPTH).sort(), [...FAILURE_CLASSES].sort());
    for (const cls of ["refused", "lean_unavailable", "timeout", "other", "restates_target", "statement_changed"]) assert.equal(failureDepth(cls), 0);
    assert.equal(failureDepth("a class of the future"), 0);
    assert.equal(failureDepth(undefined), 0);
  });
});

describe("leanState", () => {
  it("reads the depth, the errors and the holes of a report", () => {
    assert.deepEqual(leanState(withErrors("unexpected token 'at'; expected term")), state(1, 1, 0));
    assert.deepEqual(leanState(withErrors("unsolved goals\n⊢ False", "unsolved goals\n⊢ True")), state(5, 2, 0));
    assert.deepEqual(leanState(report({ holes: true, sorries: [hole, hole, hole] })), state(6, 0, 3));
    // A sorry the report lists no goal for still counts as a hole.
    assert.deepEqual(leanState(report({ holes: true })), state(6, 0, 1));
    assert.deepEqual(leanState(report({ verdict: "valid", leanStatus: "valid" })), state(VALID_DEPTH, 0, 0));
  });

  it("is as shallow as the check was uninformative", () => {
    assert.equal(leanState(report({ leanStatus: "server_error" })).depth, 0);
    assert.equal(leanState(report({ leanStatus: "timeout" })).depth, 0);
    const restating = withErrors("unsolved goals\n⊢ False");
    const aux = "theorem aux_main (n : ℕ) : n + 0 = n := by\n  sorry";
    assert.equal(leanState(restating, { aux, statement: "(n : ℕ) : n + 0 = n" }).depth, 0);
    assert.equal(leanState(restating, { aux, statement: "(n : ℕ) : n * 1 = n" }).depth, 5);
  });
});

describe("improves", () => {
  it("counts anything as progress over no state", () => {
    assert.equal(improves(state(0), undefined), true);
  });

  it("prefers a deeper failure, then fewer errors, then fewer holes", () => {
    assert.equal(improves(state(5, 3), state(4, 1)), true);
    assert.equal(improves(state(4, 1), state(5, 3)), false);
    assert.equal(improves(state(5, 1), state(5, 2)), true);
    assert.equal(improves(state(5, 2), state(5, 1)), false);
    assert.equal(improves(state(6, 0, 1), state(6, 0, 2)), true);
    assert.equal(improves(state(6, 0, 3), state(6, 0, 2)), false);
    // Fewer holes with more errors is not progress: the errors come first.
    assert.equal(improves(state(5, 2, 0), state(5, 1, 4)), false);
  });

  it("does not count the same state, or a state that is not better, as progress", () => {
    assert.equal(improves(state(5, 1, 1), state(5, 1, 1)), false);
    assert.equal(improves(state(0), state(3, 1)), false);
  });

  it("keeps the better of two states", () => {
    assert.deepEqual(betterOf(state(4), undefined), state(4));
    assert.deepEqual(betterOf(state(4), state(5)), state(5));
    assert.deepEqual(betterOf(state(5, 0, 1), state(5, 0, 2)), state(5, 0, 1));
    assert.deepEqual(betterOf(state(5), state(5)), state(5));
  });
});

describe("attemptDepth", () => {
  it("is the depth of the failure of a failed attempt, and the end for an accepted one", () => {
    assert.equal(attemptDepth({ outcome: "valid" }), VALID_DEPTH);
    assert.equal(attemptDepth({ outcome: "invalid", failureClass: "unsolved_goals" }), 5);
    assert.equal(attemptDepth({ outcome: "invalid" }), 0);
  });

  it("says nothing for an attempt that was cut or checked nothing", () => {
    for (const outcome of ["no_submission", "aborted", "budget_exhausted", "error", undefined] as const) {
      assert.equal(attemptDepth({ ...(outcome !== undefined ? { outcome } : {}), failureClass: "holes" }), undefined);
    }
  });
});
