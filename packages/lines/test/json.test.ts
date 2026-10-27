import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonSchema } from "@seshat/registry";
import { completeJson, JsonAnswerError, type Llm, type LlmRequest, type LlmResult, parseJsonAnswer, withJson } from "../src/index.ts";

const schema: JsonSchema = {
  type: "object",
  properties: { score: { type: "integer", minimum: 0, maximum: 10 }, why: { type: "string" } },
  required: ["score"],
  additionalProperties: false,
};

/** A `complete` that answers from a script, one text per call, and records the requests. */
function scripted(texts: Array<string | Error>) {
  const requests: LlmRequest[] = [];
  const complete = async (request: LlmRequest): Promise<LlmResult> => {
    requests.push(request);
    const next = texts[requests.length - 1];
    if (next === undefined) throw new Error("the script is over");
    if (next instanceof Error) throw next;
    return { text: next, cost: { usd: 0.25, inputTokens: 10, outputTokens: 2 }, model: "test/model", modelCallId: `mc_${requests.length}` };
  };
  return { llm: withJson(complete), requests };
}

describe("parseJsonAnswer", () => {
  it("finds the JSON in the ways a model writes it", () => {
    assert.deepEqual(parseJsonAnswer('{"score": 3}'), { ok: true, value: { score: 3 } });
    assert.deepEqual(parseJsonAnswer('  \n[1, 2]\n'), { ok: true, value: [1, 2] });
    assert.deepEqual(parseJsonAnswer('Here you go:\n```json\n{"score": 4}\n```\nHope it helps.'), { ok: true, value: { score: 4 } });
    assert.deepEqual(parseJsonAnswer('```\n{"score": 5}\n```'), { ok: true, value: { score: 5 } });
    assert.deepEqual(parseJsonAnswer('My answer is {"score": 6, "why": "x"} as asked.'), { ok: true, value: { score: 6, why: "x" } });
    assert.deepEqual(parseJsonAnswer("7"), { ok: true, value: 7 });
  });

  it("says why it found none", () => {
    for (const text of ["", "   ", "no json here", '{"score": ', "```json\nnot json\n```"]) {
      const answer = parseJsonAnswer(text);
      assert.equal(answer.ok, false, text);
      if (!answer.ok) assert.match(answer.error, /^the answer is (empty|not JSON: )/);
    }
  });
});

describe("completeJson", () => {
  it("returns an answer that matches in one call, and shows the model the schema", async () => {
    const { llm, requests } = scripted(['{"score": 7}']);
    const answer = await llm.completeJson<{ score: number }>({ system: "Rate it.", prompt: "How good is it?", schema, site: "test.rate", maxTokens: 100, model: "test/other" });
    assert.deepEqual(answer.value, { score: 7 });
    assert.deepEqual(answer.modelCallIds, ["mc_1"]);
    assert.equal(answer.modelCallId, "mc_1");
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.site, "test.rate");
    assert.equal(request?.system, "Rate it.");
    assert.equal(request?.maxTokens, 100);
    assert.equal(request?.model, "test/other");
    assert.ok(request?.prompt.startsWith("How good is it?"));
    assert.ok(request?.prompt.includes(JSON.stringify(schema)), "the schema is in the prompt");
    assert.equal("schema" in (request ?? {}), false, "the schema is not passed on as a field of the plain call");
  });

  it("asks once more when the answer is not JSON or does not match, saying what was wrong", async () => {
    for (const first of ["I think it is a seven.", '{"score": 11}', '{"score": 3, "extra": true}', '{"why": "no score"}']) {
      const { llm, requests } = scripted([first, '{"score": 3}']);
      const answer = await llm.completeJson({ prompt: "Rate it.", schema, site: "test.rate" });
      assert.deepEqual(answer.value, { score: 3 }, first);
      assert.equal(requests.length, 2);
      const retry = requests[1];
      assert.ok(retry?.prompt.includes(first), "the retry quotes the refused answer");
      assert.match(retry?.prompt ?? "", /It was refused: /);
      assert.equal(retry?.site, "test.rate", "the retry is made from the same site");
      assert.deepEqual(answer.modelCallIds, ["mc_1", "mc_2"]);
      assert.equal(answer.modelCallId, "mc_2");
      assert.equal(answer.text, '{"score": 3}');
      assert.deepEqual(answer.cost, { usd: 0.5, inputTokens: 20, outputTokens: 4 }, "the retry is paid for like the first call");
    }
  });

  it("fails clearly after the retry, and made exactly two calls", async () => {
    const { llm, requests } = scripted(["not json at all", '{"score": 99}', '{"score": 1}']);
    await assert.rejects(
      llm.completeJson({ prompt: "Rate it.", schema, site: "test.rate" }),
      (error: unknown) => {
        assert.ok(error instanceof JsonAnswerError);
        assert.match(error.message, /does not match the schema, after a retry: \$\.score: greater than 10/);
        assert.match(error.message, /first answer: the answer is not JSON/);
        assert.deepEqual(error.modelCallIds, ["mc_1", "mc_2"]);
        assert.equal(error.problems.length, 2);
        assert.equal(error.text, '{"score": 99}');
        return true;
      },
    );
    assert.equal(requests.length, 2, "one retry, not more");
  });

  it("does not retry a call that failed", async () => {
    const budget = new Error("the problem's budget is spent: no more model calls");
    const first = scripted([budget]);
    await assert.rejects(first.llm.completeJson({ prompt: "x", schema }), /budget is spent/);
    assert.equal(first.requests.length, 1);
    const second = scripted(["nope", budget]);
    await assert.rejects(second.llm.completeJson({ prompt: "x", schema }), /budget is spent/);
    assert.equal(second.requests.length, 2);
  });

  it("refuses a schema it cannot check before it spends anything", async () => {
    const { llm, requests } = scripted(['{"score": 1}']);
    await assert.rejects(llm.completeJson({ prompt: "x", schema: { type: "object", oneOf: [] } as unknown as JsonSchema }), /schema is not usable: .*unsupported keyword "oneOf"/);
    assert.equal(requests.length, 0);
  });

  it("keeps complete as it was", async () => {
    const { llm, requests } = scripted(["plain text"]);
    const answer = await llm.complete({ prompt: "Say something.", site: "test.say" });
    assert.equal(answer.text, "plain text");
    assert.equal(requests[0]?.prompt, "Say something.");
  });
});

describe("completeJson(llm, request), the function a line calls", () => {
  it("works on an Llm that only has complete, with the same single retry and the same site", async () => {
    // An Llm written before completeJson existed: a plain object with a complete, and no more.
    const requests: LlmRequest[] = [];
    const old: Llm = {
      complete: async (request) => {
        requests.push(request);
        return { text: requests.length === 1 ? "no idea" : '{"score": 2}', cost: { usd: 0.25, inputTokens: 10, outputTokens: 2 }, model: "test/model", modelCallId: `mc_${requests.length}` };
      },
    };
    assert.equal(old.completeJson, undefined);
    const answer = await completeJson<{ score: number }>(old, { prompt: "Rate it.", schema, site: "test.rate" });
    assert.deepEqual(answer.value, { score: 2 });
    assert.deepEqual(answer.modelCallIds, ["mc_1", "mc_2"], "the retry is a call like the first");
    assert.deepEqual(requests.map((r) => r.site), ["test.rate", "test.rate"]);
    assert.deepEqual(answer.cost, { usd: 0.5, inputTokens: 20, outputTokens: 4 });
    // A second failure rejects, as it does through withJson, after exactly two calls.
    requests.length = 0;
    const never: Llm = { complete: async (request) => (requests.push(request), { text: "still no", cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, model: "test/model", modelCallId: `mc_${requests.length}` }) };
    await assert.rejects(completeJson(never, { prompt: "Rate it.", schema }), JsonAnswerError);
    assert.equal(requests.length, 2);
  });

  it("keeps the this of a complete that is a method", async () => {
    class Counting implements Llm {
      calls = 0;
      async complete(request: LlmRequest): Promise<LlmResult> {
        this.calls += 1;
        return { text: '{"score": 1}', cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, model: "test/model", modelCallId: `mc_${this.calls}${request.site ?? ""}` };
      }
    }
    const llm = new Counting();
    const answer = await completeJson(llm, { prompt: "x", schema, site: "test.rate" });
    assert.deepEqual(answer.value, { score: 1 });
    assert.equal(llm.calls, 1);
  });

  it("uses the Llm's own completeJson when it has one, and leaves its complete alone", async () => {
    let asked: unknown;
    const own: Llm = {
      complete: async () => {
        throw new Error("complete must not be called");
      },
      completeJson: async <T,>(request: Parameters<NonNullable<Llm["completeJson"]>>[0]) => {
        asked = request;
        return { value: { score: 9 } as T, text: "own", cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, model: "test/own", modelCallId: "mc_own", modelCallIds: ["mc_own"] };
      },
    };
    const answer = await completeJson<{ score: number }>(own, { prompt: "Rate it.", schema, site: "test.rate" });
    assert.deepEqual(answer.value, { score: 9 });
    assert.equal((asked as { site: string }).site, "test.rate");
  });
});
