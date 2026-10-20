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
 */
export function betaUpdate(b: Beta, reward: number): Beta {
  const r = Math.min(Math.max(reward, 0), 1);
  return { alpha: b.alpha + r, beta: b.beta + (1 - r) };
}

/** A draw from the posterior: Thompson sampling plays the arm with the highest draw. */
export function sample(random: RandomSource, b: Beta): number {
  return betaDraw(random, b.alpha, b.beta);
}
