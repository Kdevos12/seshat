import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DECISION_SITES, decisionSiteProblem, type EventDataMap, Journal, statementIdV0 } from "../src/index.ts";

type Data = EventDataMap["budget.gated"];
/** Changes to a base answer; an `undefined` takes the field away. */
type Changes = { [K in keyof Data]?: Data[K] | undefined };

function open(): Journal {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-gate-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
  journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
  return journal;
}

/** A session launch under the rule: 0.05 against 0.5 of 4 dollars at a success chance of 0.1 (threshold 0.2). */
const gated = (changes: Changes = {}): Data => {
  const merged: Record<string, unknown> = { ...base(), ...changes };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as Data;
};
const base = (): Data => ({
  problemId: "P1",
  site: "session",
  action: "launch",
  by: "rule",
  estimateUsd: 0.05,
  remainingUsd: 4,
  budgetUsd: 5,
  share: 0.5,
  pSuccess: 0.1,
  thresholdUsd: 0.2,
  rung: 0,
  exploration: false,
  reason: "0.05 is within 0.2",
});

describe("the sites budget.wave and budget.line", () => {
  it("are decide sites that ask a choice, and are not on the forbidden list", () => {
    assert.equal(decisionSiteProblem("budget.wave"), undefined);
    assert.equal(decisionSiteProblem("budget.line"), undefined);
    assert.deepEqual(DECISION_SITES["budget.wave"], ["choice"]);
    assert.deepEqual(DECISION_SITES["budget.line"], ["choice"]);
    // The names a gate might have been tempted to use would have been refused.
    assert.match(decisionSiteProblem("budget.session") ?? "", /forbidden/);
    assert.match(decisionSiteProblem("budget.progress") ?? "", /forbidden/);
  });
});

describe("budget.gated", () => {
  it("is written by the orchestrator only, about a problem the journal knows", () => {
    const journal = open();
    try {
      assert.throws(() => journal.emit("budget.gated", gated(), "line:M12"), /written by the orchestrator only, not by line:M12/);
      assert.throws(() => journal.emit("budget.gated", gated({ problemId: "P9" }), "orchestrator"), /unknown problem P9/);
      journal.emit("budget.gated", gated(), "orchestrator");
      assert.equal(journal.projection.claim("clm_1")?.status, "open", "a gate decision changes no claim");
      assert.deepEqual(journal.projection.gates({ problemId: "P1" }).map((g) => [g.site, g.action, g.by]), [["session", "launch", "rule"]]);
      assert.deepEqual(journal.projection.gates({ problemId: "P2" }), []);
    } finally {
      journal.close();
    }
  });

  it("checks the arithmetic of the rule: the threshold is the share of what is left times the chance, and the answer follows from it", () => {
    const journal = open();
    try {
      const bad = (changes: Changes, message: RegExp) => assert.throws(() => journal.emit("budget.gated", gated(changes), "orchestrator"), message);
      bad({ thresholdUsd: 0.3 }, /threshold 0.3 is not 0.5 x 4 x 0.1/);
      bad({ estimateUsd: 0.25 }, /launches 0.25 over the threshold 0.2/);
      bad({ action: "skip" }, /skips 0.05 under the threshold 0.2/);
      bad({ pSuccess: undefined }, /the rule needs the chance of success and the threshold/);
      bad({ pSuccess: 1.5, thresholdUsd: 3 }, /pSuccess must be from 0 to 1/);
      bad({ budgetUsd: 0 }, /budgetUsd must be positive/);
      bad({ remainingUsd: -1 }, /remainingUsd must be a non-negative number/);
      bad({ share: 0 }, /share must be from 0 to 1/);
      bad({ site: "wave", action: "launch" }, /a wave is probed, widened or skipped, not launched/);
      bad({ action: "widen" }, /only a wave is widened/);
      bad({ site: "vibes" as never }, /unknown site vibes/);
      bad({ by: "luck" as never }, /unknown deciding party luck/);
      bad({ reason: "" }, /a gate decision needs a reason/);
      journal.emit("budget.gated", gated({ action: "skip", estimateUsd: 0.25 }), "orchestrator");
    } finally {
      journal.close();
    }
  });

  it("lets the exploration floor launch what the rule would skip, and says so", () => {
    const journal = open();
    try {
      const bad = (changes: Changes, message: RegExp) => assert.throws(() => journal.emit("budget.gated", gated(changes), "orchestrator"), message);
      const over = { estimateUsd: 0.25, by: "floor" as const, exploration: true };
      journal.emit("budget.gated", gated(over), "orchestrator");
      bad({ ...over, exploration: false }, /the exploration floor says so: exploration must be true/);
      bad({ exploration: true }, /exploration is the floor's: by must be floor/);
      bad({ ...over, action: "skip" }, /the floor only lets a launch through/);
    } finally {
      journal.close();
    }
  });

  it("probes first, widens only with Lean progress or by the floor, and skips a widening without progress", () => {
    const journal = open();
    try {
      const wave = (changes: Changes): Data => gated({ site: "wave", ...changes });
      const bad = (changes: Changes, message: RegExp) => assert.throws(() => journal.emit("budget.gated", wave(changes), "orchestrator"), message);
      journal.emit("budget.gated", wave({ action: "probe", by: "probe", pSuccess: undefined, thresholdUsd: undefined, estimateUsd: 0.05, share: 0.1, reason: "one prover, one session, at most 10% of the budget" }), "orchestrator");
      bad({ action: "probe", by: "rule" }, /a probe is the problem's first launch: by must be probe/);
      bad({ action: "widen", progress: false }, /widens only after Lean progress/);
      bad({ action: "widen" }, /widens only after Lean progress/);
      journal.emit("budget.gated", wave({ action: "widen", progress: true }), "orchestrator");
      journal.emit("budget.gated", wave({ action: "widen", progress: false, by: "floor", exploration: true, estimateUsd: 0.25 }), "orchestrator");
      journal.emit("budget.gated", wave({ action: "skip", by: "progress", progress: false, pSuccess: undefined, thresholdUsd: undefined, reason: "the probe made no Lean progress" }), "orchestrator");
      bad({ action: "skip", by: "progress", progress: true }, /no progress is what a progress skip says/);
      assert.deepEqual(journal.projection.gates({ problemId: "P1", site: "wave" }).map((g) => g.action), ["probe", "widen", "widen", "skip"]);
    } finally {
      journal.close();
    }
  });

  it("records a decision that answered where there were no numbers, and a claim already certified", () => {
    const journal = open();
    try {
      const bad = (changes: Changes, message: RegExp) => assert.throws(() => journal.emit("budget.gated", gated(changes), "orchestrator"), message);
      const cold = { by: "decide" as const, pSuccess: undefined, thresholdUsd: undefined };
      bad(cold, /a decide answer names its decision/);
      journal.emit("budget.gated", gated({ ...cold, decisionId: "dec_1", reason: "no posterior: asked budget.wave" }), "orchestrator");
      journal.emit("budget.gated", gated({ site: "wave", action: "skip", by: "memory", pSuccess: undefined, thresholdUsd: undefined, reason: "certified earlier under the same environment" }), "orchestrator");
      bad({ by: "memory", action: "launch", pSuccess: undefined, thresholdUsd: undefined }, /a claim certified earlier is skipped/);
    } finally {
      journal.close();
    }
  });
});
