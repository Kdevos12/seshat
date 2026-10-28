import type { TokenCost } from "@seshat/core";
import type { JsonSchema } from "@seshat/registry";
import { completeJson } from "./json.ts";
import type { Llm } from "./line.ts";

/**
 * The one instruction that every prompt which judges or reranks carries, and that a prover's prompt
 * for an open conjecture carries too (plan change PC10): a plain "be truthful, disagree when
 * warranted" instruction cut sycophancy on every model the source measured, and a dynamic gate did worse
 * on the smaller one. It is fixed text: no line words it its own way, and the guards' framing check
 * (documentation/guards.md) looks for this sentence. No prompt of the harness shows a model another
 * agent's verdict, which is what spreads sycophancy from one agent to another; where a prior on how
 * reliable an agent is wanted, it is the track record of its Lean-checked results in the journal.
 */
export const ANTI_SYCOPHANCY =
  "Be truthful. The statement may be false, and a counterexample is as valuable as a proof. " +
  "Do not defer to how the task is phrased: disagree when the evidence warrants it.";

/** A system prompt that starts with `ANTI_SYCOPHANCY`, followed by the caller's own, if any. */
export function withAntiSycophancy(system?: string): string {
  return system === undefined || system.trim() === "" ? ANTI_SYCOPHANCY : `${ANTI_SYCOPHANCY}\n\n${system}`;
}

/** What every judgment asks for. */
export interface JudgeRequest {
  /** What to judge, the same for each call. It must not contain another agent's verdict. */
  prompt: string;
  /** The caller's own system prompt; the judgment's calls start it with `ANTI_SYCOPHANCY`. */
  system?: string;
  /** Where the calls are made (`LlmRequest.site`), such as `conjecture.relevance`. */
  site: string;
  /** The number of independent calls (a whole number from 1). */
  k: number;
  /**
   * `PROVIDER/ID` models to ask, in turn: call `i` goes to `models[i % models.length]`, so that with
   * several models the votes are cross-model. Absent or empty: every call goes to the run's model.
   */
  models?: readonly string[];
  maxTokens?: number;
}

/** A judgment among labels: the answer of each call is one of `options`. */
export interface ChoiceRequest<T extends string> extends JudgeRequest {
  options: readonly T[];
}

/** A judgment by a number: the answer of each call is a number between `min` and `max`. */
export interface ScoreRequest extends JudgeRequest {
  min: number;
  max: number;
  /**
   * The spread of the votes, as a share of `max - min`, above which the judges disagree. Default 0.25.
   */
  spread?: number;
}

/** One call's answer. */
export interface Vote<V> {
  value: V;
  /** `provider/id` of the model that answered. */
  model: string;
  modelCallId: string;
  /** Its reason, when it gave one. */
  reason?: string;
}

export interface Judgment<V> {
  /** The votes that came back, in the order they were asked. */
  votes: Vote<V>[];
  /** Calls made, and why the ones that gave no vote did not (the model failed or its answer did not fit the schema twice). */
  asked: number;
  failures: string[];
  /** What the judges settle on: the majority label, or the mean; undefined when a choice has no strict majority. */
  result: V | undefined;
  /**
   * True when the votes do not all agree: a label that someone voted against, or numbers that spread
   * over more than `spread` of the scale. A caller treats it as a reason to escalate (a human
   * breakpoint with `--human`, otherwise the claim stays unsigned) and never as a verdict.
   */
  disagreement: boolean;
  /** The sum of the cost of the calls made. */
  cost: TokenCost;
}

const REASON = { type: "string", description: "One sentence: why." } satisfies JsonSchema;

function add(a: TokenCost, b: TokenCost): TokenCost {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  return {
    usd: a.usd + b.usd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

/** The votes' plurality, and the label it is, when it holds more than half of them. */
function majority<T extends string>(votes: readonly Vote<T>[]): T | undefined {
  const counts = new Map<T, number>();
  for (const vote of votes) counts.set(vote.value, (counts.get(vote.value) ?? 0) + 1);
  for (const [label, n] of counts) if (n * 2 > votes.length) return label;
  return undefined;
}

async function ask<V>(llm: Llm, request: JudgeRequest, schema: JsonSchema, read: (value: unknown) => { value: V; reason?: string }): Promise<Pick<Judgment<V>, "votes" | "asked" | "failures" | "cost">> {
  if (!Number.isInteger(request.k) || request.k < 1) throw new RangeError(`judge: k must be a whole number from 1, got ${request.k}`);
  const votes: Vote<V>[] = [];
  const failures: string[] = [];
  let cost: TokenCost = { usd: 0, inputTokens: 0, outputTokens: 0 };
  const models = request.models ?? [];
  // One call after another, so that the journal records them in the order they were asked, whatever a provider's concurrency.
  for (let i = 0; i < request.k; i++) {
    const model = models.length === 0 ? undefined : models[i % models.length];
    try {
      const answer = await completeJson(llm, {
        prompt: request.prompt,
        system: withAntiSycophancy(request.system),
        schema,
        site: request.site,
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      cost = add(cost, answer.cost);
      const { value, reason } = read(answer.value);
      votes.push({ value, model: answer.model, modelCallId: answer.modelCallId, ...(reason !== undefined ? { reason } : {}) });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (votes.length === 0) throw new Error(`judge: none of the ${request.k} call(s) gave a vote: ${failures.join("; ")}`);
  return { votes, asked: request.k, failures, cost };
}

/**
 * `k` independent calls, each asked to answer with one of `options`, and the majority of the answers
 * (plan change PC9; documentation/lines.md, "judge"). A call sees only the prompt: not the others'
 * answers (PC10). Used for informal judgments that Lean cannot decide (a conjecture's relevance, a
 * statement's fidelity, a rerank), never for anything Lean can, and what it returns never changes a
 * claim's status. A call that fails gives no vote; all failing rejects.
 */
export async function judge<T extends string>(llm: Llm, request: ChoiceRequest<T>): Promise<Judgment<T>>;
/** The same by a number: the result is the mean of the votes. */
export async function judge(llm: Llm, request: ScoreRequest): Promise<Judgment<number>>;
export async function judge<T extends string>(llm: Llm, request: ChoiceRequest<T> | ScoreRequest): Promise<Judgment<T> | Judgment<number>> {
  if ("options" in request) {
    if (request.options.length < 2) throw new RangeError("judge: a choice needs at least two options");
    const schema: JsonSchema = {
      type: "object",
      properties: { verdict: { type: "string", enum: [...request.options] }, reason: REASON },
      required: ["verdict"],
      additionalProperties: false,
    };
    const asked = await ask<T>(llm, request, schema, (value) => {
      const answer = value as { verdict: T; reason?: string };
      return { value: answer.verdict, ...(answer.reason !== undefined ? { reason: answer.reason } : {}) };
    });
    return { ...asked, result: majority(asked.votes), disagreement: new Set(asked.votes.map((vote) => vote.value)).size > 1 };
  }
  if (!(request.max > request.min)) throw new RangeError("judge: a score needs max above min");
  const schema: JsonSchema = {
    type: "object",
    properties: { score: { type: "number", minimum: request.min, maximum: request.max }, reason: REASON },
    required: ["score"],
    additionalProperties: false,
  };
  const asked = await ask<number>(llm, request, schema, (value) => {
    const answer = value as { score: number; reason?: string };
    return { value: answer.score, ...(answer.reason !== undefined ? { reason: answer.reason } : {}) };
  });
  const scores = asked.votes.map((vote) => vote.value);
  const mean = scores.reduce((total, n) => total + n, 0) / scores.length;
  const spread = request.spread ?? 0.25;
  return { ...asked, result: mean, disagreement: Math.max(...scores) - Math.min(...scores) > spread * (request.max - request.min) };
}
