import type { Json } from "@seshat/core";
import type { FactoryContext, ImplementationFactory, ImplementationInstance } from "@seshat/registry";
import type { DecideAskInput, DecideAskOutput } from "./capability.ts";
import { normalize, topLabel } from "./distribution.ts";
import { checkRequest, labelsOf } from "./question.ts";

/** One scripted answer of the faux backend. */
export interface FauxStep {
  /** Only for this site; absent: any. */
  site?: string;
  /** The label to answer; absent: the most probable of `probabilities`, else the first label. */
  answer?: string | boolean;
  /** Weights over the labels; absent: all on the answer. */
  probabilities?: Record<string, number>;
  costUsd?: number;
  model?: string;
}

/**
 * The faux backend, for tests: scripted answers taken in order (the first step that fits the site),
 * and when none is left, all the weight on the first label. It checks the request like any backend.
 * `calls` records what it was asked.
 */
export class FauxDecider {
  readonly calls: DecideAskInput[] = [];
  private readonly script: FauxStep[];

  constructor(script: readonly FauxStep[] = []) {
    this.script = [...script];
  }

  decide(input: DecideAskInput): DecideAskOutput {
    checkRequest(input);
    this.calls.push(input);
    const at = this.script.findIndex((step) => step.site === undefined || step.site === input.site);
    const step = at < 0 ? undefined : this.script.splice(at, 1)[0];
    const labels = labelsOf(input.question);
    const wanted = step?.answer === undefined ? undefined : typeof step.answer === "boolean" ? (step.answer ? "yes" : "no") : step.answer;
    const weights = step?.probabilities ?? {};
    const label = wanted ?? (Object.keys(weights).length > 0 ? topLabel(labels, weights) : (labels[0] as string));
    const distribution = Object.keys(weights).length > 0 ? weights : { [label]: 1 };
    const answered = normalize(input.question, label, distribution);
    return {
      answer: answered.answer,
      probabilities: answered.probabilities,
      backend: "faux",
      model: step?.model ?? "faux",
      costUsd: step?.costUsd ?? 0,
    };
  }
}

/** The `faux` implementation around a decider the test holds. */
export function fauxImplementation(decider: FauxDecider): ImplementationInstance {
  return { invoke: async (input) => decider.decide(input as unknown as DecideAskInput) as unknown as Json };
}

/** The factory of the `faux` implementation: the script is the setting `script`, or the test's own decider. */
export function fauxFactory(decider?: FauxDecider): ImplementationFactory {
  return ({ settings }: FactoryContext) => {
    const script = Array.isArray(settings.script) ? (settings.script as unknown as FauxStep[]) : [];
    return fauxImplementation(decider ?? new FauxDecider(script));
  };
}
