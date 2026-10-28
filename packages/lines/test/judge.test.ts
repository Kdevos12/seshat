import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTI_SYCOPHANCY, InterruptedError, isInterrupted, judge, type Llm, type LlmRequest, type LlmResult, withAntiSycophancy, withJson } from "../src/index.ts";

/** An `Llm` that answers from a script, one text (or error) per call, and records the requests. */
function scripted(texts: Array<string | Error>) {
  const requests: LlmRequest[] = [];
  const complete = async (request: LlmRequest): Promise<LlmResult> => {
    requests.push(request);
    const next = texts[requests.length - 1];
    if (next === undefined) throw new Error("the script is over");
    if (next instanceof Error) throw next;
    return { text: next, cost: { usd: 0.5, inputTokens: 10, outputTokens: 2 }, model: request.model ?? "run/model", modelCallId: `mc_${requests.length}` };
  };
  const llm: Llm = withJson(complete);
  return { llm, requests };
}

const verdict = (label: string, reason?: string) => JSON.stringify({ verdict: label, ...(reason !== undefined ? { reason } : {}) });
const score = (n: number) => JSON.stringify({ score: n });

describe("judge by label", () => {
  it("asks k independent calls and takes the majority", async () => {
    const { llm, requests } = scripted([verdict("faithful", "same quantifiers"), verdict("faithful"), verdict("unfaithful", "drops a hypothesis")]);
    const answer = await judge(llm, { prompt: "Does the formal statement say what the text says?", site: "test.fidelity", k: 3, options: ["faithful", "unfaithful"] });
    assert.equal(answer.result, "faithful");
    assert.equal(answer.disagreement, true, "one judge differs");
    assert.deepEqual(answer.votes.map((v) => v.value), ["faithful", "faithful", "unfaithful"]);
    assert.equal(answer.votes[0]?.reason, "same quantifiers");
    assert.equal(answer.asked, 3);
    assert.deepEqual(answer.failures, []);
    assert.equal(answer.cost.usd, 1.5);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => r.site === "test.fidelity"));
  });

  it("agrees when the votes are unanimous, and has no result without a strict majority", async () => {
    const unanimous = await judge(scripted([verdict("a"), verdict("a")]).llm, { prompt: "p", site: "test.x", k: 2, options: ["a", "b"] });
    assert.deepEqual([unanimous.result, unanimous.disagreement], ["a", false]);
    const split = await judge(scripted([verdict("a"), verdict("b")]).llm, { prompt: "p", site: "test.x", k: 2, options: ["a", "b"] });
    assert.deepEqual([split.result, split.disagreement], [undefined, true]);
  });

  it("gives every call the same prompt, with no other judge's answer in it, and the anti-sycophancy instruction first", async () => {
    const { llm, requests } = scripted([verdict("a", "because of X"), verdict("a", "because of Y"), verdict("b")]);
    await judge(llm, { prompt: "Judge this.", system: "You are a referee.", site: "test.x", k: 3, options: ["a", "b"] });
    const prompts = new Set(requests.map((r) => r.prompt));
    assert.equal(prompts.size, 1, "the calls do not differ: none sees another's verdict");
    assert.doesNotMatch([...prompts][0] ?? "", /because of/);
    for (const request of requests) {
      assert.ok(request.system?.startsWith(ANTI_SYCOPHANCY));
      assert.ok(request.system?.endsWith("You are a referee."));
    }
    assert.equal(withAntiSycophancy(), ANTI_SYCOPHANCY);
  });

  it("asks the models in turn when several are configured, and the run's model when none is", async () => {
    const some = scripted([verdict("a"), verdict("a"), verdict("a"), verdict("a")]);
    await judge(some.llm, { prompt: "p", site: "test.x", k: 4, models: ["p/one", "p/two", "p/three"], options: ["a", "b"] });
    assert.deepEqual(some.requests.map((r) => r.model), ["p/one", "p/two", "p/three", "p/one"]);
    const none = scripted([verdict("a")]);
    await judge(none.llm, { prompt: "p", site: "test.x", k: 1, options: ["a", "b"] });
    assert.equal(none.requests[0]?.model, undefined);
  });

  it("drops a call that fails, and rejects when none gives a vote", async () => {
    const partial = await judge(scripted([new Error("the model is down"), verdict("a")]).llm, { prompt: "p", site: "test.x", k: 2, options: ["a", "b"] });
    assert.deepEqual(partial.votes.map((v) => v.value), ["a"]);
    assert.equal(partial.asked, 2);
    assert.deepEqual(partial.failures, ["the model is down"]);
    assert.equal(partial.disagreement, false, "one vote cannot disagree with itself");
    await assert.rejects(judge(scripted([new Error("down"), new Error("still down")]).llm, { prompt: "p", site: "test.x", k: 2, options: ["a", "b"] }), /none of the 2 call\(s\) gave a vote: down; still down/);
  });

  it("refuses a label outside the options, through the schema, as completeJson does", async () => {
    // Two answers outside the options: the retry also fails, so the call gives no vote.
    await assert.rejects(judge(scripted([verdict("c"), verdict("c")]).llm, { prompt: "p", site: "test.x", k: 1, options: ["a", "b"] }), /none of the 1 call/);
    // A first answer outside the options is sent back once.
    const retried = scripted([verdict("c"), verdict("b")]);
    const answer = await judge(retried.llm, { prompt: "p", site: "test.x", k: 1, options: ["a", "b"] });
    assert.equal(answer.result, "b");
    assert.equal(retried.requests.length, 2);
  });

  it("refuses a bad request before any call", async () => {
    const { llm, requests } = scripted([]);
    await assert.rejects(judge(llm, { prompt: "p", site: "test.x", k: 0, options: ["a", "b"] }), /k must be a whole number from 1/);
    await assert.rejects(judge(llm, { prompt: "p", site: "test.x", k: 1, options: ["a"] }), /at least two options/);
    await assert.rejects(judge(llm, { prompt: "p", site: "test.x", k: 1, min: 1, max: 1 }), /max above min/);
    assert.equal(requests.length, 0);
  });
});

describe("judge by score", () => {
  it("takes the mean, and flags a spread over a share of the scale", async () => {
    const close = await judge(scripted([score(7), score(8), score(7.5)]).llm, { prompt: "p", site: "test.x", k: 3, min: 0, max: 10 });
    assert.equal(close.result, 7.5);
    assert.equal(close.disagreement, false);
    const far = await judge(scripted([score(2), score(9)]).llm, { prompt: "p", site: "test.x", k: 2, min: 0, max: 10 });
    assert.equal(far.result, 5.5);
    assert.equal(far.disagreement, true);
    // The share is a parameter: 0.8 of the scale tolerates a spread of 7.
    const lax = await judge(scripted([score(2), score(9)]).llm, { prompt: "p", site: "test.x", k: 2, min: 0, max: 10, spread: 0.8 });
    assert.equal(lax.disagreement, false);
  });

  it("asks for a number inside the scale", async () => {
    const { llm, requests } = scripted([score(11), score(4)]);
    const answer = await judge(llm, { prompt: "Rate it.", site: "test.x", k: 1, min: 0, max: 10 });
    assert.equal(answer.result, 4, "the first answer is above the scale and goes back once");
    assert.match(requests[0]?.prompt ?? "", /"maximum":10/);
  });
});

describe("judge under an interruption (the consortium turn is over)", () => {
  it("rejects with the interruption when a call is refused, asks no more, and returns no partial judgment", async () => {
    const { llm, requests } = scripted([verdict("a"), new InterruptedError("the turn is over"), verdict("a")]);
    await assert.rejects(judge(llm, { prompt: "p", site: "test.x", k: 3, options: ["a", "b"] }), (error: unknown) => isInterrupted(error));
    assert.equal(requests.length, 2, "the third call is not asked for");
    const { llm: scoring, requests: scored } = scripted([new InterruptedError("the turn is over")]);
    await assert.rejects(judge(scoring, { prompt: "p", site: "test.x", k: 2, min: 0, max: 1 }), (error: unknown) => isInterrupted(error));
    assert.equal(scored.length, 1);
  });

  it("still takes an ordinary failure of a call for a missing vote", async () => {
    const { llm } = scripted([verdict("a"), new Error("the model errs"), verdict("a")]);
    const answer = await judge(llm, { prompt: "p", site: "test.x", k: 3, options: ["a", "b"] });
    assert.equal(answer.votes.length, 2);
    assert.equal(answer.failures.length, 1);
  });
});
