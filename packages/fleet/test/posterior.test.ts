import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { betaMean, betaUpdate, modelPosteriors, posteriorOf, rewardOf, stagnating, strategyOf, strategyPosteriors, successRate, UNIFORM } from "../src/index.ts";
import { attempt, failedAt, proved } from "./helpers.ts";

describe("Beta updates", () => {
  it("add the reward to alpha and the rest to beta", () => {
    assert.deepEqual(betaUpdate(UNIFORM, 1), { alpha: 2, beta: 1 });
    assert.deepEqual(betaUpdate(UNIFORM, 0), { alpha: 1, beta: 2 });
    assert.deepEqual(betaUpdate(UNIFORM, 0.25), { alpha: 1.25, beta: 1.75 });
    assert.deepEqual(betaUpdate(UNIFORM, 7), { alpha: 2, beta: 1 }, "a reward is kept in [0, 1]");
    assert.equal(betaMean(UNIFORM), 0.5);
    assert.equal(betaMean({ alpha: 3, beta: 1 }), 0.75);
  });
});

describe("what an attempt is worth", () => {
  it("is 1 for a proof, and for a failure the share of the ladder Lean got up", () => {
    assert.equal(rewardOf({ outcome: "valid" }, 0.5), 1);
    assert.equal(rewardOf({ outcome: "invalid", failureClass: "unsolved_goals" }, 0.5), 0.5 * (5 / 7));
    assert.equal(rewardOf({ outcome: "invalid", failureClass: "axioms" }, 0.5), 0.5);
    assert.equal(rewardOf({ outcome: "invalid", failureClass: "syntax" }, 0.5), 0.5 * (1 / 7));
    assert.equal(rewardOf({ outcome: "invalid", failureClass: "restates_target" }, 0.5), 0);
    assert.equal(rewardOf({ outcome: "invalid" }, 0.5), 0);
    assert.equal(rewardOf({ outcome: "invalid", failureClass: "unsolved_goals" }, 0), 0, "no partial credit");
  });

  it("is nothing for an attempt that says nothing", () => {
    for (const outcome of ["no_submission", "aborted", "budget_exhausted", "error"] as const) {
      assert.equal(rewardOf({ outcome, failureClass: "holes" }, 0.5), undefined);
    }
    assert.equal(rewardOf({}, 0.5), undefined);
  });
});

describe("posteriors from the attempts", () => {
  const attempts = [
    failedAt("unsolved_goals", "induction"),
    failedAt("syntax", "induction"),
    failedAt("tactic_failed", "automation"),
    proved("cases"),
    attempt({ outcome: "aborted", strategy: "algebra" }),
    attempt({ outcome: "no_submission" }),
  ];

  it("count the finished attempts that carry a verdict", () => {
    const all = posteriorOf(attempts, 0.5);
    assert.equal(all.attempts, 4);
    assert.deepEqual(all.success, { alpha: 2, beta: 4 });
    assert.equal(successRate(all), 2 / 6);
    // The choice posterior also gives the failures their partial credit.
    const credit = 0.5 * (5 / 7) + 0.5 * (1 / 7) + 0.5 * (4 / 7);
    assert.ok(Math.abs(all.choice.alpha - (2 + credit)) < 1e-12);
    assert.ok(Math.abs(all.choice.beta - (4 - credit)) < 1e-12);
  });

  it("are kept per strategy label, the classified one first and the declared one after", () => {
    const byStrategy = strategyPosteriors([...attempts, failedAt("holes", undefined, { declaredStrategy: "bounds" }), failedAt("holes", "rewriting", { declaredStrategy: "bounds" })], 0.5);
    assert.deepEqual([...byStrategy.keys()].sort(), ["automation", "bounds", "cases", "induction", "rewriting"]);
    assert.equal(byStrategy.get("induction")?.attempts, 2);
    assert.deepEqual(byStrategy.get("cases")?.success, { alpha: 2, beta: 1 });
    assert.equal(strategyOf({ strategy: "induction", declaredStrategy: "cases" }), "induction");
    assert.equal(strategyOf({ declaredStrategy: "cases" }), "cases");
    assert.equal(strategyOf({}), undefined);
  });

  it("are kept per model", () => {
    const byModel = modelPosteriors([proved("cases", { model: "faux/strong" }), failedAt("syntax", "cases", { model: "faux/strong" }), failedAt("syntax", "cases", { model: "faux/prover" })], 0.5);
    assert.deepEqual(byModel.get("faux/strong")?.success, { alpha: 2, beta: 2 });
    assert.deepEqual(byModel.get("faux/prover")?.success, { alpha: 1, beta: 2 });
  });

  it("move with each observation: failures lower the rate, a proof raises it", () => {
    const rates = [[], [failedAt("holes")], [failedAt("holes"), failedAt("holes")], [failedAt("holes"), failedAt("holes"), proved()]].map((list) => successRate(posteriorOf(list, 0.5)));
    assert.deepEqual(rates, [1 / 2, 1 / 3, 1 / 4, 2 / 5]);
  });
});

describe("stagnation", () => {
  const options = { below: 0.25, minAttempts: 4 };

  it("is a claim with enough attempts and a low success rate under every strategy", () => {
    const failing = (n: number, label: string) => Array.from({ length: n }, () => failedAt("unsolved_goals", label));
    assert.equal(stagnating(strategyPosteriors([...failing(4, "induction"), ...failing(3, "cases")], 0.5), options), true);
    assert.equal(stagnating(strategyPosteriors(failing(3, "induction"), 0.5), options), false, "too few attempts");
    assert.equal(stagnating(strategyPosteriors([...failing(5, "induction"), proved("cases")], 0.5), options), false, "one strategy does well");
    assert.equal(stagnating(new Map(), options), false);
  });
});
