import { armOf, type Attempt, type DeactivationRule, effectOf, type ItemEffect, shouldDeactivate } from "@seshat/memory";
import { type Beta, betaMean, UNIFORM } from "./beta.ts";
import { type AttemptWeight, group } from "./posterior.ts";

/**
 * What a bucket of past sessions says about a setting (documentation/fleet.md, "The bucket prior"): the pieces the
 * heuristic cards and the sampled settings share, in one place. A bucket is the attempts of problems of the same
 * kind (`bucketOf` of `@seshat/heuristics`), on any claim.
 *
 * Called by `heuristics.ts` (`drawCard`, `cardEffect`) and by `settings.ts` (`sampleSettings`, when the fleet option
 * `bucketPrior` is on). It never draws, reads no journal and records nothing: it turns attempts into numbers, and
 * the callers decide what to do with them.
 */

/** The value a recorded setting has, as the text its posterior is kept under: a string or a number, nothing else. */
export function settingKeyOf(attempt: Attempt, name: string): string | undefined {
  const value = attempt.settings?.[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** A prior: `weight` pseudo-sessions at `mean`. */
export interface Prior {
  mean: number;
  weight: number;
}

/** The posterior with the prior added: a value nothing is known of starts flat, then takes the prior's pseudo-sessions. */
export function withPrior(base: Beta | undefined, prior: Prior): Beta {
  const b = base ?? UNIFORM;
  return { alpha: b.alpha + prior.weight * prior.mean, beta: b.beta + prior.weight * (1 - prior.mean) };
}

/** The mean of the `choice` posterior of each value of a keyed setting over a history; a value never seen has no entry. */
export function valueMeans(history: readonly Attempt[], key: (attempt: Attempt) => string | undefined, partial: number, weigh?: AttemptWeight): Map<string, number> {
  return new Map([...group(history, key, partial, weigh)].map(([value, posterior]) => [value, betaMean(posterior.choice)] as const));
}

/**
 * The effect of what `arm` picks against what `control` picks, among the finished checked attempts of a history
 * (PE2's two Beta posteriors, `effectOf` of `@seshat/memory`). Only a proof Lean accepted or a failed check says
 * something; each attempt counts its weight.
 */
export function effectIn(itemId: string, history: readonly Attempt[], arm: (attempt: Attempt) => boolean, control: (attempt: Attempt) => boolean, weigh: AttemptWeight = () => 1): ItemEffect {
  const tally = (pick: (attempt: Attempt) => boolean) => {
    let successes = 0;
    let failures = 0;
    let attempts = 0;
    for (const attempt of history) {
      if (!pick(attempt) || (attempt.outcome !== "valid" && attempt.outcome !== "invalid")) continue;
      const w = weigh(attempt);
      attempts += 1;
      if (attempt.outcome === "valid") successes += w;
      else failures += w;
    }
    return armOf(successes, failures, attempts);
  };
  return effectOf(itemId, {}, tally(arm), tally(control));
}

/**
 * The values of a keyed setting that M5's rule turns off in the bucket: the sessions given the value against the
 * sessions given any other value of the same setting. Never every value: when the rule would turn them all off, none is.
 */
export function deactivatedValues(
  values: readonly string[],
  history: readonly Attempt[],
  key: (attempt: Attempt) => string | undefined,
  rule: DeactivationRule,
  weigh?: AttemptWeight,
): string[] {
  const off = values.filter((value) =>
    shouldDeactivate(
      effectIn(
        value,
        history,
        (attempt) => key(attempt) === value,
        (attempt) => key(attempt) !== undefined && key(attempt) !== value,
        weigh,
      ),
      rule,
    ),
  );
  return off.length === values.length ? [] : off;
}
