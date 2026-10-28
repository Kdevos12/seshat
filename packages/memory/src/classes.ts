import { type ConfigClass, configClassOf, modelFamily, type Provenance } from "@seshat/core";
import type { Attempt } from "./store.ts";

/**
 * The configurations a run knows, for the comparisons of the soft failure memory (plan change PE3,
 * documentation/fleet.md, "Soft failure memory"): the models it is given, weakest first, and the
 * budget class it runs under. A model is weaker or stronger by its place in `order`, which the run
 * states (the fleet's `ranking` option, or its `models` then `escalateTo`); a budget class by its
 * size.
 */
export interface ModelRanking {
  /** `PROVIDER/ID` models, weakest first. The family of each (`modelFamily`) is what is ranked. */
  order: readonly string[];
  /** The run's budget class (`budgetClassOf`). */
  budgetClass: string;
}

const BUDGET_ORDER = ["tiny", "small", "medium", "large", "huge", "unbounded"] as const;

/** A configuration as one string, `FAMILY@BUDGET_CLASS` (the key of `configClassKey`, from a class). */
export function classKey(c: ConfigClass): string {
  return `${c.family}@${c.budgetClass}`;
}

/** The place of a budget class among the classes, from 0; -1 for a name that is not one. */
export function budgetRank(budgetClass: string): number {
  return (BUDGET_ORDER as readonly string[]).indexOf(budgetClass);
}

/** The place of a model family among the ranked ones, weakest first from 0; -1 for a family the run does not rank. */
export function familyRank(ranking: ModelRanking, family: string): number {
  return ranking.order.map(modelFamily).indexOf(family);
}

/** How a configuration compares with another one: the same, or weaker or stronger because of its model or its budget, or not comparable. */
export type ClassDifference = { relation: "same" } | { relation: "weaker" | "stronger"; by: "model" | "budget" } | { relation: "other" };

/**
 * How `a` compares with `b`. Models first: a family the run ranks lower is weaker, and one the run
 * does not rank at all is weaker than any it does (a model that is no longer configured is taken for an
 * older one, which is the case a model upgrade makes); two families the run does not rank are not
 * comparable. In the same family, the smaller budget class is the weaker.
 */
export function compareClass(ranking: ModelRanking, a: ConfigClass, b: ConfigClass): ClassDifference {
  if (a.family === b.family) {
    if (a.budgetClass === b.budgetClass) return { relation: "same" };
    const x = budgetRank(a.budgetClass);
    const y = budgetRank(b.budgetClass);
    if (x < 0 || y < 0 || x === y) return { relation: "other" };
    return { relation: x < y ? "weaker" : "stronger", by: "budget" };
  }
  const x = familyRank(ranking, a.family);
  const y = familyRank(ranking, b.family);
  if (x < 0 && y < 0) return { relation: "other" };
  if (x === y) return { relation: "other" };
  return { relation: x < y ? "weaker" : "stronger", by: "model" };
}

/** The strongest configuration the run has: its strongest ranked family under its budget class; undefined with no model ranked. */
export function strongestClass(ranking: ModelRanking): ConfigClass | undefined {
  const last = ranking.order.at(-1);
  return last === undefined ? undefined : { family: modelFamily(last), budgetClass: ranking.budgetClass };
}

/**
 * The configuration an attempt ran under, from its stamp; an attempt with no stamp (a journal older than the
 * stamps) from its model and the budget class given. The stamp's model is the session's, as configured.
 */
export function attemptClass(attempt: Pick<Attempt, "model" | "provenance">, fallbackBudgetClass: string): ConfigClass {
  const stamp: Pick<Provenance, "modelId" | "budgetClass"> = attempt.provenance ?? { modelId: attempt.model, budgetClass: fallbackBudgetClass };
  return configClassOf(stamp);
}

/** Whether an attempt says something about the configuration it ran under: it was accepted or failed, and was not cut short. */
function isVerdict(attempt: Pick<Attempt, "outcome">): boolean {
  return attempt.outcome === "valid" || attempt.outcome === "invalid" || attempt.outcome === "no_submission";
}

/**
 * Whether every failure of a claim comes from a configuration weaker than the strongest one the run
 * has (PE3 item 4): there is at least one failure, and none of them ran under that configuration or a
 * stronger one. A session that was cut (budget, abort, a harness error) is not a failure of its configuration.
 */
export function onlyWeakerFailures(attempts: readonly Pick<Attempt, "model" | "provenance" | "outcome">[], ranking: ModelRanking): boolean {
  const strongest = strongestClass(ranking);
  if (strongest === undefined) return false;
  const failures = attempts.filter((attempt) => isVerdict(attempt) && attempt.outcome !== "valid");
  if (failures.length === 0) return false;
  return failures.every((attempt) => compareClass(ranking, attemptClass(attempt, ranking.budgetClass), strongest).relation === "weaker");
}

/** The words for a difference, as they follow "with": `a smaller model`, `a larger budget`, `another configuration`. */
export function describeDifference(difference: ClassDifference): string {
  switch (difference.relation) {
    case "same":
      return "the same configuration";
    case "other":
      return "another model";
    case "weaker":
      return difference.by === "model" ? "a smaller model" : "a smaller budget";
    case "stronger":
      return difference.by === "model" ? "a larger model" : "a larger budget";
  }
}
