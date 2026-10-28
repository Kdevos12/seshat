import { type DecisionBackend, type EventDataMap, hashJson, sha256Hex } from "@seshat/core";
import { type Decide, type Decision, type DecideRequest, isInterrupted, judge, type Llm } from "@seshat/lines";
import type { DecideAskInput, DecideAskOutput } from "./capability.ts";
import type { DecideConfig } from "./config.ts";
import { DecisionOffError } from "./errors.ts";
import { expectedLevel, normalize, topLabel } from "./distribution.ts";
import { checkRequest, JEV_MAX_TOKENS, labelsOf, renderPrompt, requestTokens } from "./question.ts";
import { DecisionTooLargeError } from "./errors.ts";

type Data = EventDataMap["decision.made"];

/** What `decision.made` holds that the caller of `record` has not got: the rest is added by the one that writes it. */
export type DecisionDraft = Omit<Data, "decisionId" | "line" | "problemId" | "claimId">;

/** What an external backend (Jev, the faux one) answered, and the records its call left. */
export interface ExternalAnswer {
  output: DecideAskOutput;
  toolRunId?: string;
  /** The `model_call.finished` events the call was recorded and charged as. */
  modelCallIds: string[];
}

export interface DecideDeps {
  config: DecideConfig;
  /** The problem's model calls (`ProblemContext.llm`): the `llm` backend and every fallback. */
  llm: Llm;
  /** Why the backend cannot answer here (no key, not offered by the host), or undefined. */
  unavailable(backend: "jev" | "faux"): Promise<string | undefined>;
  /** Calls the backend through the capability, records and charges the call. Rejects when it fails. */
  external(backend: "jev" | "faux", input: DecideAskInput, signal: AbortSignal): Promise<ExternalAnswer>;
  /** The decision the journal holds for a question of this problem. */
  find(key: string): Held | undefined;
  /** Keeps a JSON value in the blob store and returns its hash. */
  blob(value: unknown): string;
  /** Writes `decision.made`; returns its id. */
  record(draft: DecisionDraft): string;
  /** The error that tells the line to let the run pause (the consortium turn is over), or undefined. */
  interrupted(): Error | undefined;
  signal: AbortSignal;
  /** Whether a site has a reliability curve (plan change J4). Default: none has. */
  calibrated?(site: string): boolean;
}

/** A decision as the journal holds it, for the answer to a question asked again. */
export type Held = DecisionDraft & { decisionId: string };

/** The decision key: the same site, state and question are the same decision. */
export function decisionKey(request: DecideRequest): string {
  return hashJson({ site: request.site, state: request.state, question: request.question });
}

const VOTE_TOKENS = 400;

/**
 * `decide` for one problem (documentation/decide.md). The order of events: the request is checked
 * (the forbidden list), a question the journal already holds is answered from it, then the
 * configured backend answers, falling back to the run's model when Jev cannot (no key, host not
 * allowed or unreachable, over 32k tokens, a failure), and the decision is recorded.
 */
export function createDecide(deps: DecideDeps): Decide {
  const backendFor = (site: string): DecisionBackend | "off" => deps.config.sites[site] ?? deps.config.backend;

  const viaLlm = async (request: DecideRequest): Promise<{ output: DecideAskOutput; modelCallIds: string[] }> => {
    const labels = labelsOf(request.question);
    const judged = await judge(deps.llm, {
      prompt: renderPrompt(request),
      system: "You answer one question about the state you are given, with one of the labels offered.",
      site: request.site,
      k: deps.config.votes,
      options: labels,
      maxTokens: VOTE_TOKENS,
    });
    const counts = Object.fromEntries(labels.map((l) => [l, judged.votes.filter((v) => v.value === l).length]));
    const answered = normalize(request.question, topLabel(labels, counts), counts);
    const models = [...new Set(judged.votes.map((v) => v.model))].join(",");
    return {
      output: { answer: answered.answer, probabilities: answered.probabilities, backend: "llm", model: models, costUsd: judged.cost.usd },
      modelCallIds: judged.votes.map((v) => v.modelCallId),
    };
  };

  const decision = (data: Held, replayed: boolean): Decision => ({
    answer: data.answer,
    probabilities: data.probabilities,
    ...(data.type === "score" ? { expected: expectedLevel(data.labels, data.probabilities) } : {}),
    backend: data.backend,
    requested: data.requested,
    ...(data.fallback !== undefined ? { fallback: data.fallback } : {}),
    model: data.model,
    costUsd: replayed ? 0 : data.costUsd,
    decisionId: data.decisionId,
    replayed,
  });

  return {
    backendFor,
    async decide(request: DecideRequest): Promise<Decision> {
      checkRequest(request, deps.calibrated?.(request.site) === true);
      const requested = backendFor(request.site);
      if (requested === "off") throw new DecisionOffError(request.site);
      const key = decisionKey(request);
      const held = deps.find(key);
      if (held !== undefined) return decision(held, true);
      const stop = deps.interrupted();
      if (stop !== undefined) throw stop;

      let answer: { output: DecideAskOutput; modelCallIds: string[]; toolRunId?: string } | undefined;
      let fallback: string | undefined;
      if (requested !== "llm") {
        const tokens = requestTokens(request);
        const missing = await deps.unavailable(requested);
        if (missing !== undefined) fallback = missing;
        else if (requested === "jev" && tokens > JEV_MAX_TOKENS) fallback = new DecisionTooLargeError(tokens, JEV_MAX_TOKENS).message;
        else {
          try {
            const got = await deps.external(requested, request satisfies DecideAskInput, deps.signal);
            answer = { output: got.output, modelCallIds: got.modelCallIds, ...(got.toolRunId !== undefined ? { toolRunId: got.toolRunId } : {}) };
          } catch (error) {
            // A pause or a stop is not Jev failing: let it through. Anything else falls back, never fails the run.
            if (isInterrupted(error) || deps.signal.aborted) throw error;
            fallback = (error instanceof Error ? error.message : String(error)).slice(0, 400);
          }
        }
        const again = deps.interrupted();
        if (answer === undefined && again !== undefined) throw again;
      }
      answer ??= await viaLlm(request);
      const out = answer.output;
      const labels = labelsOf(request.question);
      const draft: DecisionDraft = {
        key,
        site: request.site,
        backend: out.backend,
        requested,
        ...(fallback !== undefined ? { fallback } : {}),
        model: out.model,
        type: request.question.type,
        labels,
        requestHash: deps.blob({ site: request.site, state: request.state, question: request.question }),
        stateHash: sha256Hex(request.state),
        answer: out.answer,
        probabilities: out.probabilities,
        costUsd: out.costUsd,
        modelCallIds: answer.modelCallIds,
        ...(answer.toolRunId !== undefined ? { toolRunId: answer.toolRunId } : {}),
      };
      const decisionId = deps.record(draft);
      return decision({ ...draft, decisionId }, false);
    },
  };
}
