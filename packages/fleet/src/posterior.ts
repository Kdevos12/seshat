import { type Attempt, attemptDepth, VALID_DEPTH } from "@seshat/memory";
import { type Beta, betaMean, betaUpdate, UNIFORM } from "./beta.ts";

/**
 * What one finished attempt is worth to a choice, in [0, 1]: 1 for a proof the fast check accepted;
 * for a failure, `partial` times how far Lean got (the depth ladder of `@seshat/memory`, so that an
 * attempt left with unsolved goals is worth more than one that did not parse); undefined for an
 * attempt that says nothing (no check, cut short, a harness error).
 */
export function rewardOf(attempt: Pick<Attempt, "outcome" | "failureClass">, partial: number): number | undefined {
  const depth = attemptDepth(attempt);
  if (depth === undefined) return undefined;
  if (depth >= VALID_DEPTH) return 1;
  return Math.min(Math.max(partial, 0), 1) * (depth / (VALID_DEPTH - 1));
}

/**
 * Two posteriors over the same attempts. `choice` takes partial credit, and Thompson sampling draws
 * from it to pick what the next session does. `success` counts a proof as a success and anything
 * else as a failure: it is the single-agent posterior, which decides the width, the escalation and
 * the stagnation.
 */
export interface Posterior {
  choice: Beta;
  success: Beta;
  /** The attempts that counted. */
  attempts: number;
}

export function emptyPosterior(): Posterior {
  return { choice: { ...UNIFORM }, success: { ...UNIFORM }, attempts: 0 };
}

/**
 * How much each attempt counts: 1 by default. `AttemptWeight` is the weight of a run discount and of
 * an epoch's probation (`attemptWeights`), or any rule a caller gives.
 */
export type AttemptWeight = (attempt: Attempt) => number;

/**
 * The posterior with one more attempt, or the same posterior for one that says nothing. The attempt
 * counts `weight` in both posteriors; `attempts` counts it once, whatever its weight, since it is
 * the number of attempts that said something.
 */
export function addAttempt(p: Posterior, attempt: Pick<Attempt, "outcome" | "failureClass">, partial: number, weight = 1): Posterior {
  const reward = rewardOf(attempt, partial);
  if (reward === undefined) return p;
  return {
    choice: betaUpdate(p.choice, reward, weight),
    success: betaUpdate(p.success, attempt.outcome === "valid" ? 1 : 0, weight),
    attempts: p.attempts + 1,
  };
}

export function posteriorOf(attempts: readonly Attempt[], partial: number, weigh?: AttemptWeight): Posterior {
  return attempts.reduce((p, attempt) => addAttempt(p, attempt, partial, weigh?.(attempt) ?? 1), emptyPosterior());
}

/** The strategy an attempt is counted under: the label M1 classified when it finished, else the one declared. */
export function strategyOf(attempt: Pick<Attempt, "strategy" | "declaredStrategy">): string | undefined {
  return attempt.strategy ?? attempt.declaredStrategy;
}

export function group(attempts: readonly Attempt[], key: (attempt: Attempt) => string | undefined, partial: number, weigh?: AttemptWeight): Map<string, Posterior> {
  const found = new Map<string, Posterior>();
  for (const attempt of attempts) {
    const label = key(attempt);
    // An attempt that says nothing leaves no entry: a label is here only when something was counted under it.
    if (label === undefined || rewardOf(attempt, partial) === undefined) continue;
    found.set(label, addAttempt(found.get(label) ?? emptyPosterior(), attempt, partial, weigh?.(attempt) ?? 1));
  }
  return found;
}

/** The posterior of each strategy label, from the attempts of a claim (and its equivalents). */
export function strategyPosteriors(attempts: readonly Attempt[], partial: number, weigh?: AttemptWeight): Map<string, Posterior> {
  return group(attempts, strategyOf, partial, weigh);
}

/** The posterior of each model, from attempts on any claims. */
export function modelPosteriors(attempts: readonly Attempt[], partial: number, weigh?: AttemptWeight): Map<string, Posterior> {
  return group(attempts, (attempt) => attempt.model, partial, weigh);
}

/** The mean of the single-agent posterior: the chance that one more session proves the claim. */
export function successRate(p: Posterior): number {
  return betaMean(p.success);
}

/**
 * Whether work on a claim stagnates: at least `minAttempts` attempts counted, and every strategy
 * tried has a success rate under `below`. The lines that react to a stall (abduction, induction)
 * read this; the fleet itself only widens and escalates.
 */
export function stagnating(posteriors: ReadonlyMap<string, Posterior>, o: { below: number; minAttempts: number }): boolean {
  let total = 0;
  for (const p of posteriors.values()) {
    total += p.attempts;
    if (p.attempts > 0 && successRate(p) >= o.below) return false;
  }
  return total >= o.minAttempts;
}
