import { type Decide, isInterrupted } from "@seshat/lines";
import { ForbiddenDecisionError } from "./errors.ts";

/**
 * The fleet's cold start (plan change J3, item 4): a Choice over strategy families, turned into Beta
 * pseudo-counts of a small, capped weight, so that the journal's own attempts dominate after a few of
 * them. It only seeds a prior for the choice of a strategy; it settles no claim.
 */
export const COLD_START_SITE = "fleet.cold_start";
/**
 * The attempts of the problem after which the prior is gone: the weight falls linearly from its
 * value at no attempt to nothing at this many, so the prior seeds the first sessions and then the
 * journal's own evidence decides alone.
 */
export const COLD_START_FADE_ATTEMPTS = 6;

/** The weight of the prior once `attempts` attempts of the problem are in the journal. */
export function fadedWeight(weight: number, attempts: number): number {
  return weight * Math.max(0, 1 - attempts / COLD_START_FADE_ATTEMPTS);
}

/** The default total weight of the prior, in pseudo-attempts. */
export const DEFAULT_COLD_START_WEIGHT = 2;
/** No configuration makes the prior weigh more than this: past a few attempts the journal must win. */
export const MAX_COLD_START_WEIGHT = 4;

export interface BetaCounts {
  alpha: number;
  beta: number;
}

/**
 * Pseudo-counts for each family from a distribution over them: Beta(1 + w p, 1 + w (1 - p)) with `w`
 * the weight, so that the family the distribution favours starts with a mean above one half and a
 * variance a single attempt moves. A weight over the cap is refused, not clamped.
 */
export function pseudoCounts(probabilities: Readonly<Record<string, number>>, weight = DEFAULT_COLD_START_WEIGHT): Record<string, BetaCounts> {
  if (!(weight >= 0 && weight <= MAX_COLD_START_WEIGHT)) throw new RangeError(`the weight of a cold-start prior is from 0 to ${MAX_COLD_START_WEIGHT}, got ${weight}`);
  return Object.fromEntries(
    Object.entries(probabilities).map(([family, p]) => {
      const q = Math.min(Math.max(p, 0), 1);
      return [family, { alpha: 1 + weight * q, beta: 1 + weight * (1 - q) }];
    }),
  );
}

/** A posterior with the prior's pseudo-counts added to it (the posterior's `Beta(1, 1)` base counted once). */
export function withPrior(posterior: BetaCounts | undefined, prior: BetaCounts | undefined): BetaCounts | undefined {
  if (prior === undefined) return posterior;
  if (posterior === undefined) return prior;
  return { alpha: posterior.alpha + prior.alpha - 1, beta: posterior.beta + prior.beta - 1 };
}

/**
 * Asks which of `families` the statement is most likely to yield to, and returns the pseudo-counts;
 * undefined when the site is off, there are fewer than two families, or the decision fails (the fleet
 * then draws from its flat prior, as it did). A pause passes through.
 */
export async function coldStartPriors(
  decide: Decide,
  request: { statement: string; families: readonly string[]; weight?: number; instructions?: string; log?: (text: string) => void },
): Promise<Record<string, BetaCounts> | undefined> {
  if (request.families.length < 2 || decide.backendFor(COLD_START_SITE) === "off") return undefined;
  try {
    const decision = await decide.decide({
      site: COLD_START_SITE,
      state: request.statement,
      question: {
        type: "choice",
        instructions: request.instructions ?? "Which family of proof strategies is the most likely to prove this statement?",
        options: Object.fromEntries(request.families.map((family) => [family, family])),
      },
      use: "order",
    });
    return pseudoCounts(decision.probabilities, request.weight);
  } catch (error) {
    if (isInterrupted(error) || error instanceof ForbiddenDecisionError || error instanceof RangeError) throw error;
    request.log?.(`decide: no cold-start prior, the decision failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    return undefined;
  }
}
