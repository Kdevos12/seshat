import type { DecisionBackend } from "@seshat/core";

/**
 * The `decide` facility a line gets as `ProblemContext.decide` (documentation/decide.md): a typed
 * choice, score or yes/no about a short state, answered by the run's model by default and by Jev when
 * the configuration says so. A decision orders work; it never changes a claim's status. The
 * implementation is `@seshat/decide`; the types are here so that a line needs no dependency on it.
 */
export type DecideQuestion =
  /** One of up to 255 options (`key` to a short text). */
  | { type: "choice"; instructions: string; options: Record<string, string> }
  /** One of 2 to 10 ordered levels, lowest first. */
  | { type: "score"; instructions: string; levels: string[] }
  /** Yes or no. */
  | { type: "noul"; instructions: string };

export interface DecideRequest {
  /** Where the decision is made. Only the sites of `DECISION_SITES` (`@seshat/core`) accept `decide`. */
  site: string;
  /** Compact: a goal and hypotheses, or a statement. Never a whole packet. */
  state: string;
  question: DecideQuestion;
  /**
   * What the result is used for, stated by the caller and required (plan change J4). Only `order`
   * until a site has a reliability curve; `threshold` is refused before that, and so is a request
   * that does not say.
   */
  use: "order" | "threshold";
}

export interface Decision {
  /** The label chosen: an option's key, a level, or `true` / `false` for a yes/no. */
  answer: string | number | boolean;
  /** The distribution over the labels (`yes` and `no` for a yes/no), summing to 1. Use it to order, not as a threshold. */
  probabilities: Record<string, number>;
  /** For a score: the expected level, as an index from 0 in `levels` (the number to order by). */
  expected?: number;
  /** Who answered. */
  backend: DecisionBackend;
  /** What the configuration asked for; differs from `backend` after a fallback, and `fallback` says why. */
  requested: DecisionBackend;
  fallback?: string;
  model: string;
  costUsd: number;
  /** The `decision.made` event. */
  decisionId: string;
  /** True when the journal already held the answer to this question: nothing was asked or paid. */
  replayed: boolean;
}

export interface Decide {
  /**
   * Asks. Rejects with `ForbiddenDecisionError` at a site or for a use that may not use decide, and
   * with the interruption (`isInterrupted`) when the run is told to pause: let it through. The same
   * question about the same state in a problem is answered from the journal, so a resumed run does
   * not pay twice.
   */
  decide(request: DecideRequest): Promise<Decision>;
  /** The backend the configuration gives a site: `off` means the line does what it did before `decide`. */
  backendFor(site: string): DecisionBackend | "off";
}
