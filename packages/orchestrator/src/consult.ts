import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Api, type Model, type Models, type SimpleStreamOptions, Type } from "@earendil-works/pi-ai";
import { estimateTokens } from "@seshat/context";
import { type BlobStore, type Journal, newId, SITE } from "@seshat/core";
import { type Ledger, messageCost } from "./budget.ts";
import type { PriceBook } from "./prices.ts";
import type { Turn } from "./turns.ts";

/**
 * `RunConfig.consult` (plan change NL3, documentation/models-setup.md, "Consult"): the outer prover may put one question, as text, to another
 * configured model. Off unless a run is configured with it; no defaults set and no arm turns it on.
 */
export interface ConsultConfig {
  /** `provider/id`, resolved like the run's model. */
  model: string;
  /** Calls per prover session. Default `DEFAULT_CONSULT_CALLS`. */
  maxCalls?: number;
  /** The most tokens of an answer. Default `DEFAULT_CONSULT_TOKENS`. */
  maxOutputTokens?: number;
}

export const DEFAULT_CONSULT_CALLS = 2;
export const DEFAULT_CONSULT_TOKENS = 1000;

/** The site of the consult call in the journal. */
export const SITE_CONSULT = "consult";

/** What the tool is called, and says of itself. */
export const CONSULT_TOOL = "consult";
export const CONSULT_DESCRIPTION =
  "Ask one question, as text, to another model. Advice from another model; only Lean decides: its answer is text in your context, it is not checked, " +
  "and it changes no claim and no status. Use it for an idea or a name to look for, not for a proof to paste: send what you need to know, with the statement or " +
  "the goal it is about. The number of calls in a session is small.";

const SYSTEM = "You advise a prover who is working on a Lean 4 proof and has one question. Answer in plain text, briefly and to the point. If you are not sure, say so. You have no tools; Lean, not you, decides whether a proof is right.";
/** The characters of a question sent, and of an answer returned to the prover. */
const QUESTION_CHARS = 6000;
const ANSWER_CHARS = 6000;

export interface ConsultToolOptions {
  config: ConsultConfig;
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  /** Looks `config.model` up, with its credentials checked. */
  resolveModel: (name: string) => Promise<Model<Api>>;
  /** The problem's ledger: the call is charged to it, and refused when it would not fit. */
  ledger: Ledger;
  problemId: string;
  /** The attempt the calls belong to (kept in the request's blob), and the actor of its session: the journal's actor of the call. */
  attemptId: string;
  actor: string;
  signal: AbortSignal;
  prices?: PriceBook;
  turn?: Turn;
}

/** The most dollars a call may cost: the question and the system prompt as input at the full input price, and `maxOutputTokens` of output. */
export function consultEstimateUsd(model: Model<Api>, prices: PriceBook | undefined, inputTokens: number, outputTokens: number): number {
  const pricing = prices?.pricingOf(model);
  const input = pricing !== undefined ? pricing.cacheMiss : model.cost.input;
  const output = pricing !== undefined ? pricing.output : model.cost.output;
  // The off-peak multiplier only lowers a price: the full one is the bound.
  return (inputTokens * input + outputTokens * output) / 1e6;
}

/**
 * The tool `consult(question)` of one prover session. A call is one model call: refused, as an error the model reads, when the session has made
 * `maxCalls` of them, when the turn is over or the problem's budget is spent, or when its largest possible cost would not fit in what the problem's
 * ledger has left (the check the session makes before it resends a cut response). Otherwise it is charged to the problem's ledger at the model's
 * price (the host's table when it has one) and journaled as a `model_call.finished` at the site `consult`, from the prover's actor, with the problem and no
 * attempt (the cost is in the problem's totals, not the session's); the request blob names the attempt. The answer is returned as text: nothing here
 * touches a claim, an edge or a status.
 */
export function consultTool(o: ConsultToolOptions): AgentTool<ReturnType<typeof parameters>, { calls: number; outcome: string }> {
  const maxCalls = o.config.maxCalls ?? DEFAULT_CONSULT_CALLS;
  const maxOutput = o.config.maxOutputTokens ?? DEFAULT_CONSULT_TOKENS;
  let calls = 0;
  const reply = (text: string, outcome: string, isError = false): AgentToolResult<{ calls: number; outcome: string }> => ({
    content: [{ type: "text", text }],
    details: { calls, outcome },
    ...(isError ? { isError: true } : {}),
  });
  return {
    name: CONSULT_TOOL,
    label: "Consult another model",
    description: CONSULT_DESCRIPTION,
    parameters: parameters(),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const question = String(params.question ?? "").trim().slice(0, QUESTION_CHARS);
      if (question === "") return reply("Error: ask a question.", "refused", true);
      if (calls >= maxCalls) return reply(`Error: consult is limited to ${maxCalls} call(s) in a session, and they are made.`, "limit", true);
      if (o.turn?.ended !== undefined || o.signal.aborted) return reply("Error: the turn or the problem is over: no more model calls.", "over", true);
      if (o.ledger.exhausted) return reply("Error: the problem's budget is spent: no more model calls.", "budget", true);
      const site = SITE_CONSULT;
      if (!SITE.test(site)) throw new Error(`${site} is not a site`);
      let model: Model<Api>;
      try {
        model = await o.resolveModel(o.config.model);
      } catch (error) {
        return reply(`Error: consult cannot reach its model (${error instanceof Error ? error.message : String(error)}).`, "unavailable", true);
      }
      const estimate = consultEstimateUsd(model, o.prices, estimateTokens(SYSTEM) + estimateTokens(question), maxOutput);
      if (o.ledger.wouldExhaust(estimate)) return reply("Error: the problem's budget does not have room for this call.", "budget", true);
      calls += 1;
      const modelCallId = newId("mc");
      const requestHash = o.blobs.putJson({ model: o.config.model, system: SYSTEM, prompt: question, maxTokens: maxOutput, attemptId: o.attemptId });
      const started = performance.now();
      const options: SimpleStreamOptions = { signal: o.signal, maxTokens: maxOutput };
      const message = await o.models.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: question, timestamp: Date.now() }] }, options);
      const cost = messageCost(model, message, o.prices);
      o.ledger.charge(cost);
      const outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok";
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
      const error = outcome === "ok" ? undefined : (message.errorMessage ?? `the model's answer was ${outcome}`);
      o.journal.emit(
        "model_call.finished",
        {
          modelCallId,
          line: "prover",
          problemId: o.problemId,
          model: o.config.model,
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
          ...(cost.savedUsd !== undefined ? { savedUsd: cost.savedUsd } : {}),
          ...(cost.offPeakUsd !== undefined ? { offPeakUsd: cost.offPeakUsd } : {}),
          ...(cost.unchargedUsd !== undefined ? { unchargedUsd: cost.unchargedUsd } : {}),
        },
        o.actor,
      );
      if (error !== undefined) return reply(`Error: the other model did not answer (${error}).`, outcome, true);
      const shown = text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS)}\n[cut at ${ANSWER_CHARS} characters]` : text;
      return reply(`Advice from ${o.config.model}; only Lean decides:\n${shown === "" ? "(no answer)" : shown}`, "ok");
    },
  };
}

function parameters() {
  return Type.Object({ question: Type.String({ description: "The question, with the statement or the goal it is about." }) });
}

/** The problems of a `consult` setting; empty when it is fine. */
export function checkConsult(config: ConsultConfig): string[] {
  const problems: string[] = [];
  if (typeof config.model !== "string" || !/^[^/\s]+\/\S+$/.test(config.model)) problems.push(`consult.model ${JSON.stringify(config.model)}: expected provider/id, as harness models lists them`);
  if (config.maxCalls !== undefined && !(Number.isInteger(config.maxCalls) && config.maxCalls >= 1)) problems.push("consult.maxCalls must be a whole number of at least 1");
  if (config.maxOutputTokens !== undefined && !(Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens >= 1)) problems.push("consult.maxOutputTokens must be a whole number of at least 1");
  return problems;
}
