import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationReport } from "@seshat/core";
import { hasSignal, lastCheckOf, revisionProblem } from "../src/index.ts";
import { failed } from "./helpers.ts";

const file = { aux: "", proof: "induction n with\n| zero => simp\n| succ n ih => omega" };
const unreachable: ValidationReport = { ...failed(), messages: [], leanStatus: "server_error", reasons: ["connection refused"] };
const timedOut: ValidationReport = { ...failed(), messages: [], leanStatus: "timeout", reasons: ["lean: timeout"] };
const refused: ValidationReport = { ...failed(), messages: [], reasons: ["forbidden token: native_decide"] };
delete (refused as { leanStatus?: unknown }).leanStatus;

describe("anchored revisions", () => {
  it("sees a signal in what Lean said, and in a refusal, and none in an answer that never came", () => {
    assert.equal(hasSignal(failed("unsolved goals\n⊢ False")), true);
    assert.equal(hasSignal(refused), true);
    assert.equal(hasSignal(timedOut), true);
    assert.equal(hasSignal(unreachable), false);
  });

  it("lets the first check of a prover be anything", () => {
    assert.equal(revisionProblem(undefined, file), undefined);
  });

  it("refuses the file sent again, apart from comments and spacing", () => {
    const last = lastCheckOf(file, failed("unsolved goals\n⊢ False"));
    assert.equal(revisionProblem(last, { ...file, proof: `-- again\n${file.proof}\n` })?.kind, "identical");
    assert.match(revisionProblem(last, file)?.message ?? "", /already in front of you/);
    // A revision of the file after Lean's answer is what the rule asks for.
    assert.equal(revisionProblem(last, { ...file, proof: "omega" }), undefined);
  });

  it("lets the file be sent again when the last check gave no answer, or ran out of time", () => {
    assert.equal(revisionProblem(lastCheckOf(file, unreachable), file), undefined);
    assert.equal(revisionProblem(lastCheckOf(file, timedOut), file), undefined);
  });

  it("refuses a revision after a check that never reached Lean, and not after a timeout", () => {
    const changed = { ...file, proof: "omega" };
    const problem = revisionProblem(lastCheckOf(file, unreachable), changed);
    assert.equal(problem?.kind, "unanchored");
    assert.match(problem?.message ?? "", /never reached Lean/);
    assert.equal(revisionProblem(lastCheckOf(file, timedOut), changed), undefined);
    assert.equal(revisionProblem(lastCheckOf(file, refused), changed), undefined);
  });
});
