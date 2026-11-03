import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ValidationReport } from "@seshat/core";
import { keepReasoning } from "../src/history.ts";
import { Ledger } from "../src/budget.ts";
import type { Workbench } from "../src/problem.ts";
import { runSession } from "../src/session.ts";

/**
 * A fake OpenAI-compatible server that thinks: each answer streams a `reasoning_content` and a tool call, and a
 * request that sends an assistant message with tool calls back without the reasoning it was answered with gets a
 * 400, as the provider's own API does in thinking mode.
 */
class ThinkingServer {
  readonly server: Server;
  readonly reasoningOf = new Map<string, string>();
  readonly requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  rejected = 0;
  private answered = 0;

  private readonly toolCalls: number;

  constructor(toolCalls: number) {
    this.toolCalls = toolCalls;
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  reset(): void {
    this.rejected = 0;
    this.answered = 0;
    this.requests.length = 0;
    this.reasoningOf.clear();
  }

  async start(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<Record<string, unknown>> };
    this.requests.push(body);
    for (const message of body.messages) {
      const calls = message.tool_calls as Array<{ id: string }> | undefined;
      if (message.role !== "assistant" || calls === undefined) continue;
      const expected = this.reasoningOf.get(calls[0]?.id ?? "");
      if (expected !== undefined && message.reasoning_content !== expected) {
        this.rejected += 1;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } }));
        return;
      }
    }
    const n = ++this.answered;
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (n <= this.toolCalls) {
      const id = `call_${n}`;
      this.reasoningOf.set(id, `reasoning number ${n}: try this proof`);
      send({ role: "assistant", reasoning_content: `reasoning number ${n}: try this proof` });
      send({ tool_calls: [{ index: 0, id, type: "function", function: { name: "lean_check", arguments: JSON.stringify({ aux: "", proof: `bad_${n}` }) } }] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", reasoning_content: "done thinking" });
      send({ content: "My notes." });
      send({}, "stop");
    }
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}

const REPORT: ValidationReport = {
  verdict: "invalid",
  method: "repl",
  reasons: [],
  axioms: [],
  messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "boom" }],
  sorries: [],
  checked: "theorem t : True := by\n  bad\n",
  submissionHash: "h",
  editsOutsideRegions: false,
  holes: false,
  leanStatus: "lean_error",
};
const workbench = { check: async () => ({ report: REPORT, accepted: false }) } as unknown as Workbench;

describe("the reasoning of a tool-call loop", () => {
  let fake: ThinkingServer;
  let models: MutableModels;
  let model: Model<"openai-completions">;
  const KEY = "FAKE_THINKING_KEY";

  before(async () => {
    process.env[KEY] = "k";
    fake = new ThinkingServer(2);
    const baseUrl = await fake.start();
    model = {
      id: "thinker",
      name: "thinker",
      api: "openai-completions",
      provider: "fakethinker",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    models = createModels();
    models.setProvider(createProvider({ id: "fakethinker", baseUrl, auth: { apiKey: envApiKeyAuth("fake", [KEY]) }, models: [model], api: openAICompletionsApi() }));
  });
  after(() => {
    fake.server.close();
    delete process.env[KEY];
  });

  const session = (rewriteHistory?: (messages: AgentMessage[]) => AgentMessage[]) =>
    runSession({
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
      ...(rewriteHistory !== undefined ? { rewriteHistory } : {}),
    });

  it("gets a 400 from the fake server when an assistant tool-call message goes back without its reasoning (the control)", async () => {
    fake.reset();
    fake.reasoningOf.set("call_1", "the reasoning it was answered with");
    const before = fake.rejected;
    const stripped = await models.completeSimple(
      model,
      {
        messages: [
          { role: "user", content: "Prove it.", timestamp: 1 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "lean_check", arguments: { aux: "", proof: "bad_1" } }], api: "openai-completions", provider: "fakethinker", model: "thinker", usage: ZERO, stopReason: "toolUse", timestamp: 2 },
          { role: "toolResult", toolCallId: "call_1", toolName: "lean_check", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 3 },
        ],
      },
      {},
    );
    assert.equal(stripped.stopReason, "error");
    assert.equal(fake.rejected, before + 1);
  });

  it("is sent back by a session that rewrites its history and drops the thinking: the harness puts it back", async () => {
    fake.reset();
    const strip = (messages: AgentMessage[]): AgentMessage[] =>
      messages.map((m) => ("role" in m && m.role === "assistant" ? { ...m, content: m.content.filter((c) => c.type !== "thinking") } : m));
    const result = await session(strip);
    assert.equal(fake.rejected, 0, "the provider took every request");
    assert.equal(result.stop, "model");
    assert.equal(result.notes, "My notes.");
    const last = fake.requests.at(-1)?.messages.filter((m) => m.role === "assistant") ?? [];
    assert.deepEqual(last.map((m) => m.reasoning_content), ["reasoning number 1: try this proof", "reasoning number 2: try this proof"]);
  });

  it("is sent back by a session that does not rewrite anything", async () => {
    fake.reset();
    assert.equal((await session()).stop, "model");
    assert.equal(fake.rejected, 0);
  });
});

describe("keepReasoning", () => {
  const thinking = { type: "thinking" as const, thinking: "why", thinkingSignature: "reasoning_content" };
  const call = (id: string) => ({ type: "toolCall" as const, id, name: "lean_check", arguments: {} });
  const assistant = (content: unknown[], timestamp: number): AgentMessage => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: ZERO, stopReason: "toolUse", timestamp }) as never;

  it("restores the thinking of a tool-call message by its tool-call id, and leaves other messages alone", () => {
    const original = [assistant([thinking, call("a")], 1), assistant([{ type: "text", text: "hi" }], 2)];
    const rebuilt = [assistant([call("a")], 99), assistant([{ type: "text", text: "hi" }], 2)];
    const out = keepReasoning(original, rebuilt) as Array<{ content: Array<{ type: string }> }>;
    assert.deepEqual(out[0]?.content.map((c) => c.type), ["thinking", "toolCall"]);
    assert.equal(out[1], rebuilt[1], "a message with no tool call is not touched");
  });

  it("keeps a message that already thinks, and one it cannot match", () => {
    const original = [assistant([thinking, call("a")], 1)];
    const thinks = assistant([{ ...thinking, thinking: "mine" }, call("a")], 5);
    const unknown = assistant([call("zzz")], 7);
    const out = keepReasoning(original, [thinks, unknown]);
    assert.equal(out[0], thinks);
    assert.equal(out[1], unknown);
  });
});

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
