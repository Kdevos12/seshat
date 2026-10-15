import { type Beta, sample } from "./beta.ts";
import type { RandomSource } from "./random.ts";

export interface Choice<T extends string> {
  choice: T;
  /** The draw of each candidate, in the order given. */
  draws: Array<[T, number]>;
}

/**
 * Thompson sampling: one draw from each candidate's posterior, and the highest draw wins (the first
 * of equal draws). A candidate nothing is known of has the flat posterior, so it is tried; one that
 * keeps failing is drawn lower and lower, but never ruled out. Undefined with no candidate.
 */
export function thompson<T extends string>(random: RandomSource, candidates: ReadonlyArray<readonly [T, Beta]>): Choice<T> | undefined {
  const draws = candidates.map(([label, posterior]): [T, number] => [label, sample(random, posterior)]);
  let best: [T, number] | undefined;
  for (const draw of draws) if (best === undefined || draw[1] > best[1]) best = draw;
  return best === undefined ? undefined : { choice: best[0], draws };
}
