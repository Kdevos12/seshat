import { type Posterior, successRate } from "./posterior.ts";

export interface EscalationOptions {
  /** `PROVIDER/ID` of the stronger model, or null for no escalation. */
  escalateTo: string | null;
  /** Attempts on the claim before a decision is hard. */
  after: number;
  /** A success rate under which it is. */
  below: number;
  /** Escalated sessions per claim at most. */
  max: number;
}

/**
 * Whether the next session on a claim goes to the stronger model (plan §11): the decision is hard
 * when `after` attempts have counted and the single-agent success rate is under `below`, and the
 * claim has not used its `max` escalations. Escalation helps only when the main model is already
 * strong (the plan cites Cognition): it is a way to spend a few sessions on a better model where
 * the main one stalls, not a way to make up for a weak one.
 */
export function shouldEscalate(success: Posterior, used: number, o: EscalationOptions): boolean {
  return o.escalateTo !== null && used < o.max && success.attempts >= o.after && successRate(success) < o.below;
}
