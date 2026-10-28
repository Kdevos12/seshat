import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnavailableError } from "@seshat/registry";
import { DecisionTooLargeError, ForbiddenDecisionError, JevClient, type JevOptions } from "../src/index.ts";
import { fakeJev } from "./fake-jev.ts";
import { ORDER, RELEVANCE } from "./helpers.ts";

const options = (over: Partial<JevOptions> = {}): JevOptions => ({
  baseUrl: "https://openrouter.ai/api/alpha/",
  apiKey: "sk-test",
  model: "PROVIDER/jev-X.Y",
  allowedHosts: ["openrouter.ai"],
  ...over,
});
const signal = new AbortController().signal;

describe("the Jev client", () => {
  it("posts the state and the question to the Decisions endpoint with the pinned model and the key", async () => {
    const server = fakeJev();
    const out = await new JevClient({ ...options(), fetch: server.fetch }).decide(ORDER, signal);
    const [request] = server.seen;
    assert.equal(request?.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(request?.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(request?.body, {
      model: "PROVIDER/jev-X.Y",
      type: "choice",
      input: ORDER.state,
      instructions: "Which first?",
      options: { simp: "simp", omega: "omega", rfl: "rfl" },
    });
    assert.equal(out.backend, "jev");
    assert.equal(out.answer, "rfl");
    assert.equal(out.costUsd, 0.00013);
    assert.equal(out.inputTokens, 120);
    assert.ok(Math.abs(Object.values(out.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it("asks a score with its levels and a yes or no", async () => {
    const server = fakeJev();
    const client = new JevClient({ ...options(), fetch: server.fetch });
    assert.equal((await client.decide(RELEVANCE, signal)).answer, "high");
    const noul = await client.decide({ site: "conjecture.relevance", state: "s", question: { type: "noul", instructions: "Relevant?" } }, signal);
    assert.deepEqual([noul.answer, noul.probabilities.yes], [false, 0.3]);
    assert.deepEqual(server.seen[0]?.body.levels, ["low", "medium", "high"]);
  });

  it("is unavailable without a key, without a pinned model, and on a host the profile does not allow", () => {
    assert.throws(() => new JevClient(options({ apiKey: "" })), UnavailableError);
    assert.throws(() => new JevClient(options({ model: "latest" })), /pinned to a version/);
    assert.throws(() => new JevClient(options({ model: "PROVIDER/jev-latest" })), /pinned to a version/);
    assert.throws(() => new JevClient(options({ baseUrl: "https://example.org/api" })), /host example.org is not among the allowed hosts/);
    assert.throws(() => new JevClient(options({ allowedHosts: [] })), /allowed hosts of this profile \(none\)/);
    assert.throws(() => new JevClient(options({ baseUrl: "not a url" })), UnavailableError);
  });

  it("refuses a request over 32k tokens before sending it, and a forbidden site", async () => {
    const server = fakeJev();
    const client = new JevClient({ ...options(), fetch: server.fetch });
    await assert.rejects(client.decide({ ...ORDER, state: "∀".repeat(100_000) }, signal), DecisionTooLargeError);
    await assert.rejects(client.decide({ ...ORDER, site: "fidelity.review" }, signal), ForbiddenDecisionError);
    assert.equal(server.seen.length, 0);
  });

  it("reports a host that is down or busy as unavailable, and a refusal or a bad answer as a failure", async () => {
    const status = (code: number) => new JevClient({ ...options(), fetch: fakeJev(() => new Response("no", { status: code })).fetch });
    for (const code of [500, 503, 408, 429]) await assert.rejects(status(code).decide(ORDER, signal), UnavailableError, String(code));
    await assert.rejects(status(401).decide(ORDER, signal), (error) => !(error instanceof UnavailableError) && /HTTP 401/.test(String(error)));
    const down = new JevClient({ ...options(), fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    await assert.rejects(down.decide(ORDER, signal), /Jev at openrouter.ai: fetch failed/);
    const reply = (body: unknown) => new JevClient({ ...options(), fetch: fakeJev(() => Response.json(body)).fetch });
    await assert.rejects(reply({ answer: "simp" }).decide(ORDER, signal), /no distribution/);
    await assert.rejects(reply({ answer: "zzz", distribution: { simp: 1 }, usage: { cost: 0 } }).decide(ORDER, signal), /not one of the question's labels/);
    await assert.rejects(reply({ answer: "simp", distribution: { nope: 1 }, usage: { cost: 0 } }).decide(ORDER, signal), /not one of the question's labels/);
    await assert.rejects(reply({ answer: "simp", distribution: { simp: 1 } }).decide(ORDER, signal), /no usage.cost/);
    await assert.rejects(reply({ answer: "simp", distribution: { simp: 0 }, usage: { cost: 0 } }).decide(ORDER, signal), /all zero/);
  });

  it("normalizes a distribution that does not sum to 1 and fills missing labels with 0", async () => {
    const client = new JevClient({ ...options(), fetch: fakeJev(() => Response.json({ answer: "simp", distribution: { simp: 3, omega: 1 }, usage: { cost: 0 } })).fetch });
    const out = await client.decide(ORDER, signal);
    assert.deepEqual(out.probabilities, { simp: 0.75, omega: 0.25, rfl: 0 });
  });

  it("gives up after its time limit and when the caller aborts", async () => {
    const slow = new JevClient({ ...options({ timeoutMs: 20 }), fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    await assert.rejects(slow.decide(ORDER, signal), (error) => error instanceof UnavailableError && /no answer within 20 ms/.test(error.message));
  });
});
