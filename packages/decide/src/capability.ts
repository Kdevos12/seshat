import type { DecideRequest } from "@seshat/lines";
import type { DecisionBackend } from "@seshat/core";

/** The capability the Jev and faux backends are implementations of (`capabilities/decide.ask`). The run's model needs no implementation: it is the caller's `Llm`. */
export const DECIDE_ASK = "decide.ask";

/** The input of `decide.ask`: a `DecideRequest`. */
export type DecideAskInput = DecideRequest;

/** The output of `decide.ask`. */
export interface DecideAskOutput {
  answer: string | number | boolean;
  probabilities: Record<string, number>;
  backend: DecisionBackend;
  /** The model as the backend named it. */
  model: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}
