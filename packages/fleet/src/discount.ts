import type { Attempt } from "@seshat/memory";
import type { AttemptWeight } from "./posterior.ts";

/** The default discount of an earlier run's evidence, per run on the problem (plan change PE3). */
export const DEFAULT_GAMMA = 0.8;

/**
 * How many runs on the problem lie between an attempt and now, among `attempts`: its rank among the
 * distinct runs that made one, the current run counting as 0 even before it has made any (the run
 * that starts is a new run on the problem). A run that did not work on the problem is not counted,
 * so a chain of three runs of which only the first worked on a claim discounts its attempts once,
 * not twice.
 */
export function runsBetween(attempts: readonly Pick<Attempt, "runsAgo">[]): (attempt: Pick<Attempt, "runsAgo">) => number {
  const ago = [...new Set([0, ...attempts.map((attempt) => attempt.runsAgo ?? 0)])].sort((a, b) => a - b);
  return (attempt) => ago.indexOf(attempt.runsAgo ?? 0);
}

/**
 * The weight of each attempt in a posterior (documentation/fleet.md, "Soft failure memory"): gamma
 * to the power of the runs on the problem since the attempt, times the probation weight of its
 * epoch (`MemoryStore.weightOf`, which is 1 for the current epoch and k for each epoch opened
 * since). So the counts of an earlier run are multiplied by gamma on each new run on the problem,
 * and shrunk toward the prior when the model, the prompts or Mathlib changed; neither deletes
 * anything, and a new outcome counts in full. With one run and one epoch every weight is 1.
 */
export function attemptWeights(
  attempts: readonly Attempt[],
  options: { gamma: number; epochWeight: (epoch: number) => number },
): AttemptWeight {
  const runs = runsBetween(attempts);
  return (attempt) => Math.pow(options.gamma, runs(attempt)) * options.epochWeight(attempt.epoch ?? 0);
}
