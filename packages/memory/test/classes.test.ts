import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configClassOf, type Provenance } from "@seshat/core";
import {
  type Attempt,
  attemptClass,
  compareClass,
  describeDifference,
  describeTried,
  type ModelRanking,
  onlyWeakerFailures,
  renderTried,
  strongestClass,
  triedStrategies,
} from "../src/index.ts";

// The run's models, weakest first, and its budget class.
const RANKING: ModelRanking = { order: ["prov/small-1", "prov/large-2-20250101"], budgetClass: "medium" };

function stamp(modelId: string, budgetClass = "medium"): Provenance {
  return { modelId, promptVersion: "m0-2", mathlibRev: "rev", harnessVersion: "h", budgetClass, createdAt: "2026-10-28T00:00:00.000Z" };
}

let counter = 0;
function attempt(fields: Partial<Attempt> & { modelId?: string; budgetClass?: string } = {}): Attempt {
  counter += 1;
  const { modelId = "prov/small-1", budgetClass, ...rest } = fields;
  return {
    attemptId: `att_${counter}`, claimId: "clm_1", prover: "p1", iteration: counter, model: modelId, role: "prove",
    strategy: "induction", outcome: "invalid", failureClass: "unsolved_goals", startedSeq: 2 * counter, finishedSeq: 2 * counter + 1,
    provenance: stamp(modelId, budgetClass),
    ...rest,
  };
}

const classOf = (modelId: string, budgetClass = "medium") => configClassOf({ modelId, budgetClass });

describe("config classes compared", () => {
  it("ranks models by the run's order, a snapshot of a family being the family", () => {
    const strong = classOf("prov/large-2-20250101");
    assert.deepEqual(compareClass(RANKING, classOf("prov/small-1"), strong), { relation: "weaker", by: "model" });
    assert.deepEqual(compareClass(RANKING, strong, classOf("prov/small-1")), { relation: "stronger", by: "model" });
    assert.deepEqual(compareClass(RANKING, classOf("prov/large-2-20260301"), strong), { relation: "same" });
    assert.deepEqual(strongestClass(RANKING), strong);
  });

  it("compares budget classes inside one family, and treats an unranked family as an older model", () => {
    const small = classOf("prov/small-1", "small");
    const medium = classOf("prov/small-1", "medium");
    assert.deepEqual(compareClass(RANKING, small, medium), { relation: "weaker", by: "budget" });
    assert.deepEqual(compareClass(RANKING, medium, small), { relation: "stronger", by: "budget" });
    // A model the run no longer lists is weaker than one it lists, and two unlisted ones are not comparable.
    assert.deepEqual(compareClass(RANKING, classOf("prov/retired-0"), medium), { relation: "weaker", by: "model" });
    assert.deepEqual(compareClass(RANKING, classOf("prov/retired-0"), classOf("prov/other-9")), { relation: "other" });
    assert.deepEqual(compareClass(RANKING, classOf("prov/small-1", "medium"), classOf("prov/small-1", "medium")), { relation: "same" });
  });

  it("takes an attempt's class from its stamp, else from its model and the run's budget class", () => {
    assert.deepEqual(attemptClass(attempt({ modelId: "prov/large-2", budgetClass: "large" }), "medium"), { family: "prov/large-2", budgetClass: "large" });
    const { provenance: _unstamped, ...bare } = attempt();
    assert.deepEqual(attemptClass(bare, "small"), { family: "prov/small-1", budgetClass: "small" });
  });

  it("says in words how a configuration differs", () => {
    assert.equal(describeDifference({ relation: "weaker", by: "model" }), "a smaller model");
    assert.equal(describeDifference({ relation: "stronger", by: "model" }), "a larger model");
    assert.equal(describeDifference({ relation: "weaker", by: "budget" }), "a smaller budget");
    assert.equal(describeDifference({ relation: "stronger", by: "budget" }), "a larger budget");
    assert.equal(describeDifference({ relation: "other" }), "another model");
  });
});

describe("already tried, grouped by configuration", () => {
  const current = classOf("prov/large-2-20250101");
  const attempts = [
    attempt({ modelId: "prov/small-1" }),
    attempt({ modelId: "prov/small-1" }),
    attempt({ modelId: "prov/large-2-20250101", failureDetail: "unsolved goals at case succ" }),
    attempt({ modelId: "prov/large-2-20250101", strategy: "cases", failureDetail: "case split left a goal" }),
    attempt({ modelId: "prov/large-2-20250101", budgetClass: "small", strategy: "cases" }),
  ];

  it("keeps one line per strategy without a view, as before", () => {
    assert.deepEqual(triedStrategies(attempts).map(describeTried), ["induction: 3 attempts, unsolved goals at case succ", "cases: 2 attempts, unsolved goals"]);
  });

  it("separates the same strategy under another model or budget class, and says so", () => {
    const tried = triedStrategies(attempts, { current, ranking: RANKING });
    assert.deepEqual(tried.map(describeTried), [
      // The session's own configuration first.
      "cases: 1 attempt, case split left a goal",
      "induction: 1 attempt, unsolved goals at case succ",
      // Then the others, with how they differ.
      "induction: 2 attempts, unsolved goals (with a smaller model)",
      "cases: 1 attempt, unsolved goals (with a smaller budget)",
    ]);
    assert.deepEqual(tried.map((entry) => entry.configClass), [
      "prov/large-2@medium", "prov/large-2@medium", "prov/small-1@medium", "prov/large-2@small",
    ]);
  });

  it("renders the lines a briefing shows", () => {
    const lines = renderTried(triedStrategies(attempts, { current, ranking: RANKING }), { maxLines: 12 });
    assert.equal(lines.length, 5);
    assert.match(lines[3] ?? "", /^induction: 2 attempts, unsolved goals \(with a smaller model\)$/);
  });
});

describe("failures that all come from a weaker configuration", () => {
  it("holds when every failure ran under a weaker class than the strongest configured", () => {
    assert.equal(onlyWeakerFailures([attempt(), attempt({ modelId: "prov/small-1", budgetClass: "small" })], RANKING), true);
  });

  it("does not hold with a failure from the strongest class, from none, or from a cut session only", () => {
    assert.equal(onlyWeakerFailures([attempt(), attempt({ modelId: "prov/large-2-20250101" })], RANKING), false);
    assert.equal(onlyWeakerFailures([], RANKING), false);
    // A session that was cut or errored says nothing about its configuration; an accepted proof is not a failure.
    assert.equal(onlyWeakerFailures([attempt({ outcome: "aborted" }), attempt({ outcome: "error" })], RANKING), false);
    assert.equal(onlyWeakerFailures([attempt(), attempt({ outcome: "aborted", modelId: "prov/large-2" })], RANKING), true);
    assert.equal(onlyWeakerFailures([attempt()], { order: [], budgetClass: "medium" }), false);
  });

  it("does not hold for a failure of a family the run does not rank, which may be the stronger one of an order nobody stated", () => {
    assert.equal(onlyWeakerFailures([attempt({ modelId: "prov/unlisted-9" })], RANKING), false);
    assert.equal(onlyWeakerFailures([attempt(), attempt({ modelId: "prov/unlisted-9" })], RANKING), false);
    // M1 still reads such a failure as coming from a smaller model (compareClass): only the routing needs the stated order.
    assert.equal(compareClass(RANKING, classOf("prov/unlisted-9"), classOf("prov/large-2")).relation, "weaker");
  });

  it("counts a failure of the same model under a smaller budget as weaker", () => {
    assert.equal(onlyWeakerFailures([attempt({ modelId: "prov/large-2", budgetClass: "small" })], RANKING), true);
    assert.equal(onlyWeakerFailures([attempt({ modelId: "prov/large-2", budgetClass: "large" })], RANKING), false);
  });
});
