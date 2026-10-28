import type { Json } from "@seshat/core";
import { InterruptedError, type Llm, type LlmRequest } from "@seshat/lines";
import { createDecide, type DecideConfig, type DecideDeps, type DecisionDraft, type ExternalAnswer, type Held, resolveDecideSettings } from "../src/index.ts";

/** An `Llm` that answers with these texts in turn, and records its requests. */
export function scriptedLlm(texts: string[], model = "prov/model"): Llm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let n = 0;
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const text = texts[requests.length - 1];
      if (text === undefined) throw new Error("the scripted model has no answer left");
      return { text, cost: { usd: 0.01, inputTokens: 100, outputTokens: 10 }, model, modelCallId: `mc_${++n}` };
    },
  };
}

export const verdict = (label: string): string => JSON.stringify({ verdict: label });

export interface Rig {
  decide: ReturnType<typeof createDecide>;
  recorded: Array<DecisionDraft & { decisionId: string }>;
  externals: Array<{ backend: string; input: Json }>;
  deps: DecideDeps;
}

/** `createDecide` over an in-memory journal; `external` answers as given, or fails with `fail`. */
export function rig(options: {
  config?: Parameters<typeof resolveDecideSettings>[0];
  llm?: Llm;
  unavailable?: string;
  external?: ExternalAnswer;
  fail?: Error;
  interrupted?: () => Error | undefined;
  signal?: AbortSignal;
}): Rig {
  const config: DecideConfig = resolveDecideSettings(options.config);
  const recorded: Rig["recorded"] = [];
  const externals: Rig["externals"] = [];
  const deps: DecideDeps = {
    config,
    llm: options.llm ?? scriptedLlm([]),
    signal: options.signal ?? new AbortController().signal,
    async unavailable() {
      return options.unavailable;
    },
    async external(backend, input) {
      externals.push({ backend, input: input as unknown as Json });
      if (options.fail !== undefined) throw options.fail;
      if (options.external === undefined) throw new Error("no external answer scripted");
      return options.external;
    },
    find: (key): Held | undefined => recorded.find((d) => d.key === key),
    blob: () => "blobhash",
    record(draft) {
      const decisionId = `dec_${recorded.length + 1}`;
      recorded.push({ ...draft, decisionId });
      return decisionId;
    },
    interrupted: options.interrupted ?? (() => undefined),
  };
  return { decide: createDecide(deps), recorded, externals, deps };
}

export class Paused extends InterruptedError {}

export const ORDER = {
  site: "prove.search.order",
  state: "n : ℕ\n⊢ n + 0 = n",
  use: "order" as const,
  question: { type: "choice" as const, instructions: "Which first?", options: { simp: "simp", omega: "omega", rfl: "rfl" } },
};
export const RELEVANCE = {
  site: "conjecture.relevance",
  state: "∀ n : ℕ, n + 0 = n",
  use: "order" as const,
  question: { type: "score" as const, instructions: "How relevant?", levels: ["low", "medium", "high"] },
};
