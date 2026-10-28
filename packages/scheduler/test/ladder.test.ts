import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FRACTIONS, ladderDue, NO_PROGRESS, progressed, rungsOf } from "../src/index.ts";

describe("the ladder", () => {
  const rungs = [{ lines: ["M13"] }, { lines: ["M14", "M5"] }];

  it("builds its rungs from the enabled lines, and skips a rung no line has", () => {
    assert.deepEqual(rungsOf([{ id: "M2" }, { id: "M13", rung: 1 }, { id: "M14", rung: 3 }, { id: "M5", rung: 3 }, { id: "M1", rung: 0 }]), [{ lines: ["M13"] }, { lines: ["M14", "M5"] }]);
    assert.deepEqual(rungsOf([{ id: "M2" }]), []);
  });

  it("moves up when 30 percent of the budget, then 60 percent, is spent since the last progress", () => {
    const at = (rung: number, sinceProgressUsd: number) => ladderDue(rungs, DEFAULT_FRACTIONS, { rung, sinceProgressUsd, budgetUsd: 10 });
    assert.equal(at(0, 2.99), undefined);
    assert.deepEqual(at(0, 3), { from: 0, to: 1, lines: ["M13"], threshold: 0.3 });
    assert.equal(at(1, 5.9), undefined);
    assert.deepEqual(at(1, 6), { from: 1, to: 2, lines: ["M14", "M5"], threshold: 0.6 });
    assert.equal(at(2, 100), undefined, "there is no rung above the last");
  });

  it("does nothing without rungs, a budget, or fractions; the last fraction serves any further rung", () => {
    assert.equal(ladderDue([], DEFAULT_FRACTIONS, { rung: 0, sinceProgressUsd: 9, budgetUsd: 10 }), undefined);
    assert.equal(ladderDue(rungs, DEFAULT_FRACTIONS, { rung: 0, sinceProgressUsd: 9, budgetUsd: 0 }), undefined);
    assert.equal(ladderDue(rungs, [], { rung: 0, sinceProgressUsd: 9, budgetUsd: 10 }), undefined);
    assert.equal(ladderDue(rungs, [0.5], { rung: 1, sinceProgressUsd: 5, budgetUsd: 10 })?.threshold, 0.5);
  });

  it("counts a new proved subclaim, or fewer open holes in the best healthy sketch, as progress", () => {
    assert.equal(progressed(NO_PROGRESS, NO_PROGRESS), undefined);
    assert.match(progressed({ proved: 0, holes: undefined }, { proved: 1, holes: undefined }) ?? "", /1 more subclaim/);
    assert.match(progressed({ proved: 0, holes: undefined }, { proved: 0, holes: 3 }) ?? "", /healthy sketch with 3 open hole/);
    assert.match(progressed({ proved: 1, holes: 3 }, { proved: 1, holes: 2 }) ?? "", /from 3/);
    assert.equal(progressed({ proved: 1, holes: 2 }, { proved: 1, holes: 2 }), undefined);
    assert.equal(progressed({ proved: 2, holes: 2 }, { proved: 1, holes: 3 }), undefined, "going back is no progress");
  });
});
