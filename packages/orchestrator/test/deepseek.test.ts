import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Api, createModels, createProvider, envApiKeyAuth, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type HostProfile, parseHostProfile } from "@seshat/registry";
import { messageCost } from "../src/budget.ts";
import { PriceBook } from "../src/prices.ts";
import { REPO_ROOT } from "../src/index.ts";

/**
 * DeepSeek's own API, as the shipped host profiles price it, against a fake server that answers in DeepSeek's shape: a
 * streamed `reasoning_content`, then the text, then a usage chunk with `prompt_cache_hit_tokens` and
 * `prompt_cache_miss_tokens`. The model is pi-ai's own catalog entry for the provider `deepseek`, with only its address
 * moved to the fake server, so the request is the one pi-ai would send to api.deepseek.com.
 */
class DeepSeekServer {
  readonly server = createServer((req, res) => void this.handle(req, res));
  readonly requests: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];

  async start(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: FLASH, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    send({ role: "assistant", content: null, reasoning_content: "Induction on n." });
    send({ content: "theorem t : True := trivial" });
    send({}, "stop");
    const usage = {
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      total_tokens: 1_100_000,
      prompt_cache_hit_tokens: 800_000,
      prompt_cache_miss_tokens: 200_000,
      completion_tokens_details: { reasoning_tokens: 60_000 },
    };
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: FLASH, choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}

const profile = (host: string): HostProfile => parseHostProfile(JSON.parse(readFileSync(join(REPO_ROOT, `config/hosts/${host}.json`), "utf8")), host);
/** The DeepSeek models the local profile prices, cheapest first (model identifiers are data of the host profile, not of the code). */
const DEEPSEEK = Object.entries(profile("local").models ?? {})
  .filter(([name]) => name.startsWith("deepseek/"))
  .sort(([, a], [, b]) => (a.pricing?.output ?? 0) - (b.pricing?.output ?? 0))
  .map(([name]) => name.slice("deepseek/".length));
const FLASH = DEEPSEEK[0] as string;
/** A Tuesday, at 02:30 UTC (peak) and at 12:00 UTC (off-peak), and a Saturday at 02:30 UTC (off-peak). */
const TUESDAY_PEAK = Date.UTC(2026, 10, 10, 2, 30);
const TUESDAY_NOON = Date.UTC(2026, 10, 10, 12, 0);
const SATURDAY = Date.UTC(2026, 10, 14, 2, 30);

describe("DeepSeek's own API", () => {
  const KEY = "SESHAT_TEST_DEEPSEEK_KEY";
  let fake: DeepSeekServer;
  let models: MutableModels;
  let model: Model<Api>;

  before(async () => {
    process.env[KEY] = "sk-test";
    fake = new DeepSeekServer();
    const baseUrl = await fake.start();
    const catalog = builtinModels().getModel("deepseek", FLASH);
    assert.ok(catalog, `pi-ai's catalog has deepseek/${FLASH}`);
    model = { ...catalog, baseUrl };
    models = createModels();
    models.setProvider(createProvider({ id: "deepseek", baseUrl, auth: { apiKey: envApiKeyAuth("deepseek", [KEY]) }, models: [model as Model<"openai-completions">], api: openAICompletionsApi() }));
  });
  after(() => {
    fake.server.close();
    delete process.env[KEY];
  });

  it("is a provider of pi-ai that reads DEEPSEEK_API_KEY, with both models the profiles price", async () => {
    const builtin = builtinModels();
    const saved = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test";
    try {
      const available = (await builtin.getAvailable("deepseek")).map((m) => m.id);
      assert.equal(DEEPSEEK.length, 2, "the profile prices two DeepSeek models");
      for (const id of DEEPSEEK) assert.ok(available.includes(id), `${id} among ${available.join(", ")}`);
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
    }
    for (const id of DEEPSEEK) {
      const m = builtin.getModel("deepseek", id);
      assert.ok(m, id);
      assert.equal(m.baseUrl, "https://api.deepseek.com");
      assert.equal(m.reasoning, true);
    }
  });

  it("sends a thinking request with the key, and keeps the reasoning out of the answer's text", async () => {
    fake.requests.length = 0;
    const message = await models.completeSimple(model, { systemPrompt: "You prove theorems.", messages: [{ role: "user", content: "Prove True.", timestamp: Date.now() }] }, { reasoning: "medium", maxTokens: 4096 });
    assert.equal(message.stopReason, "stop", message.errorMessage);
    const [request] = fake.requests;
    assert.equal(request?.headers.authorization, "Bearer sk-test");
    assert.equal(request?.body.model, FLASH);
    assert.deepEqual(request?.body.thinking, { type: "enabled" });
    assert.equal(request?.body.max_tokens, 4096, "DeepSeek's field for the answer's length");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    assert.equal(text, "theorem t : True := trivial");
    assert.ok(message.content.some((b) => b.type === "thinking"), "the reasoning is kept as thinking, to be sent back in a tool-call loop");
  });

  it("charges cache hits, misses and output at the shipped table's prices, and half of that off-peak", async () => {
    const message = await models.completeSimple(model, { messages: [{ role: "user", content: "Prove True.", timestamp: Date.now() }] }, { reasoning: "high" });
    assert.deepEqual([message.usage.cacheRead, message.usage.input, message.usage.output], [800_000, 200_000, 100_000]);
    for (const host of ["local", "server"]) {
      const at = (now: number) => messageCost(model, message, new PriceBook(profile(host).models, () => now));
      // Peak: 0.8M hits at $0.006, 0.2M misses at $0.3, 0.1M output at $1.2 per million.
      const peak = 0.8 * 0.006 + 0.2 * 0.3 + 0.1 * 1.2;
      const p = at(TUESDAY_PEAK);
      assert.ok(Math.abs(p.usd - peak) < 1e-9, `${host}: ${p.usd} at peak`);
      assert.equal(p.cachedInputTokens, 800_000);
      assert.ok(Math.abs((p.savedUsd ?? 0) - 0.8 * (0.3 - 0.006)) < 1e-9, "the cache saved the hits' miss price");
      assert.equal(p.offPeakUsd, undefined);
      for (const offPeak of [TUESDAY_NOON, SATURDAY]) {
        const o = at(offPeak);
        assert.ok(Math.abs(o.usd - peak / 2) < 1e-9, `${host}: ${o.usd} off-peak`);
        assert.ok(Math.abs((o.offPeakUsd ?? 0) - peak / 2) < 1e-9);
      }
    }
  });
});

describe("the shipped price tables", () => {
  it("name only models that pi-ai knows, at prices no lower than pi-ai's own at peak", () => {
    const builtin = builtinModels();
    for (const host of ["local", "server"]) {
      for (const [name, entry] of Object.entries(profile(host).models ?? {})) {
        const [provider, ...rest] = name.split("/");
        const m = builtin.getModel(provider as string, rest.join("/"));
        assert.ok(m, `${host}: ${name} is in pi-ai's catalog, so a run can resolve it`);
        const pricing = entry.pricing;
        assert.ok(pricing, `${host}: ${name} has prices`);
        assert.ok(pricing.cacheMiss >= m.cost.input && pricing.output >= m.cost.output && pricing.cacheHit >= m.cost.cacheRead, `${host}: ${name} is not cheaper than pi-ai's table`);
      }
    }
  });

  it("give DeepSeek's calendar: peak 01:00-04:00 and 06:00-10:00 UTC on weekdays, half price otherwise", () => {
    const book = new PriceBook(profile("local").models);
    const calendar = book.calendarOf(`deepseek/${FLASH}`);
    assert.deepEqual(calendar?.peak.map((w) => [w.from, w.to, w.days.join("")]), [
      ["01:00", "04:00", "12345"],
      ["06:00", "10:00", "12345"],
    ]);
    assert.equal(calendar?.offPeakMultiplier, 0.5);
    assert.equal(book.nextOffPeak(`deepseek/${FLASH}`, TUESDAY_PEAK), Date.UTC(2026, 10, 10, 4, 0));
    assert.equal(book.ignores(`deepseek/${FLASH}`, "temperature", "high"), true);
    assert.equal(book.ignores(`deepseek/${FLASH}`, "temperature", "off"), false);
  });
});
