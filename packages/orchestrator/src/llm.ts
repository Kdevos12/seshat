import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type BlobStore, type Journal, newId, SITE } from "@seshat/core";
import { type LineId, type Llm, type LlmRequest, type LlmResult, withJson } from "@seshat/lines";
import { type Ledger, messageCost } from "./budget.ts";
import { type Turn, TurnEndedError } from "./turns.ts";

export interface LineLlmOptions {
  line: LineId;
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  /** `provider/id` of the run's model, the default. */
  model: string;
  /** Looks a `provider/id` up, with its credentials checked. */
  resolveModel: (name: string) => Promise<Model<Api>>;
  thinkingLevel: ThinkingLevel;
  /** The problem's ledger, charged with every call. */
  ledger: Ledger;
  problemId: string;
  signal: AbortSignal;
  /** The consortium turn, when the run has them: once it is over, no call is sent (documentation/human.md). */
  turn?: Turn;
}

/**
 * A line's one-shot model calls: each is charged to the problem's ledger and recorded as a
 * `model_call.finished` event from `line:<id>`, with its site, its request and response kept as
 * blobs. `completeJson` is made from `complete` (`withJson`), so a retry is a call like the first.
 */
export function lineLlm(o: LineLlmOptions): Llm {
  return withJson(async (request: LlmRequest): Promise<LlmResult> => {
    const over = o.turn?.ended;
    if (over !== undefined) throw new TurnEndedError(over);
    if (o.signal.aborted) throw new Error(`the problem has ended (${String(o.signal.reason)}): no more model calls`);
    if (o.ledger.exhausted) throw new Error("the problem's budget is spent: no more model calls");
    // Checked before the call is paid for: the journal refuses a site that is not a dotted lowercase name.
    const site = request.site ?? `${o.line.toLowerCase()}.unlabeled`;
    if (!SITE.test(site)) throw new Error(`line ${o.line}: ${JSON.stringify(site)} is not a site: use dotted lowercase words such as graph.attempt`);
    const name = request.model ?? o.model;
    const model = await o.resolveModel(name);
    const requestHash = o.blobs.putJson({
      model: name,
      system: request.system ?? null,
      prompt: request.prompt,
      maxTokens: request.maxTokens ?? null,
    });
    const modelCallId = newId("mc");
    const started = performance.now();
    const options: SimpleStreamOptions = {
      signal: o.signal,
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(o.thinkingLevel !== "off" ? { reasoning: o.thinkingLevel as NonNullable<SimpleStreamOptions["reasoning"]> } : {}),
    };
    const message = await o.models.completeSimple(
      model,
      {
        ...(request.system !== undefined ? { systemPrompt: request.system } : {}),
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      },
      options,
    );
    const cost = messageCost(model, message);
    o.ledger.charge(cost);
    const outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok";
    const text = textOf(message);
    const error = outcome === "ok" ? undefined : (message.errorMessage ?? `the model's answer was ${outcome}`);
    o.journal.emit(
      "model_call.finished",
      {
        modelCallId,
        line: o.line,
        problemId: o.problemId,
        model: name,
        outcome,
        site,
        requestHash,
        ...(outcome === "ok" ? { responseHash: o.blobs.put(text) } : {}),
        ...(error !== undefined ? { error: error.slice(0, 1000) } : {}),
        durationMs: Math.round(performance.now() - started),
        usd: cost.usd,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        ...(cost.cachedInputTokens !== undefined ? { cachedInputTokens: cost.cachedInputTokens } : {}),
      },
      `line:${o.line}`,
    );
    if (error !== undefined) throw new Error(`the model call failed: ${error}`);
    return { text, cost, model: name, modelCallId };
  });
}

/** The text of an answer, without its thinking. */
function textOf(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}
