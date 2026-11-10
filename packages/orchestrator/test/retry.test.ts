import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type AssistantMessage, createModels, createProvider, envApiKeyAuth, fauxAssistantMessage, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { TokenCost, ValidationReport } from "@seshat/core";
import { Ledger } from "../src/budget.ts";
import type { Workbench } from "../src/problem.ts";
import { isTransient, type RequestRetry, type RetryPolicy } from "../src/retry.ts";
import { runSession, type SessionOptions } from "../src/session.ts";
import { check, demoRun, ofType } from "./m0-helpers.ts";

/**
 * A fake OpenAI-compatible server in DeepSeek's shape, whose first `cuts` answers stream a status 200, a reasoning
 * chunk and the start of a tool call, then close the socket in the middle of the body: what undici reports as
 * `terminated`, as in the first real run. `status` answers every request with that HTTP error instead.
 */
class CuttingServer {
  readonly server: Server;
  readonly bodies: string[] = [];
  cuts = 0;
  status: number | undefined;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  reset(cuts: number, status?: number): void {
    this.cuts = cuts;
    this.status = status;
    this.bodies.length = 0;
  }

  async start(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.bodies.push(Buffer.concat(chunks).toString("utf8"));
    if (this.status !== undefined) {
      res.writeHead(this.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This model's maximum length is 65536 tokens; you asked for 75000 tokens." } }));
      return;
    }
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    send({ role: "assistant", reasoning_content: "Thinking about the proof." });
    if (this.cuts > 0) {
      this.cuts -= 1;
      send({ tool_calls: [{ index: 0, id: "call_cut", type: "function", function: { name: "lean_check", arguments: "{\"aux\": \"" } }] });
      // Let the chunks reach the client, then cut the connection mid-body.
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.socket?.destroy();
      return;
    }
    send({ content: "My notes." });
    send({}, "stop");
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}

const REPORT: ValidationReport = {
  verdict: "invalid",
  method: "repl",
  reasons: [],
  axioms: [],
  messages: [],
  sorries: [],
  checked: "",
  submissionHash: "h",
  editsOutsideRegions: false,
  holes: false,
  leanStatus: "lean_error",
};
const workbench = { check: async () => ({ report: REPORT, accepted: false }) } as unknown as Workbench;
const FAST: RetryPolicy = { retries: 3, baseDelayMs: 5, maxDelayMs: 20 };

function failed(errorMessage: string): AssistantMessage {
  return fauxAssistantMessage([], { stopReason: "error", errorMessage });
}

describe("transient errors", () => {
  it("are a cut stream, a reset or refused connection, a 5xx and a 429, not the request's own errors", () => {
    for (const text of ["terminated", "fetch failed", "read ECONNRESET", "connect ECONNREFUSED 127.0.0.1:443", "socket hang up", "Connection error.", "503 Service Unavailable", "429 Rate limit reached", "502: bad gateway"]) {
      assert.ok(isTransient(failed(text)), text);
    }
    for (const text of [
      "400 This model's maximum context length is 65536 tokens; you requested 75000 tokens",
      "401 Authentication Fails, Your api key is invalid",
      "402 Insufficient Balance",
      "422 Invalid tool arguments",
      "insufficient_quota: you exceeded your quota",
      "prompt is too long: 250000 tokens > 200000 maximum",
    ]) {
      assert.ok(!isTransient(failed(text)), text);
    }
    assert.ok(!isTransient(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "terminated" })), "an abort is never sent again");
  });
});

describe("a session whose response a transient error cuts", () => {
  let fake: CuttingServer;
  let models: MutableModels;
  let model: Model<"openai-completions">;
  const KEY = "FAKE_CUTTING_KEY";

  before(async () => {
    process.env[KEY] = "k";
    fake = new CuttingServer();
    const baseUrl = await fake.start();
    model = {
      id: "cutter",
      name: "cutter",
      api: "openai-completions",
      provider: "fakecutter",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    models = createModels();
    models.setProvider(createProvider({ id: "fakecutter", baseUrl, auth: { apiKey: envApiKeyAuth("fake", [KEY]) }, models: [model], api: openAICompletionsApi() }));
  });
  after(() => {
    fake.server.close();
    delete process.env[KEY];
  });

  const session = (extra: Partial<SessionOptions> = {}) => {
    const charges: Array<{ cost: TokenCost; retry: RequestRetry | undefined }> = [];
    const result = runSession({
      models,
      model,
      thinkingLevel: "high",
      systemPrompt: "You prove theorems.",
      prompt: "Prove it.",
      workbench,
      attemptId: "att_x",
      actor: "prover:p1",
      limits: { turns: 10, contextTokens: 100_000 },
      ledger: new Ledger(),
      signal: new AbortController().signal,
      wrapUp: false,
      retry: FAST,
      onCharge: (cost, retry) => charges.push({ cost, retry }),
      ...extra,
    });
    return { result, charges };
  };

  it("sends the request again with the same body, and goes on with the answer", async () => {
    fake.reset(1);
    const { result: pending, charges } = session();
    const result = await pending;
    assert.equal(result.stop, "model", result.error);
    assert.equal(result.notes, "My notes.");
    assert.equal(result.retries, 1);
    assert.equal(result.turns, 1, "the cut response is no turn");
    assert.equal(fake.bodies.length, 2);
    assert.equal(fake.bodies[1], fake.bodies[0], "the same request, so that the provider's cache answers it");
    assert.deepEqual(charges.map((c) => c.retry), [{ retry: 1, error: "terminated", delayMs: 5 }, undefined], "the cut response is charged with its retry, then the answer");
    assert.equal(result.cost.inputTokens, 1000, "the provider reported nothing of the cut response: it is charged nothing");
    const assistants = result.messages.filter((m) => "role" in m && m.role === "assistant") as AssistantMessage[];
    assert.equal(assistants.length, 1, "the cut response is not in the history");
    assert.ok(!assistants[0]?.content.some((c) => c.type === "toolCall"), "nothing of the cut response is left in the answer");
  });

  it("gives up after the policy's retries, with the error and the number of sends", async () => {
    fake.reset(10);
    const { result: pending, charges } = session();
    const result = await pending;
    assert.equal(result.stop, "error");
    assert.equal(fake.bodies.length, 4);
    assert.equal(result.retries, 3);
    assert.match(result.error ?? "", /^terminated \(the request was sent 4 times\)$/);
    assert.deepEqual(charges.map((c) => c.retry?.delayMs), [5, 10, 20, undefined], "the waits double, up to the cap; the last cut is charged as the answer");
  });

  it("does not send again a request the server refused for itself (a 400)", async () => {
    fake.reset(0, 400);
    const { result: pending } = session();
    const result = await pending;
    assert.equal(result.stop, "error");
    assert.equal(fake.bodies.length, 1);
    assert.equal(result.retries, undefined);
  });

  it("sends a 5xx again", async () => {
    fake.reset(0, 503);
    const { result: pending } = session({ retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const result = await pending;
    assert.equal(result.stop, "error");
    assert.equal(fake.bodies.length, 2);
  });

  it("does not send again once the budget is spent", async () => {
    fake.reset(1);
    const { result: pending } = session({ ledger: new Ledger(0) });
    const result = await pending;
    assert.equal(fake.bodies.length, 1);
    assert.equal(result.stop, "budget");
    assert.equal(result.retries, undefined);
  });

  it("stops waiting when the problem is stopped, and charges nothing for the wait", async () => {
    fake.reset(1);
    const stop = new AbortController();
    const { result: pending, charges } = session({ signal: stop.signal, retry: { retries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 } });
    const timer = setTimeout(() => stop.abort("stopped"), 300);
    const started = Date.now();
    const result = await pending;
    clearTimeout(timer);
    assert.ok(Date.now() - started < 10_000, "the wait was cut");
    assert.equal(result.stop, "aborted");
    assert.equal(fake.bodies.length, 1);
    assert.equal(result.turns, 0);
    assert.equal(charges.length, 1, "the cut response, charged when it was to be sent again; the wait is no response");
  });
});

describe("a run whose model request a transient error cuts", () => {
  it("sends it again, records the retry in the journal and the report, and finds the proof", async () => {
    const { result, events, dir } = await demoRun({ responses: [failed("terminated"), check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const [attempt] = ofType(events, "attempt.finished");
    assert.deepEqual([attempt?.data.outcome, attempt?.data.stoppedBy, attempt?.data.turns, attempt?.data.retries], ["valid", "solved", 1, 1]);
    const charged = ofType(events, "attempt.charged");
    assert.deepEqual(charged.map((c) => c.data.retry), [{ retry: 1, error: "terminated", delayMs: 2_000 }, undefined]);
    const sum = charged.reduce((total, c) => total + c.data.usd, 0);
    assert.ok(Math.abs((attempt?.data.usd ?? 0) - sum) < 1e-12, "the attempt's totals are the sum of its charges, the cut response's included");
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { retries?: { requests: number; attempts: number } };
    assert.deepEqual([report.retries?.requests, report.retries?.attempts], [1, 1]);
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /Requests sent again after a transient error .*: 1 in 1 attempt\(s\)/);
  });
});
