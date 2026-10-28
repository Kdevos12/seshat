import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DecideQuestion, isInterrupted } from "@seshat/lines";
import { DecisionOffError, DecisionQuestionError, ForbiddenDecisionError, decisionKey, type ExternalAnswer } from "../src/index.ts";
import { ORDER, Paused, RELEVANCE, rig, scriptedLlm, verdict } from "./helpers.ts";

const jevAnswer = (over: Partial<ExternalAnswer["output"]> = {}): ExternalAnswer => ({
  output: { answer: "omega", probabilities: { simp: 0.1, omega: 0.7, rfl: 0.2 }, backend: "jev", model: "TS/jev-pinned", costUsd: 0.0002, ...over },
  toolRunId: "tr_1",
  modelCallIds: ["mc_j"],
});

describe("decide with the run's model", () => {
  it("is the default: a choice by one vote, journaled with its distribution", async () => {
    const llm = scriptedLlm([verdict("omega")]);
    const { decide, recorded, externals } = rig({ llm });
    const d = await decide.decide(ORDER);
    assert.equal(d.answer, "omega");
    assert.deepEqual(d.probabilities, { simp: 0, omega: 1, rfl: 0 });
    assert.deepEqual([d.backend, d.requested, d.replayed, d.model], ["llm", "llm", false, "prov/model"]);
    assert.equal(externals.length, 0, "nothing leaves the process");
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.labels, ["simp", "omega", "rfl"]);
    assert.equal(recorded[0]?.stateHash.length, 64);
    assert.deepEqual(recorded[0]?.modelCallIds, ["mc_1"]);
    assert.equal(llm.requests[0]?.site, "prove.search.order", "the calls carry the decision's site");
    assert.match(llm.requests[0]?.prompt ?? "", /n : ℕ[\s\S]*Which first\?[\s\S]*- simp: simp/);
  });

  it("takes vote shares as the distribution, and a score's expected level", async () => {
    const llm = scriptedLlm([verdict("high"), verdict("high"), verdict("low"), verdict("high")]);
    const { decide } = rig({ llm, config: { votes: 4 } });
    const d = await decide.decide(RELEVANCE);
    assert.equal(d.answer, "high");
    assert.deepEqual(d.probabilities, { low: 0.25, medium: 0, high: 0.75 });
    assert.equal(d.expected, 1.5);
    assert.ok(Math.abs(d.costUsd - 0.04) < 1e-9);
  });

  it("answers a yes or no with a boolean and the weight of yes and no", async () => {
    const { decide } = rig({ llm: scriptedLlm([verdict("yes")]) });
    const d = await decide.decide({ site: "conjecture.relevance", state: "s", question: { type: "noul", instructions: "Relevant?" } });
    assert.equal(d.answer, true);
    assert.deepEqual(d.probabilities, { yes: 1, no: 0 });
  });
});

describe("the forbidden list and the shape of a question", () => {
  const ask = (site: string, question: DecideQuestion = ORDER.question) => rig({ llm: scriptedLlm([]) }).decide.decide({ site, state: "s", question });

  it("refuses the fidelity review, anything a tool decides, a status and generation, whatever the configuration", async () => {
    for (const site of ["fidelity.review", "statement.equivalence", "claim.status", "lean.progress", "prover.session", "graph.attempt", "conjecture.relevance.generate"]) {
      await assert.rejects(ask(site), ForbiddenDecisionError, site);
    }
    await assert.rejects(ask("fidelity.review"), /forbidden at fidelity.review: .*high-stakes/);
    await assert.rejects(ask("lean.progress"), /including whether a step made progress/);
    // Even a site configured for Jev, or for the faux backend, is refused before any backend is asked.
    const jev = rig({ config: { backend: "jev", sites: { "prove.search.order": "faux" } }, external: jevAnswer() });
    await assert.rejects(jev.decide.decide({ site: "fidelity.review", state: "s", question: ORDER.question }), ForbiddenDecisionError);
    assert.equal(jev.externals.length, 0);
  });

  it("refuses a question type a site does not ask, and a threshold before a reliability curve", async () => {
    await assert.rejects(ask("prove.search.order", RELEVANCE.question), /asks choice, not a score/);
    const { decide } = rig({ llm: scriptedLlm([verdict("simp")]) });
    await assert.rejects(decide.decide({ ...ORDER, use: "threshold" }), /to order only/);
    const calibrated = rig({ llm: scriptedLlm([verdict("simp")]) });
    calibrated.deps.calibrated = () => true;
    // A site with a curve may be thresholded: the check is the curve's existence.
    const d = await (await import("../src/index.ts")).createDecide(calibrated.deps).decide({ ...ORDER, use: "threshold" });
    assert.equal(d.answer, "simp");
  });

  it("checks the options and levels", async () => {
    const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, "x"]));
    await assert.rejects(ask("prove.search.order", { type: "choice", instructions: "q", options: { a: "x" } }), DecisionQuestionError);
    await assert.rejects(ask("prove.search.order", { type: "choice", instructions: "q", options: options(256) }), /2 to 255 options, got 256/);
    await assert.rejects(ask("conjecture.relevance", { type: "score", instructions: "q", levels: ["only"] } as never), /2 to 10 levels/);
    await assert.rejects(ask("conjecture.relevance", { type: "score", instructions: "q", levels: Array.from({ length: 11 }, (_, i) => `l${i}`) } as never), /2 to 10 levels/);
  });

  it("answers 255 options", async () => {
    const options = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, "x"]));
    const { decide } = rig({ llm: scriptedLlm([verdict("o254")]) });
    assert.equal((await decide.decide({ site: "prove.search.order", state: "s", question: { type: "choice", instructions: "q", options } })).answer, "o254");
  });
});

describe("the Jev backend", () => {
  it("answers through the capability, with the full distribution and its cost", async () => {
    const { decide, recorded, externals } = rig({ config: { backend: "jev" }, external: jevAnswer() });
    const d = await decide.decide(ORDER);
    assert.deepEqual([d.backend, d.requested, d.answer, d.fallback], ["jev", "jev", "omega", undefined]);
    assert.deepEqual(d.probabilities, { simp: 0.1, omega: 0.7, rfl: 0.2 });
    assert.equal(externals[0]?.backend, "jev");
    assert.deepEqual([recorded[0]?.toolRunId, recorded[0]?.modelCallIds, recorded[0]?.costUsd, recorded[0]?.model], ["tr_1", ["mc_j"], 0.0002, "TS/jev-pinned"]);
  });

  it("is chosen per site: the site entry wins over the backend, and off keeps the line's own way", async () => {
    const { decide } = rig({ config: { backend: "jev", sites: { "prove.search.order": "llm", "conjecture.relevance": "off" } }, llm: scriptedLlm([verdict("rfl")]) });
    assert.equal(decide.backendFor("prove.search.order"), "llm");
    assert.equal(decide.backendFor("conjecture.relevance"), "off");
    assert.equal(decide.backendFor("fleet.cold_start"), "jev");
    assert.equal((await decide.decide(ORDER)).backend, "llm");
    await assert.rejects(decide.decide(RELEVANCE), DecisionOffError);
  });

  it("falls back to the run's model, and journals why, when the key or the host is missing", async () => {
    const llm = scriptedLlm([verdict("simp")]);
    const { decide, recorded, externals } = rig({ config: { backend: "jev" }, llm, unavailable: "the variable JEV_API_KEY is not set" });
    const d = await decide.decide(ORDER);
    assert.deepEqual([d.backend, d.requested, d.fallback], ["llm", "jev", "the variable JEV_API_KEY is not set"]);
    assert.equal(externals.length, 0);
    assert.equal(recorded[0]?.fallback, "the variable JEV_API_KEY is not set");
    assert.equal(recorded[0]?.requested, "jev");
  });

  it("falls back when the host cannot be reached or the call fails, never failing the run", async () => {
    const llm = scriptedLlm([verdict("simp")]);
    const { decide } = rig({ config: { backend: "jev" }, llm, fail: new Error("decide.ask: no implementation could be reached (jev: connect ECONNREFUSED)") });
    const d = await decide.decide(ORDER);
    assert.equal(d.backend, "llm");
    assert.match(d.fallback ?? "", /ECONNREFUSED/);
  });

  it("refuses a request of more than 32k tokens and lets the run's model decide", async () => {
    const llm = scriptedLlm([verdict("simp")]);
    const { decide, externals } = rig({ config: { backend: "jev" }, llm, external: jevAnswer() });
    const d = await decide.decide({ ...ORDER, state: "x".repeat(100_000) });
    assert.equal(d.backend, "llm");
    assert.match(d.fallback ?? "", /over the 32000 Jev takes: refused rather than sent in the slower, less accurate long-context mode/);
    assert.equal(externals.length, 0);
    // The run's model has no such limit, and a request just under it goes to Jev.
    const small = rig({ config: { backend: "jev" }, external: jevAnswer() });
    assert.equal((await small.decide.decide({ ...ORDER, state: "x".repeat(90_000) })).backend, "jev");
  });

  it("lets an interruption through instead of falling back", async () => {
    const llm = scriptedLlm([verdict("simp")]);
    const { decide, recorded } = rig({ config: { backend: "jev" }, llm, fail: new Paused() });
    await assert.rejects(decide.decide(ORDER), (error) => isInterrupted(error));
    assert.equal(recorded.length, 0, "nothing is journaled for a decision that was cut");
    assert.equal(llm.requests.length, 0, "and the model is not asked");
    const aborted = new AbortController();
    const stopped = rig({ config: { backend: "jev" }, llm, fail: new Error("aborted"), signal: aborted.signal });
    aborted.abort();
    await assert.rejects(stopped.decide.decide(ORDER), /aborted/);
  });

  it("answers with the faux backend like any other", async () => {
    const { decide, externals } = rig({ config: { backend: "faux" }, external: jevAnswer({ backend: "faux", model: "faux" }) });
    const d = await decide.decide(ORDER);
    assert.deepEqual([d.backend, externals[0]?.backend], ["faux", "faux"]);
  });
});

describe("interruptions and resumption", () => {
  it("stops before asking anything when the run is told to pause", async () => {
    const llm = scriptedLlm([verdict("simp")]);
    const { decide } = rig({ llm, interrupted: () => new Paused() });
    await assert.rejects(decide.decide(ORDER), (error) => isInterrupted(error));
    assert.equal(llm.requests.length, 0);
  });

  it("does not let the run's model's interruption become a failure of the decision", async () => {
    const llm = scriptedLlm([]);
    llm.complete = async () => {
      throw new Paused();
    };
    await assert.rejects(rig({ llm }).decide.decide(ORDER), (error) => isInterrupted(error));
  });

  it("answers a question the journal already holds from it, without asking or paying", async () => {
    const llm = scriptedLlm([verdict("omega")]);
    const first = rig({ llm });
    const a = await first.decide.decide(ORDER);
    const again = await first.decide.decide({ ...ORDER });
    assert.deepEqual([again.replayed, again.answer, again.costUsd, again.decisionId], [true, "omega", 0, a.decisionId]);
    assert.equal(llm.requests.length, 1);
    assert.equal(first.recorded.length, 1);
    // Another state is another question.
    assert.notEqual(decisionKey(ORDER), decisionKey({ ...ORDER, state: "other" }));
  });
});
