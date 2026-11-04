import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_GATE,
  gateRule,
  type GateQuery,
  type GateSettings,
  type GateState,
  gateSettings,
  probeVerdict,
  probeCapUsd,
  widenRule,
  progressed,
  NO_PROGRESS,
} from "../src/index.ts";

const state: GateState = { remainingUsd: 4, budgetUsd: 5 };
/** A session estimated at 5 cents, a chance of 0.1: the threshold is 0.5 x 4 x 0.1 = 0.20. */
type Changes = { [K in keyof GateQuery]?: GateQuery[K] | undefined };
const query = (changes: Changes = {}): GateQuery => {
  const merged: Record<string, unknown> = { site: "session", estimateUsd: 0.05, pSuccess: 0.1, floorDraw: 0.99, rung: 0, ...changes };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as GateQuery;
};

describe("the gate's rule", () => {
  it("launches when the estimate is within the share of what is left times the chance of success", () => {
    const { verdict, undecided } = gateRule(query(), state, DEFAULT_GATE);
    assert.equal(undecided, undefined);
    assert.equal(verdict.action, "launch");
    assert.equal(verdict.by, "rule");
    assert.equal(verdict.share, 0.5);
    assert.ok(Math.abs((verdict.thresholdUsd ?? 0) - 0.2) < 1e-12);
    assert.equal(verdict.pSuccess, 0.1);
    assert.equal(verdict.exploration, false);
  });

  it("skips when the estimate is over it, and says the numbers", () => {
    const { verdict } = gateRule(query({ estimateUsd: 0.5 }), state, DEFAULT_GATE);
    assert.equal(verdict.action, "skip");
    assert.equal(verdict.by, "rule");
    assert.match(verdict.reason, /0\.5000 is over 0\.2000 = 0\.5 x 4\.0000 x 0\.1000/);
  });

  it("takes a different share at each site, and the same query is answered the same way every time", () => {
    const task = gateRule(query({ site: "task", estimateUsd: 0.15 }), state, DEFAULT_GATE).verdict;
    assert.equal(task.share, 0.25);
    assert.equal(task.action, "skip", "0.25 x 4 x 0.1 = 0.1 is under 0.15");
    const again = gateRule(query({ site: "task", estimateUsd: 0.15 }), state, DEFAULT_GATE).verdict;
    assert.deepEqual(again, task);
    const wide = gateRule(query({ site: "task", estimateUsd: 0.15 }), state, gateSettings({ share: { task: 0.5 } })).verdict;
    assert.equal(wide.action, "launch");
  });

  it("lets a fixed fraction of the skips through: the exploration floor", () => {
    const over = { estimateUsd: 0.5 };
    const through = gateRule(query({ ...over, floorDraw: 0.05 }), state, DEFAULT_GATE).verdict;
    assert.equal(through.action, "launch");
    assert.equal(through.by, "floor");
    assert.equal(through.exploration, true);
    const held = gateRule(query({ ...over, floorDraw: 0.1 }), state, DEFAULT_GATE).verdict;
    assert.equal(held.action, "skip", "the floor is a draw under its fraction");
    // A launch the rule gives is never the floor's, whatever the draw.
    assert.equal(gateRule(query({ floorDraw: 0.01 }), state, DEFAULT_GATE).verdict.by, "rule");
    // A floor of 0 turns it off.
    assert.equal(gateRule(query({ ...over, floorDraw: 0 }), state, gateSettings({ floor: 0 })).verdict.action, "skip");
  });

  it("measured over many draws, the floor lets its fraction of the skips through", () => {
    let launched = 0;
    const n = 2000;
    for (let k = 0; k < n; k += 1) if (gateRule(query({ estimateUsd: 0.5, floorDraw: (k + 0.5) / n }), state, DEFAULT_GATE).verdict.action === "launch") launched += 1;
    assert.equal(launched / n, DEFAULT_GATE.floor);
  });

  it("has no numbers at a cold start, and says so: the verdict it falls back to is the rule on the flat prior's draw", () => {
    const cold = gateRule(query({ pSuccess: undefined, coldDraw: 0.5 }), state, DEFAULT_GATE);
    assert.equal(cold.undecided, "cold_start");
    assert.equal(cold.verdict.by, "rule");
    assert.equal(cold.verdict.pSuccess, 0.5);
    assert.equal(cold.verdict.action, "launch");
    assert.throws(() => gateRule(query({ pSuccess: undefined }), state, DEFAULT_GATE), /a cold start needs the draw of the flat prior/);
  });

  it("calls a tie when the estimate is within the margin of the threshold, and leaves the rule's own answer as the fallback", () => {
    const under = gateRule(query({ estimateUsd: 0.21 }), state, DEFAULT_GATE);
    assert.equal(under.undecided, "tie");
    assert.equal(under.verdict.action, "skip");
    const over = gateRule(query({ estimateUsd: 0.19 }), state, DEFAULT_GATE);
    assert.equal(over.undecided, "tie");
    assert.equal(over.verdict.action, "launch");
    assert.equal(gateRule(query({ estimateUsd: 0.23 }), state, DEFAULT_GATE).undecided, undefined, "a margin of 10% of 0.2 is 0.02");
    assert.equal(gateRule(query({ estimateUsd: 0.21 }), state, gateSettings({ margin: 0 })).undecided, undefined);
  });

  it("skips a hopeless launch and launches a free one without asking anything", () => {
    assert.equal(gateRule(query({ pSuccess: 0 }), state, DEFAULT_GATE).verdict.action, "skip");
    assert.equal(gateRule(query({ pSuccess: 0 }), state, DEFAULT_GATE).undecided, undefined);
    assert.equal(gateRule(query({ estimateUsd: 0, pSuccess: 0 }), state, DEFAULT_GATE).verdict.action, "launch");
    assert.equal(gateRule(query(), { remainingUsd: 0, budgetUsd: 5 }, DEFAULT_GATE).verdict.action, "skip", "nothing left");
  });
});

describe("the probe and the widening", () => {
  it("starts a problem with one launch of at most a tenth of its budget", () => {
    assert.equal(probeCapUsd(5, DEFAULT_GATE), 0.5);
    const v = probeVerdict({ estimateUsd: 0.05, rung: 0 }, state, DEFAULT_GATE);
    assert.equal(v.action, "probe");
    assert.equal(v.by, "probe");
    assert.equal(v.share, 0.1);
    assert.equal(v.pSuccess, undefined);
    assert.match(v.reason, /one prover, one session, at most 0\.5000 \(10% of 5\.0000\)/);
    assert.equal(probeCapUsd(5, gateSettings({ probeFraction: 0.05 })), 0.25);
  });

  it("widens only after Lean progress, and then by the rule", () => {
    const w = (changes: Changes) => widenRule(query({ site: "wave", ...changes }), state, DEFAULT_GATE);
    const yes = w({ progress: true });
    assert.equal(yes.verdict.action, "widen");
    assert.equal(yes.verdict.by, "rule");
    assert.equal(yes.verdict.progress, true);
    const none = w({ progress: false });
    assert.equal(none.verdict.action, "skip");
    assert.equal(none.verdict.by, "progress");
    assert.equal(none.verdict.progress, false);
    assert.equal(none.undecided, undefined, "no progress is not a question for decide");
    // With progress, a launch the rule refuses is a skip, and a tie is a question.
    assert.equal(w({ progress: true, estimateUsd: 0.5 }).verdict.action, "skip");
    assert.equal(w({ progress: true, estimateUsd: 0.21 }).undecided, "tie");
  });

  it("lets the floor widen a problem with no progress at the floor's fraction", () => {
    const v = widenRule(query({ site: "wave", progress: false, floorDraw: 0.05 }), state, DEFAULT_GATE).verdict;
    assert.equal(v.action, "widen");
    assert.equal(v.by, "floor");
    assert.equal(v.exploration, true);
    assert.equal(v.progress, false);
  });

  it("reads Lean progress as the ladder does: a subclaim proved, or fewer holes", () => {
    assert.equal(progressed(NO_PROGRESS, NO_PROGRESS), undefined);
    assert.match(progressed(NO_PROGRESS, { proved: 1, holes: undefined }) ?? "", /1 more subclaim/);
    assert.match(progressed({ proved: 0, holes: 3 }, { proved: 0, holes: 1 }) ?? "", /open hole/);
  });
});

describe("the settings", () => {
  it("are refused when out of range", () => {
    const bad = (s: GateSettings, message: RegExp) => assert.throws(() => gateSettings(s), message);
    bad({ floor: 1.5 }, /floor must be from 0 to 1/);
    bad({ probeFraction: 0 }, /probeFraction must be above 0 and at most 1/);
    bad({ margin: -1 }, /margin must be from 0 to 1/);
    bad({ share: { wave: 0 } }, /share of wave must be above 0 and at most 1/);
    bad({ share: { vibes: 0.5 } as never }, /unknown site vibes/);
    assert.deepEqual(gateSettings({}), DEFAULT_GATE);
  });
});

describe("the floor's draw and a prover's grace", () => {
  it("puts the draw and the fraction in a floor verdict, and in none other", () => {
    const through = gateRule(query({ estimateUsd: 0.5, floorDraw: 0.05 }), state, DEFAULT_GATE).verdict;
    assert.deepEqual([through.floorDraw, through.floorFraction], [0.05, 0.1]);
    assert.equal(gateRule(query({ estimateUsd: 0.5, floorDraw: 0.5 }), state, DEFAULT_GATE).verdict.floorDraw, undefined);
    assert.equal(gateRule(query(), state, DEFAULT_GATE).verdict.floorDraw, undefined);
    const widened = widenRule(query({ site: "wave", progress: false, floorDraw: 0.01 }), state, DEFAULT_GATE).verdict;
    assert.deepEqual([widened.by, widened.floorDraw, widened.floorFraction], ["floor", 0.01, 0.1]);
  });

  it("lets a prover run a minimum of sessions before the gate can end it", () => {
    assert.equal(DEFAULT_GATE.minSessions, 2);
    assert.equal(gateSettings({ minSessions: 1 }).minSessions, 1);
    assert.throws(() => gateSettings({ minSessions: 0 }), /minSessions must be a whole number of at least 1/);
    assert.throws(() => gateSettings({ minSessions: 1.5 }), /minSessions must be a whole number of at least 1/);
  });
});
