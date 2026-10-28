import { betaDraw, type RandomSource } from "./random.ts";

/** A Beta posterior over a rate of success, as the two counts that define it. */
export interface Beta {
  alpha: number;
  beta: number;
}

/** What nothing has been observed gives: Beta(1, 1), flat on [0, 1]. */
export const UNIFORM: Readonly<Beta> = { alpha: 1, beta: 1 };

export function betaMean(b: Beta): number {
  return b.alpha / (b.alpha + b.beta);
}

/**
 * The posterior after one more observation worth `reward` in [0, 1]: a success is 1, a failure 0,
 * and a failure that got far (partial credit) in between. `alpha` takes the reward, `beta` the rest.
 * `weight` (default 1) scales the observation: the discount of an earlier run and the probation of
 * an older epoch make an old observation count for less (documentation/fleet.md, "Soft failure
 * memory"), which is the shrinkage Beta(1 + (a - 1) w, 1 + (b - 1) w) of sums of outcomes.
 */
export function betaUpdate(b: Beta, reward: number, weight = 1): Beta {
  const r = Math.min(Math.max(reward, 0), 1);
  const w = Math.max(weight, 0);
  return { alpha: b.alpha + w * r, beta: b.beta + w * (1 - r) };
}

/** A draw from the posterior: Thompson sampling plays the arm with the highest draw. */
export function sample(random: RandomSource, b: Beta): number {
  return betaDraw(random, b.alpha, b.beta);
}
