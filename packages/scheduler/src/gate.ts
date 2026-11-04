import { GATE_SITES } from "@seshat/core";

/**
 * The budget gate's rule (documentation/scheduler.md, "The budget gate"; PB1 and PB2 of `plans/plan-change-proportional-budgets.md`).
 * Pure: the numbers come in, a verdict goes out, and the same numbers give the same verdict. The orchestrator draws the chance of
 * success (Thompson sampling on the claim's Beta posterior, `claimPosterior`) and the floor's number from the run's seeded source,
 * asks `decide` where the rule has none, and journals the verdict as `budget.gated` with its numbers.
 *
 * The rule launches when `estimateUsd <= share(site) * remainingUsd * pSuccess`: a launch may take its site's share of what is
 * left, weighted by the chance that it pays. An exploration floor lets a fixed fraction of the skips through, so that a launch the
 * rule keeps refusing is still tried now and then, and the gate can be wrong only by that much and be caught by the ablation.
 */
export type GateSite = (typeof GATE_SITES)[number];

export interface GateSettings {
  /** The fraction of what is left that a site may take, by site. */
  share?: Partial<Record<GateSite, number>>;
  /** The fraction of the skips that the exploration floor lets through. Default 0.1; 0 turns it off. */
  floor?: number;
  /** A problem starts with one prover and one session that may spend this fraction of its budget. Default 0.1. */
  probeFraction?: number;
  /** An estimate within this fraction of the threshold is a tie, which `decide` may break. Default 0.1; 0 turns ties off. */
  margin?: number;
  /**
   * A prover is not ended by the gate before it has run this many sessions: the gate weighs the session after them. Default 2, at least 1.
   * One low Thompson draw would otherwise end a widened prover for good after its first session.
   */
  minSessions?: number;
}

export interface ResolvedGate {
  share: Record<GateSite, number>;
  floor: number;
  probeFraction: number;
  margin: number;
  minSessions: number;
}

/** What a site may take of what is left: a wave of provers or a session, half of it; a line's task, a quarter; a judge call, a tenth. */
export const DEFAULT_GATE: Readonly<ResolvedGate> = {
  share: { wave: 0.5, session: 0.5, task: 0.25, judge: 0.1 },
  floor: 0.1,
  probeFraction: 0.1,
  margin: 0.1,
  minSessions: 2,
};

/** The settings with the defaults under them; refuses a value out of range. */
export function gateSettings(given: GateSettings = {}): ResolvedGate {
  const share = { ...DEFAULT_GATE.share };
  for (const [site, value] of Object.entries(given.share ?? {})) {
    if (!(GATE_SITES as readonly string[]).includes(site)) throw new RangeError(`unknown site ${site}: the gate answers for ${GATE_SITES.join(", ")}`);
    if (!(typeof value === "number" && value > 0 && value <= 1)) throw new RangeError(`the share of ${site} must be above 0 and at most 1, got ${String(value)}`);
    share[site as GateSite] = value;
  }
  const floor = given.floor ?? DEFAULT_GATE.floor;
  if (!(typeof floor === "number" && floor >= 0 && floor <= 1)) throw new RangeError(`floor must be from 0 to 1, got ${String(floor)}`);
  const probeFraction = given.probeFraction ?? DEFAULT_GATE.probeFraction;
  if (!(typeof probeFraction === "number" && probeFraction > 0 && probeFraction <= 1)) throw new RangeError(`probeFraction must be above 0 and at most 1, got ${String(probeFraction)}`);
  const margin = given.margin ?? DEFAULT_GATE.margin;
  if (!(typeof margin === "number" && margin >= 0 && margin <= 1)) throw new RangeError(`margin must be from 0 to 1, got ${String(margin)}`);
  const minSessions = given.minSessions ?? DEFAULT_GATE.minSessions;
  if (!(Number.isInteger(minSessions) && minSessions >= 1)) throw new RangeError(`minSessions must be a whole number of at least 1, got ${String(minSessions)}`);
  return { share, floor, probeFraction, margin, minSessions };
}

/** What the gate is asked: the hook `problem.budget.ask` (documentation/lines.md). */
export interface GateQuery {
  site: GateSite;
  /** What the launch is expected to cost, in dollars. */
  estimateUsd: number;
  /** The Thompson draw of the success chance from the claim's posterior; absent when nothing was counted (a cold start). */
  pSuccess?: number;
  /** A draw from the flat prior, used when `pSuccess` is absent. */
  coldDraw?: number;
  /** The floor's draw, in [0, 1): the skip goes through when it is under the floor. */
  floorDraw: number;
  /** For a wave: whether the probe made Lean progress. */
  progress?: boolean;
  rung: number;
}

export interface GateState {
  remainingUsd: number;
  budgetUsd: number;
}

/** A verdict, with the numbers it was made from: `budget.gated` minus the problem and the position (prover, session, task). */
export interface GateVerdict {
  site: GateSite;
  action: "launch" | "probe" | "skip" | "widen";
  /** `decide` and `memory` are the orchestrator's: the rule never gives them. */
  by: "rule" | "floor" | "probe" | "progress" | "decide" | "memory";
  estimateUsd: number;
  remainingUsd: number;
  budgetUsd: number;
  share: number;
  pSuccess?: number;
  thresholdUsd?: number;
  rung: number;
  exploration: boolean;
  progress?: boolean;
  /** For `by: floor`: the draw and the fraction it was under. */
  floorDraw?: number;
  floorFraction?: number;
  reason: string;
}

export interface GateAnswer {
  verdict: GateVerdict;
  /** Set when the rule has no numbers (`cold_start`) or they are too close to call (`tie`): `decide` may break it; the verdict is the answer without it. */
  undecided?: "cold_start" | "tie";
}

const f4 = (n: number): string => n.toFixed(4);

/** The most the probe may spend: its fraction of the problem's budget. */
export function probeCapUsd(budgetUsd: number, settings: ResolvedGate): number {
  return settings.probeFraction * budgetUsd;
}

/** The first launch of a problem (PB2): one prover, one session, at most `probeFraction` of the budget. It is not weighed by the formula: it is the starting shape. */
export function probeVerdict(query: Pick<GateQuery, "estimateUsd" | "rung">, state: GateState, settings: ResolvedGate): GateVerdict {
  return {
    site: "wave",
    action: "probe",
    by: "probe",
    estimateUsd: query.estimateUsd,
    remainingUsd: state.remainingUsd,
    budgetUsd: state.budgetUsd,
    share: settings.probeFraction,
    rung: query.rung,
    exploration: false,
    reason: `probe first: one prover, one session, at most ${f4(probeCapUsd(state.budgetUsd, settings))} (${String(settings.probeFraction * 100)}% of ${f4(state.budgetUsd)})`,
  };
}

function formula(query: GateQuery, state: GateState, settings: ResolvedGate): GateAnswer {
  const share = settings.share[query.site];
  const cold = query.pSuccess === undefined;
  if (cold && query.coldDraw === undefined) throw new RangeError("a cold start needs the draw of the flat prior");
  const p = query.pSuccess ?? (query.coldDraw as number);
  const threshold = share * state.remainingUsd * p;
  const launch = query.estimateUsd <= threshold;
  const widening = query.site === "wave";
  const base = {
    site: query.site,
    estimateUsd: query.estimateUsd,
    remainingUsd: state.remainingUsd,
    budgetUsd: state.budgetUsd,
    share,
    pSuccess: p,
    thresholdUsd: threshold,
    rung: query.rung,
    ...(query.progress !== undefined ? { progress: query.progress } : {}),
  };
  const numbers = `${f4(threshold)} = ${String(share)} x ${f4(state.remainingUsd)} x ${f4(p)}`;
  const go = widening ? "widen" : "launch";
  let verdict: GateVerdict;
  if (launch) {
    verdict = { ...base, action: go, by: "rule", exploration: false, reason: `${f4(query.estimateUsd)} is within ${numbers}` };
  } else if (query.floorDraw < settings.floor) {
    verdict = { ...base, action: go, by: "floor", exploration: true, floorDraw: query.floorDraw, floorFraction: settings.floor, reason: `${f4(query.estimateUsd)} is over ${numbers}; the exploration floor lets it through (draw ${query.floorDraw.toFixed(4)} < ${String(settings.floor)})` };
  } else {
    verdict = { ...base, action: "skip", by: "rule", exploration: false, reason: `${f4(query.estimateUsd)} is over ${numbers}` };
  }
  if (cold) return { verdict: { ...verdict, reason: `${verdict.reason} (no posterior: the flat prior's draw)` }, undecided: "cold_start" };
  if (verdict.by === "rule" && threshold > 0 && Math.abs(query.estimateUsd - threshold) <= settings.margin * threshold) return { verdict, undecided: "tie" };
  return { verdict };
}

/** A session, a line's task or a judge call: the formula, the floor, and the cases that have no numbers. */
export function gateRule(query: GateQuery, state: GateState, settings: ResolvedGate): GateAnswer {
  if (query.site === "wave") throw new RangeError("a wave is probed and widened: use probeVerdict and widenRule");
  return formula(query, state, settings);
}

/**
 * Whether the problem widens past its probe (PB2): only after Lean progress, and then the formula decides; without progress the
 * wave is skipped, except for the floor's fraction. Lean progress is the ladder's measure (`progressed`).
 */
export function widenRule(query: GateQuery, state: GateState, settings: ResolvedGate): GateAnswer {
  if (query.progress !== true) {
    const base = {
      site: "wave" as const,
      estimateUsd: query.estimateUsd,
      remainingUsd: state.remainingUsd,
      budgetUsd: state.budgetUsd,
      share: settings.share.wave,
      ...(query.pSuccess !== undefined ? { pSuccess: query.pSuccess, thresholdUsd: settings.share.wave * state.remainingUsd * query.pSuccess } : {}),
      rung: query.rung,
      progress: false,
    };
    if (query.floorDraw < settings.floor) {
      return { verdict: { ...base, action: "widen", by: "floor", exploration: true, floorDraw: query.floorDraw, floorFraction: settings.floor, reason: `the probe made no Lean progress; the exploration floor widens anyway (draw ${query.floorDraw.toFixed(4)} < ${String(settings.floor)})` } };
    }
    return { verdict: { ...base, action: "skip", by: "progress", exploration: false, reason: "the probe made no Lean progress: the problem does not widen" } };
  }
  return formula({ ...query, progress: true }, state, settings);
}
