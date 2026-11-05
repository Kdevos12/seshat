import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type HostProfile, interpolate, UnavailableError } from "@seshat/registry";
import { DecisionTooLargeError, ForbiddenDecisionError, JEV_UNREPORTED_COST_USD, JevClient, type JevOptions, jevOptionsFrom } from "../src/index.ts";
import { fakeJev } from "./fake-jev.ts";
import { ORDER, RELEVANCE } from "./helpers.ts";

const options = (over: Partial<JevOptions> = {}): JevOptions => ({
  baseUrl: "https://api.typesafe.ai/v1/",
  apiKey: "sk-test",
  model: "jev-0.0.0",
  allowedHosts: ["openrouter.ai", "api.typesafe.ai"],
  ...over,
});
const signal = new AbortController().signal;
const answers = (decision: unknown, usage: unknown = { input_tokens: 10, output_tokens: 1, cost: 0 }) => ({ model: "jev-0.0.0", answers: { decision }, usage });

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** The shipped local profile's settings for `jev`, with the environment given. */
function shippedSettings(env: Record<string, string>): Record<string, unknown> {
  const profile = JSON.parse(readFileSync(`${root}config/hosts/local.json`, "utf8")) as HostProfile;
  const settings = profile.capabilities["decide.ask"]?.settings?.jev;
  assert.ok(settings, "the local profile has settings for jev");
  return interpolate(settings, { dir: root, env }) as Record<string, unknown>;
}

describe("the Jev client", () => {
  it("does not follow a redirect: the state is never sent to a host that was not checked", async () => {
    let init: RequestInit | undefined;
    const client = new JevClient({ ...options(), fetch: async (_url, i) => ((init = i), Response.json(answers({ type: "choice", choice: "simp", probabilities: { simp: 1 }, confidence: 1 }))) });
    await client.decide(ORDER, signal);
    assert.equal(init?.redirect, "error");
  });

  it("posts the state and one question in the System One shape, with the pinned model and the key", async () => {
    const server = fakeJev();
    const out = await new JevClient({ ...options(), fetch: server.fetch }).decide(ORDER, signal);
    const [request] = server.seen;
    assert.equal(request?.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(request?.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(request?.body, {
      model: "jev-0.0.0",
      state: ORDER.state,
      questions: { decision: { type: "choice", instructions: "Which first?", criteria: { simp: "simp", omega: "omega", rfl: "rfl" } } },
    });
    assert.equal(out.backend, "jev");
    assert.equal(out.answer, "rfl");
    assert.equal(out.costUsd, 0.00013);
    assert.deepEqual([out.inputTokens, out.outputTokens], [120, 3]);
    assert.ok(Math.abs(Object.values(out.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it("asks a score with its levels as ordered criteria, reads probabilities keyed by position, and asks a noul with both criteria", async () => {
    const server = fakeJev();
    const client = new JevClient({ ...options(), fetch: server.fetch });
    const score = await client.decide(RELEVANCE, signal);
    assert.equal(score.answer, "high");
    assert.deepEqual(score.probabilities, { low: 0.15, medium: 0.15, high: 0.7 });
    assert.deepEqual(server.seen[0]?.body.questions, { decision: { type: "score", instructions: "How relevant?", criteria: ["low", "medium", "high"] } });
    const noul = await client.decide({ site: "conjecture.relevance", state: "s", question: { type: "noul", instructions: "Relevant?" }, use: "order" }, signal);
    assert.deepEqual([noul.answer, noul.probabilities.yes], [false, 0.3]);
    assert.deepEqual(server.seen[1]?.body.questions, { decision: { type: "noul", instructions: "Relevant?", criteria: { true: "yes", false: "no" } } });
  });

  it("reads a score keyed by level names, or with only a score, and refuses a level it does not know", async () => {
    const reply = (body: unknown) => new JevClient({ ...options(), fetch: fakeJev(() => Response.json(body)).fetch });
    assert.equal((await reply(answers({ type: "score", score: 0.2, probabilities: { low: 0.8, high: 0.2 }, confidence: 0.5 })).decide(RELEVANCE, signal)).answer, "low");
    await assert.rejects(reply(answers({ type: "score", score: 1.4, confidence: 0.5 })).decide(RELEVANCE, signal), /no probabilities/, "a bare score is not guessed into a level");
    await assert.rejects(reply(answers({ type: "score", score: 1, probabilities: { "7": 1 }, confidence: 0.5 })).decide(RELEVANCE, signal), /not one of the question's levels/);
    await assert.rejects(reply(answers({ type: "score", score: 1, probabilities: { "0": 0.5, low: 0.5 }, confidence: 0.5 })).decide(RELEVANCE, signal), /two probabilities/);
    // With a legend, a key is read through it, and the legend must agree with the question's order.
    const named = { type: "score", score: 1, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, legend: { "0": "low", "1": "medium", "2": "high" }, confidence: 0.5 };
    assert.equal((await reply(answers(named)).decide(RELEVANCE, signal)).answer, "high");
    await assert.rejects(reply(answers({ ...named, legend: { "0": "high", "1": "medium", "2": "low" } })).decide(RELEVANCE, signal), /not where the question has it/);
  });

  it("charges the reported cost; without one, the tokens at the profile's price; without either, the conservative estimate", async () => {
    const choice = { type: "choice", choice: "simp", probabilities: { simp: 1 }, confidence: 1 };
    const reply = (usage: unknown, over: Partial<JevOptions> = {}) => new JevClient({ ...options(over), fetch: fakeJev(() => Response.json(answers(choice, usage))).fetch });
    assert.equal((await reply({ input_tokens: 428, output_tokens: 73, cost: 0.5 }).decide(ORDER, signal)).costUsd, 0.5);
    // TypeSafe's own API: tokens and no cost; output tokens are free.
    const priced = await reply({ input_tokens: 428, output_tokens: 73 }, { inputUsdPerMillion: 0.042 }).decide(ORDER, signal);
    assert.ok(Math.abs(priced.costUsd - (428 * 0.042) / 1e6) < 1e-15);
    assert.equal((await reply({ input_tokens: 428, output_tokens: 73 }).decide(ORDER, signal)).costUsd, JEV_UNREPORTED_COST_USD);
    assert.equal((await reply(null, { inputUsdPerMillion: 0.042 }).decide(ORDER, signal)).costUsd, JEV_UNREPORTED_COST_USD);
  });

  it("is unavailable without a key, without a pinned model, off https, and on a host the profile does not allow", () => {
    assert.throws(() => new JevClient(options({ apiKey: "" })), UnavailableError);
    assert.throws(() => new JevClient(options({ apiKey: "", provider: "openrouter" })), /JEV_API_KEY or OPENROUTER_API_KEY/);
    for (const model of ["latest", "jev-latest", "jev-preview", "~typesafe/jev-latest", "PROVIDER/jev-latest", "", "jev", "typesafe/jev", "~typesafe/jev"]) {
      assert.throws(() => new JevClient(options({ model })), /pinned to a version/, model);
    }
    assert.throws(() => new JevClient(options({ baseUrl: "http://api.typesafe.ai/v1" })), /not https/);
    assert.throws(() => new JevClient(options({ apiKey: "sk-or-v1-abc" })), /OpenRouter key, and the address is api.typesafe.ai/);
    assert.doesNotThrow(() => new JevClient(options({ apiKey: "sk-or-v1-abc", baseUrl: "https://openrouter.ai/api/alpha" })));
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
    const status = (code: number, body = "no") => new JevClient({ ...options(), fetch: fakeJev(() => new Response(body, { status: code })).fetch });
    for (const code of [500, 503, 408, 429]) await assert.rejects(status(code).decide(ORDER, signal), UnavailableError, String(code));
    await assert.rejects(status(401).decide(ORDER, signal), (error) => !(error instanceof UnavailableError) && /HTTP 401/.test(String(error)));
    // OpenRouter's error body: its message is kept, short, in the failure.
    await assert.rejects(status(402, JSON.stringify({ error: { code: 402, message: "Insufficient credits" } })).decide(ORDER, signal), /HTTP 402 \(Insufficient credits\)/);
    // A body that echoes the key does not carry it into the message, which the journal keeps.
    await assert.rejects(status(400, JSON.stringify({ detail: "bad header Bearer sk-test" })).decide(ORDER, signal), (error) => /Bearer \[key\]/.test(String(error)) && !String(error).includes("sk-test"));
    const down = new JevClient({ ...options(), fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    await assert.rejects(down.decide(ORDER, signal), /Jev at api.typesafe.ai: fetch failed/);
    const reply = (body: unknown) => new JevClient({ ...options(), fetch: fakeJev(() => Response.json(body)).fetch });
    await assert.rejects(reply({ model: "m" }).decide(ORDER, signal), /has no answers/);
    await assert.rejects(reply({ answers: { other: {} } }).decide(ORDER, signal), /no answer for decision/);
    await assert.rejects(reply(answers({ type: "noul", noul: 0.5 })).decide(ORDER, signal), /answered a noul to a choice/);
    await assert.rejects(reply(answers({ type: "choice", choice: "simp" })).decide(ORDER, signal), /no probabilities/);
    await assert.rejects(reply(answers({ type: "choice", choice: "zzz", probabilities: { simp: 1 } })).decide(ORDER, signal), /not one of the question's labels/);
    await assert.rejects(reply(answers({ type: "choice", choice: "simp", probabilities: { nope: 1 } })).decide(ORDER, signal), /not one of the question's labels/);
    await assert.rejects(reply(answers({ type: "choice", choice: "simp", probabilities: { simp: 0 } })).decide(ORDER, signal), /all zero/);
    const noul = { site: "conjecture.relevance", state: "s", question: { type: "noul" as const, instructions: "Relevant?" }, use: "order" as const };
    await assert.rejects(reply(answers({ type: "noul", noul: 1.5 })).decide(noul, signal), /not a probability/);
  });

  it("normalizes a distribution that does not sum to 1 and fills missing labels with 0", async () => {
    const client = new JevClient({ ...options(), fetch: fakeJev(() => Response.json(answers({ type: "choice", choice: "simp", probabilities: { simp: 3, omega: 1 }, confidence: 0.5 }))).fetch });
    const out = await client.decide(ORDER, signal);
    assert.deepEqual(out.probabilities, { simp: 0.75, omega: 0.25, rfl: 0 });
  });

  it("gives up after its time limit and when the caller aborts", async () => {
    const slow = new JevClient({ ...options({ timeoutMs: 20 }), fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    await assert.rejects(slow.decide(ORDER, signal), (error) => error instanceof UnavailableError && /no answer within 20 ms/.test(error.message));
  });
});

describe("the shipped profile's two providers of Jev", () => {
  it("defaults to OpenRouter's Decisions endpoint with its pinned model, its price, and OPENROUTER_API_KEY", async () => {
    const o = jevOptionsFrom(shippedSettings({ OPENROUTER_API_KEY: "sk-or" }));
    assert.equal(o.provider, "openrouter");
    assert.equal(o.apiKey, "sk-or");
    assert.equal(o.inputUsdPerMillion, 0.042);
    const server = fakeJev();
    const client = new JevClient({ ...o, fetch: server.fetch });
    assert.equal(client.url, "https://openrouter.ai/api/alpha/decisions");
    await client.decide(ORDER, signal);
    assert.match(String(server.seen[0]?.body.model), /^typesafe\/jev-\d/);
  });

  it("switches to TypeSafe's own System One API with JEV_PROVIDER=typesafe and TYPESAFE_API_KEY", () => {
    const o = jevOptionsFrom(shippedSettings({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "sk-ts", OPENROUTER_API_KEY: "sk-or" }));
    const client = new JevClient(o);
    assert.equal(client.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(o.apiKey, "sk-ts");
    assert.match(o.model, /^jev-\d+\.\d+\.\d+$/);
  });

  it("lets JEV_MODEL, JEV_BASE_URL and JEV_PATH replace the preset's, and JEV_API_KEY stand for a provider's own key", () => {
    const o = jevOptionsFrom(shippedSettings({ JEV_PROVIDER: "typesafe", JEV_API_KEY: "sk-own", JEV_MODEL: "jev-9.9.9", JEV_BASE_URL: "https://openrouter.ai/api/v1" }));
    assert.deepEqual([o.apiKey, o.model, o.baseUrl, o.path], ["sk-own", "jev-9.9.9", "https://openrouter.ai/api/v1", "/systemone"]);
    assert.equal(jevOptionsFrom(shippedSettings({ JEV_PATH: "/systemone", JEV_BASE_URL: "https://openrouter.ai/api/v1", JEV_API_KEY: "k" })).path, "/systemone");
    // The provider's own variable wins, so switching JEV_PROVIDER never sends the other company's key.
    assert.equal(jevOptionsFrom(shippedSettings({ JEV_PROVIDER: "typesafe", JEV_API_KEY: "sk-or-v1-x", TYPESAFE_API_KEY: "sk-ts" })).apiKey, "sk-ts");
  });

  it("is unavailable, naming the variables, without a key, and for a provider the profile does not have", () => {
    assert.throws(() => new JevClient(jevOptionsFrom(shippedSettings({}))), /JEV_API_KEY or OPENROUTER_API_KEY/);
    assert.throws(() => new JevClient(jevOptionsFrom(shippedSettings({ JEV_PROVIDER: "typesafe" }))), /JEV_API_KEY or TYPESAFE_API_KEY/);
    assert.throws(() => jevOptionsFrom(shippedSettings({ JEV_PROVIDER: "elsewhere", JEV_API_KEY: "k" })), /"elsewhere" \(JEV_PROVIDER\) is not one of this profile's: openrouter, typesafe/);
  });
});
