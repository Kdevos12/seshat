import { type Beta, betaMean, betaOfCounts, probabilityLess } from "./beta.ts";

/** One side of an item's effect: the attempts that had it, or the attempts that were denied it. */
export interface EffectArm {
  /** The attempts that count (a proof the fast check accepted, or a failed check). */
  attempts: number;
  /** Successes and failures, each weighted by its epoch's probation weight. */
  successes: number;
  failures: number;
  /** Beta(1 + successes, 1 + failures). */
  posterior: Beta;
}

/**
 * What an item does to the success of an attempt (plan change PE2 item 2): the success rate of the
 * attempts that were shown it against the rate of those that were not, as two Beta posteriors, in one
 * group of claims and, if given, one strategy label. Only attempts whose draw named the item count, the
 * included ones on one side and the withheld ones on the other: the draw is what makes the comparison
 * causal, since an attempt that was never offered the item was selected by something else.
 */
export interface ItemEffect {
  itemId: string;
  /** The claims the attempts are on; undefined: any claim. */
  claimIds?: readonly string[];
  /** The strategy label the attempts share; undefined: any label (or none). */
  strategy?: string;
  with: EffectArm;
  without: EffectArm;
  /** The mean of the posterior with the item minus the mean without it. */
  difference: number;
  /** P(effect < 0): the chance that the rate with the item is below the rate without it. */
  pNegative: number;
}

export function armOf(successes: number, failures: number, attempts: number): EffectArm {
  return { attempts, successes, failures, posterior: betaOfCounts(successes, failures) };
}

export function effectOf(
  itemId: string,
  scope: { claimIds?: readonly string[]; strategy?: string },
  withItem: EffectArm,
  withoutItem: EffectArm,
): ItemEffect {
  return {
    itemId,
    ...(scope.claimIds !== undefined ? { claimIds: scope.claimIds } : {}),
    ...(scope.strategy !== undefined ? { strategy: scope.strategy } : {}),
    with: withItem,
    without: withoutItem,
    difference: betaMean(withItem.posterior) - betaMean(withoutItem.posterior),
    pNegative: probabilityLess(withItem.posterior, withoutItem.posterior),
  };
}

/** The deactivation rule of M5 (PE2 item 2): both options. */
export interface DeactivationRule {
  /** At least this many observations on each side, each weighed by its epoch's probation weight. */
  minObservations: number;
  /** Deactivate when P(effect < 0) is above this. Default 0.9. */
  threshold?: number;
}

/**
 * Whether the item should be deactivated: P(effect < 0) above the threshold (0.9) after at least
 * `minObservations` observations with the item and as many without it. An observation counts with the
 * probation weight of its epoch (`successes + failures` of the arm, which are weighted), so an item whose
 * evidence is old and in probation has not enough observations until new outcomes of the current epoch
 * make up the minimum; in the current epoch an observation counts one, as an attempt does.
 */
export function shouldDeactivate(effect: ItemEffect, rule: DeactivationRule): boolean {
  const threshold = rule.threshold ?? 0.9;
  const observed = (arm: EffectArm) => arm.successes + arm.failures;
  // The sums of weights can fall a rounding error short of a whole number of attempts.
  const enough = (arm: EffectArm) => observed(arm) + 1e-9 >= rule.minObservations;
  return enough(effect.with) && enough(effect.without) && effect.pNegative > threshold;
}
