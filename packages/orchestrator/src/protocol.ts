import { mcnemarExact, wilsonInterval } from "./paired-stats.ts";
import type { RunMeasures } from "./measures.ts";

/**
 * The paired protocol of plan change CA2: the same problems at the same dollars per problem in every arm, solved counts with Wilson
 * intervals, dollars, dollars per solved problem, problems solved per dollar and wall-clock time per arm; against the baseline arm
 * the discordant pairs, the exact McNemar test and the ratio of problems solved per dollar, and whether the target is met.
 */

export const DEFAULT_TARGET = 1.5;
const SOLVED = new Set(["proved", "refuted", "candidate"]);

export interface ProtocolArm {
  name: string;
  problems: number;
  solved: number;
  /** The Wilson 95% interval of the share of problems solved. */
  interval: { low: number; high: number };
  usd: number;
  /** Absent when nothing was solved. */
  usdPerSolved?: number;
  /** Absent when nothing was spent. */
  solvedPerUsd?: number;
  wallMs: number;
  /** Counted apart: problems with a certified refutation, and statements found settled in the literature (zero until Task 36's nodes exist). */
  refuted: number;
  settledInLiterature: number;
  /** Against the baseline arm; absent for the baseline itself. */
  versus?: {
    baseline: string;
    /** Problems both arms finished, which every number below is over. */
    common: number;
    /** Solved by this arm only (b) and by the baseline only (c): the discordant pairs. */
    onlyThis: number;
    onlyBaseline: number;
    /** The exact two-sided McNemar p-value of the discordant pairs. */
    p: number;
    /** This arm's problems solved per dollar over the baseline's, on the common problems; absent when either has none (a baseline that solves nothing). */
    ratio?: number;
    comparable: boolean;
  };
}

export interface Protocol {
  baseline: string;
  target: number;
  arms: ProtocolArm[];
  /** Absent with a single arm. */
  verdict?: { met: boolean; arm: string; line: string };
}

type Measured = { name: string; measures: Pick<RunMeasures, "perProblem" | "refuted" | "settledInLiterature" | "wallMs"> };

function totals(m: Measured["measures"], only?: ReadonlySet<string>): { problems: number; solved: number; usd: number } {
  const rows = only === undefined ? m.perProblem : m.perProblem.filter((p) => only.has(p.problemId));
  return { problems: rows.length, solved: rows.filter((p) => SOLVED.has(p.outcome)).length, usd: rows.reduce((n, p) => n + p.usd, 0) };
}

const perUsd = (solved: number, usd: number): number | undefined => (usd > 0 ? solved / usd : undefined);

/** The protocol's numbers for arms in table order; `baseline` is the name of the arm the others are set against (default: the first). */
export function pairedProtocol(arms: readonly Measured[], baselineName?: string, target = DEFAULT_TARGET): Protocol {
  const baseline = arms.find((a) => a.name === (baselineName ?? arms[0]?.name));
  if (baseline === undefined) throw new Error(`the baseline arm ${JSON.stringify(baselineName)} is not in the table`);
  if (!(target > 0) || !Number.isFinite(target)) throw new Error(`--target is a ratio above 0, got ${target}`);
  const baseOutcome = new Map(baseline.measures.perProblem.map((p) => [p.problemId, SOLVED.has(p.outcome)]));
  const rows = arms.map((a): ProtocolArm => {
    const t = totals(a.measures);
    const row: ProtocolArm = {
      name: a.name,
      ...t,
      interval: wilsonInterval(t.solved, t.problems),
      ...(t.solved > 0 ? { usdPerSolved: t.usd / t.solved } : {}),
      ...(perUsd(t.solved, t.usd) !== undefined ? { solvedPerUsd: perUsd(t.solved, t.usd) as number } : {}),
      wallMs: a.measures.wallMs,
      refuted: a.measures.refuted,
      settledInLiterature: a.measures.settledInLiterature,
    };
    if (a === baseline) return row;
    const mine = new Map(a.measures.perProblem.map((p) => [p.problemId, SOLVED.has(p.outcome)]));
    const common = new Set([...mine.keys()].filter((id) => baseOutcome.has(id)));
    const comparable = mine.size === baseOutcome.size && common.size === mine.size;
    const onlyThis = [...common].filter((id) => mine.get(id) === true && baseOutcome.get(id) === false).length;
    const onlyBaseline = [...common].filter((id) => mine.get(id) === false && baseOutcome.get(id) === true).length;
    const mineT = totals(a.measures, common);
    const baseT = totals(baseline.measures, common);
    const x = perUsd(mineT.solved, mineT.usd);
    const y = perUsd(baseT.solved, baseT.usd);
    return {
      ...row,
      versus: {
        baseline: baseline.name,
        common: common.size,
        onlyThis,
        onlyBaseline,
        p: mcnemarExact(onlyThis, onlyBaseline),
        ...(x !== undefined && y !== undefined && y > 0 ? { ratio: x / y } : {}),
        comparable,
      },
    };
  });
  const candidates = rows.filter((r) => r.versus !== undefined);
  const base = rows.find((r) => r.name === baseline.name) as ProtocolArm;
  const out: Protocol = { baseline: baseline.name, target, arms: rows };
  if (candidates.length > 0) {
    // The arm that decides is the best by the ratio; the line says what it did and why the target is or is not met.
    const best = [...candidates].sort((a, b) => (b.versus?.ratio ?? -1) - (a.versus?.ratio ?? -1))[0] as ProtocolArm;
    const v = best.versus as NonNullable<ProtocolArm["versus"]>;
    const ratioText = v.ratio === undefined ? "no ratio (an arm solved nothing, or spent nothing)" : `${v.ratio.toFixed(2)} times the problems solved per dollar of ${baseline.name}`;
    const met = v.comparable && v.ratio !== undefined && v.ratio >= target && best.solved >= base.solved;
    const why = !v.comparable
      ? "the arms did not finish the same problems, so no verdict is given"
      : v.ratio === undefined || v.ratio < target
        ? `the ratio is under the target ${target}`
        : best.solved < base.solved
          ? `${best.name} solves ${best.solved} against ${base.solved}: fewer problems`
          : `at least ${target} with no fewer problems solved (${best.solved} against ${base.solved})`;
    out.verdict = { met, arm: best.name, line: `Target ${met ? "met" : "not met"}: ${best.name} gives ${ratioText}; ${why}.` };
  }
  return out;
}
