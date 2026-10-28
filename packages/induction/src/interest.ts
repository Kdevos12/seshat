/**
 * Measures of how interesting a hypothesis is (after Colton, Bundy and Walsh 2000), computed on the objects
 * of a data table. A hypothesis is an implication `premise => conclusion` read on each object (no premise:
 * the conclusion alone). Every measure is a number from 0 to 1 and a deterministic function of the verdicts;
 * the weights of `score` are first guesses, to be tuned on the bench.
 *
 * - non-vacuity: the share of the objects the premise holds on. A hypothesis whose premise holds nowhere is
 *   true of nothing.
 * - novelty: 0 when a known fact already covers it on this table (a fact whose premise is no smaller and
 *   whose conclusion is no larger), else 1.
 * - surprise: 0 when one other property of the objects predicts the conclusion as well as the best constant
 *   guess, up to 1 when none does; a conclusion that is true everywhere, or that one column restates, is not a
 *   surprise.
 * - significance: the probability that the conclusion would not have held on every object of the premise by
 *   chance, given how often it holds outside the premise: 1 - p^support with p the smoothed rate of the
 *   conclusion outside the premise (0.5 with no premise).
 */
export type Verdicts = ReadonlyArray<boolean | null>;

export interface HypothesisVerdicts {
  /** On each object, whether the premise holds (undefined: no premise, it holds everywhere). */
  premise?: Verdicts;
  conclusion: Verdicts;
}

export interface Interest {
  /** Objects with a verdict on both sides. */
  objects: number;
  /** Objects the premise holds on. */
  support: number;
  /** Objects in the premise where the conclusion fails. */
  counterexamples: number[];
  nonVacuity: number;
  novelty: number;
  surprise: number;
  significance: number;
  /** The weighted mean of the four. */
  score: number;
  /** Set when the premise holds on fewer than `minSupport` objects. */
  vacuous: boolean;
}

export const INTEREST_WEIGHTS = { nonVacuity: 0.2, novelty: 0.3, surprise: 0.2, significance: 0.3 } as const;

const holds = (v: boolean | null | undefined): boolean => v === true;

/**
 * The interest of a hypothesis on the table. `known` are the facts already held (earlier hypotheses, claims with
 * a program); `properties` are the other boolean properties of the objects (boolean columns, thresholded
 * numbers).
 */
export function interestOf(h: HypothesisVerdicts, known: readonly HypothesisVerdicts[] = [], properties: readonly Verdicts[] = [], options: { minSupport?: number } = {}): Interest {
  const minSupport = options.minSupport ?? 3;
  const n = h.conclusion.length;
  const rows = [...Array(n).keys()].filter((i) => h.conclusion[i] !== null && h.conclusion[i] !== undefined && (h.premise === undefined || (h.premise[i] !== null && h.premise[i] !== undefined)));
  const inP = (i: number): boolean => h.premise === undefined || holds(h.premise[i]);
  const supportRows = rows.filter(inP);
  const outRows = rows.filter((i) => !inP(i));
  const counterexamples = supportRows.filter((i) => h.conclusion[i] === false);
  const nonVacuity = rows.length === 0 ? 0 : h.premise === undefined ? 1 : supportRows.length / rows.length;
  // Novelty: covered by a known fact K when P is inside K's premise and K's conclusion is inside Q, on every object.
  const covered = known.some((k) => {
    if (k.conclusion.length !== n) return false;
    const kp = (i: number): boolean => k.premise === undefined || holds(k.premise[i]);
    return supportRows.length > 0 && supportRows.every((i) => kp(i) && (!holds(k.conclusion[i]) || holds(h.conclusion[i])) && holds(k.conclusion[i]));
  });
  const novelty = covered ? 0 : 1;
  // Surprise: the best single property, or the majority guess, as a predictor of the conclusion over all rows.
  let majority = 0.5;
  if (rows.length > 0) {
    const yes = rows.filter((i) => h.conclusion[i] === true).length;
    majority = Math.max(yes, rows.length - yes) / rows.length;
  }
  let best = majority;
  for (const p of properties) {
    if (p.length !== n || rows.length === 0) continue;
    const agree = rows.filter((i) => p[i] !== null && p[i] !== undefined && holds(p[i]) === holds(h.conclusion[i])).length / rows.length;
    best = Math.max(best, agree, 1 - agree);
  }
  const surprise = rows.length === 0 ? 0 : Math.max(0, Math.min(1, (1 - best) * 2));
  // Significance: chance of the conclusion holding on all of the support, from its rate outside the premise.
  const outYes = outRows.filter((i) => h.conclusion[i] === true).length;
  const p = h.premise === undefined ? 0.5 : (outYes + 1) / (outRows.length + 2);
  const significance = counterexamples.length > 0 ? 0 : 1 - p ** supportRows.length;
  const score = INTEREST_WEIGHTS.nonVacuity * nonVacuity + INTEREST_WEIGHTS.novelty * novelty + INTEREST_WEIGHTS.surprise * surprise + INTEREST_WEIGHTS.significance * significance;
  return { objects: rows.length, support: supportRows.length, counterexamples, nonVacuity, novelty, surprise, significance, score, vacuous: supportRows.length < minSupport };
}
