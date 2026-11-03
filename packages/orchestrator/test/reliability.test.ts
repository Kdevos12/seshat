import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agreement, labelDecisions, reliability } from "../src/reliability.ts";
import { scriptedRun } from "./ablate-helpers.ts";

describe("the reliability of decisions", () => {
  const llm = scriptedRun({
    problems: [{ id: "p1", outcome: "proved", attempts: [{ strategy: "induction", outcome: "valid" }] }],
    claims: [
      { id: "c1", origin: "line:M13", parentId: "p1", validBy: "line:M10", status: "computed" },
      { id: "c2", origin: "line:M13", parentId: "p1" },
      { id: "c3", origin: "line:M13", parentId: "p1" },
    ],
    nodes: [{ kind: "battery_run", claimId: "p1", data: { solved: { tactic: "omega", proof: "omega" }, tries: [] } }],
    decisions: [
      // Scores on conjectures: the first is proved, the others are not.
      { site: "conjecture.relevance", labels: ["low", "high"], answer: "high", probabilities: { low: 0.1, high: 0.9 }, claimId: "c1", key: "k1" },
      { site: "conjecture.relevance", labels: ["low", "high"], answer: "high", probabilities: { low: 0.2, high: 0.8 }, claimId: "c2", key: "k2" },
      { site: "conjecture.relevance", labels: ["low", "high"], answer: "low", probabilities: { low: 0.7, high: 0.3 }, claimId: "c3", key: "k3" },
      // An order of tactics: the model put simp first, omega solved the goal.
      { site: "prove.search.order", labels: ["simp", "omega", "ring"], answer: "simp", probabilities: { simp: 0.5, omega: 0.3, ring: 0.2 }, claimId: "p1", key: "k4" },
      // A cold start over strategies: induction first, and it was the strategy of the valid attempt.
      { site: "fleet.cold_start", labels: ["induction", "automation"], answer: "induction", probabilities: { induction: 0.6, automation: 0.4 }, claimId: "p1", key: "k5" },
      // No claim: no outcome.
      { site: "fleet.cold_start", labels: ["induction", "automation"], answer: "induction", probabilities: { induction: 0.6, automation: 0.4 }, key: "k6" },
    ],
  });

  it("labels each decision by what Lean came to", () => {
    const labeled = labelDecisions(llm.events);
    assert.deepEqual(labeled.map((d) => d.success), [true, false, false, false, true, undefined]);
    // The tactic that closed the goal was second in the model's order; the strategy that proved it, first.
    assert.equal(labeled[3]?.successRank, 2);
    assert.equal(labeled[4]?.successRank, 1);
    assert.deepEqual(labeled[3]?.ranking, ["simp", "omega", "ring"]);
  });

  it("builds the bins and the expected calibration error per site and backend", () => {
    const table = reliability(labelDecisions(llm.events));
    const relevance = table.find((t) => t.site === "conjecture.relevance");
    assert.ok(relevance);
    assert.equal(relevance.decisions, 3);
    assert.equal(relevance.labeled, 3);
    assert.equal(relevance.successes, 1);
    // Bins: [0.7, 0.8) holds the 0.7 answer (wrong), [0.8, 0.9) the 0.8 (wrong), [0.9, 1] the 0.9 (right).
    assert.deepEqual(relevance.bins.map((b) => [b.n, b.accuracy]), [[1, 0], [1, 0], [1, 1]]);
    assert.ok(Math.abs((relevance.ece ?? 0) - (0.7 + 0.8 + 0.1) / 3) < 1e-9);
    const order = table.find((t) => t.site === "prove.search.order");
    assert.deepEqual(order?.rank, { mean: 2, of: 1 });
    const cold = table.find((t) => t.site === "fleet.cold_start");
    assert.equal(cold?.decisions, 2);
    assert.equal(cold?.labeled, 1, "the decision with no claim has no outcome and no place in the curve");
  });

  it("compares two backends on the questions both answered", () => {
    const jev = scriptedRun({
      problems: [{ id: "p1", outcome: "unsolved" }],
      decisions: [
        { site: "prove.search.order", labels: ["simp", "omega", "ring"], answer: "omega", probabilities: { simp: 0.1, omega: 0.8, ring: 0.1 }, backend: "jev", key: "k4" },
        { site: "fleet.cold_start", labels: ["induction", "automation"], answer: "induction", probabilities: { induction: 0.9, automation: 0.1 }, backend: "jev", key: "k5" },
        { site: "fleet.cold_start", labels: ["induction", "automation"], answer: "automation", probabilities: { induction: 0.2, automation: 0.8 }, backend: "jev", key: "other" },
      ],
    });
    const rows = agreement(labelDecisions(llm.events), labelDecisions(jev.events));
    assert.deepEqual(rows, [
      { site: "fleet.cold_start", both: 1, agree: 1, share: 1 },
      { site: "prove.search.order", both: 1, agree: 0, share: 0 },
    ]);
  });
});
