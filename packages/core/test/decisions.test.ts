import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DECISION_SITES, decisionSiteProblem, type EventDataMap, Journal, loadMemoryChain, statementIdV0 } from "../src/index.ts";

type Data = EventDataMap["decision.made"];

function open(): Journal {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-decision-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
  journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
  return journal;
}

const decision = (changes: Partial<Data> = {}): Data => ({
  decisionId: "dec_1",
  key: "k1",
  line: "M10",
  problemId: "P1",
  claimId: "clm_1",
  site: "prove.search.order",
  backend: "llm",
  requested: "llm",
  model: "prov/model",
  type: "choice",
  labels: ["simp", "omega"],
  requestHash: "r",
  stateHash: "s",
  answer: "simp",
  probabilities: { simp: 0.75, omega: 0.25 },
  costUsd: 0.001,
  modelCallIds: [],
  ...changes,
});

describe("decision.made", () => {
  it("is written by the orchestrator and projected by problem and question", () => {
    const journal = open();
    try {
      assert.throws(() => journal.emit("decision.made", decision(), "line:M10"), /written by the orchestrator only, not by line:M10/);
      journal.emit("decision.made", decision(), "orchestrator");
      assert.equal(journal.projection.decisionByKey("P1", "k1")?.data.answer, "simp");
      assert.equal(journal.projection.decisionByKey("P2", "k1"), undefined);
      assert.deepEqual(journal.projection.decisions({ site: "prove.search.order" }).map((d) => d.decision_id), ["dec_1"]);
      assert.throws(() => journal.emit("decision.made", decision({ decisionId: "dec_2" }), "orchestrator"), /already holds a decision for this question/);
      assert.equal(journal.projection.claim("clm_1")?.status, "open", "a decision changes no claim");
    } finally {
      journal.close();
    }
  });

  it("refuses the sites decide never serves, whoever writes", () => {
    const journal = open();
    try {
      for (const site of ["fidelity.review", "statement.equivalence", "claim.status", "lean.progress", "prover.session", "graph.attempt"]) {
        assert.throws(() => journal.emit("decision.made", decision({ site }), "orchestrator"), /decision dec_1: /, site);
      }
      assert.match(decisionSiteProblem("fidelity.review") ?? "", /forbidden at fidelity.review/);
      assert.match(decisionSiteProblem("graph.attempt") ?? "", /not a decide site/);
      assert.equal(decisionSiteProblem("conjecture.relevance"), undefined);
      assert.deepEqual(Object.keys(DECISION_SITES).sort(), ["conjecture.relevance", "fleet.cold_start", "prove.search.order"]);
      assert.throws(() => journal.emit("decision.made", decision({ type: "score", labels: ["a", "b"], answer: "a", probabilities: { a: 1, b: 0 } }), "orchestrator"), /asks choice, not a score/);
    } finally {
      journal.close();
    }
  });

  it("checks the distribution, the answer and the reason for a fallback", () => {
    const journal = open();
    try {
      const bad = (changes: Partial<Data>, message: RegExp) => assert.throws(() => journal.emit("decision.made", decision(changes), "orchestrator"), message);
      bad({ probabilities: { simp: 0.5, omega: 0.2 } }, /sum to 0.7, not 1/);
      bad({ probabilities: { simp: 1.5, omega: -0.5 } }, /from 0 to 1/);
      bad({ probabilities: { simp: 0.5, omega: 0.25, rfl: 0.25 } }, /not a label/);
      bad({ answer: "rfl" }, /not one of its labels/);
      bad({ backend: "jev" }, /was asked and jev answered, so it says why/);
      bad({ backend: "gpt" as never, requested: "gpt" as never }, /unknown backend/);
      bad({ problemId: "P9" }, /unknown problem/);
      bad({ labels: ["simp"], probabilities: { simp: 1 } }, /two or more distinct names/);
      journal.emit("decision.made", decision({ backend: "llm", requested: "jev", fallback: "no key" }), "orchestrator");
      journal.emit(
        "decision.made",
        decision({ decisionId: "dec_3", key: "k3", site: "conjecture.relevance", type: "noul", labels: ["yes", "no"], answer: true, probabilities: { yes: 0.9, no: 0.1 } }),
        "orchestrator",
      );
    } finally {
      journal.close();
    }
  });

  it("is not carried into a run that starts on an earlier journal", () => {
    const first = mkdtempSync(join(tmpdir(), "mh-decision-"));
    const a = Journal.open(first, "run_a");
    a.emit("run.started", { runId: "run_a", benchId: "b", problems: 1, host: "test", config: { model: "prov/model-5", prompt: { version: "m0-2" }, bench: { hash: "h", source: { repo: "r", rev: "x" } } } }, "orchestrator");
    a.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
    a.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
    a.emit("decision.made", decision(), "orchestrator");
    a.close();
    const chain = loadMemoryChain(first, undefined);
    const second = mkdtempSync(join(tmpdir(), "mh-decision-"));
    const b = Journal.open(second, "run_b", { memory: chain });
    try {
      assert.equal(b.projection.decisions().length, 0, "the same problem id in another run is another problem");
    } finally {
      b.close();
    }
  });
});
