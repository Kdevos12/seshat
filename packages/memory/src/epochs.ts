import type { EpochChange } from "@seshat/core";

/** The share of an older epoch's counters that probation keeps (plan change PE1 item 3). An option of the store. */
export const DEFAULT_PROBATION = 0.25;

/**
 * The weight of an outcome from epoch `then` when the memory is in epoch `current`: `k` for each epoch
 * opened since, so 1 for an outcome of the current epoch. The unverified counters of an older epoch
 * are the sums of these weights; an outcome of the current epoch counts in full, and nothing else
 * gives an old counter back its weight: the items are shown, drawn and earn their standing again
 * (documentation/memory.md, "Provenance and epochs").
 */
export function probationWeight(current: number, then: number, k: number = DEFAULT_PROBATION): number {
  if (!(k >= 0 && k <= 1)) throw new RangeError(`the probation k must be between 0 and 1, got ${k}`);
  return k ** Math.max(0, current - then);
}

const LABELS: Record<EpochChange["field"], string> = {
  modelFamily: "the prover model family",
  promptMajor: "the prompts' major version",
  mathlibRev: "the Mathlib revision",
};

/** The reason an epoch is opened for, in words: `the prover model family changed from A to B; ...`. */
export function describeEpochChanges(changes: readonly EpochChange[]): string {
  return changes.map((c) => `${LABELS[c.field]} changed from ${c.from} to ${c.to}`).join("; ");
}
