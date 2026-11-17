import { HOLE_FALSE_VERDICT, HOLE_VERDICT_KIND, type HarnessEvent } from "@seshat/core";

export { HOLE_FALSE_VERDICT, HOLE_VERDICT_KIND };

/**
 * Loop telemetry (plan change CA3): where a run's dollars and minutes go, read from the journal alone. Per attempt (a session of a
 * prover), the Lean checks it made, the seconds a check took, the output tokens per check, the dollars by cache hit, cache miss and
 * output, the context at the end and the stop reason; per problem, the rate of repeated failures, the open holes over time and the
 * share of proposed sub-lemmas that turned out false. A number the journal does not hold (a journal older than the fields that carry it,
 * or a mechanism that has not run) is absent, and the report says "not recorded".
 */

export interface AttemptLoop {
  attemptId: string;
  problemId?: string;
  /** `attempt.finished.checks`, else the `lean.check` tool runs of the attempt. */
  checks: number;
  /** Seconds per Lean check of the attempt, from its tool runs; absent without one. */
  medianSec?: number;
  p95Sec?: number;
  /** Output tokens over checks; absent without a check. */
  outputTokensPerCheck?: number;
  usd: number;
  /** Dollars by cache hit, cache miss (and cache writes) and output; absent when the charges did not record the split. */
  split?: { cacheHitUsd: number; cacheMissUsd: number; outputUsd: number };
  /** Input tokens of the attempt's last request: the context it ended with. Absent without a charge. */
  endContextTokens?: number;
  stoppedBy?: string;
}

export interface ProblemLoop {
  problemId: string;
  attempts: number;
  /** Invalid attempts whose failure (class and detail) an earlier attempt of the problem already had, over the invalid attempts that name one. */
  repeatedFailures?: { repeated: number; failed: number; rate: number };
  /** Open holes (Lean's `sorry` goals) after each check, over the attempts in the order they ended. */
  openHoles: number[];
}

export interface LoopTelemetry {
  attempts: AttemptLoop[];
  problems: ProblemLoop[];
  totals: {
    checks: number;
    medianSec?: number;
    p95Sec?: number;
    outputTokensPerCheck?: number;
    split?: { cacheHitUsd: number; cacheMissUsd: number; outputUsd: number };
    medianEndContextTokens?: number;
    stoppedBy: Record<string, number>;
  };
  /**
   * Sub-lemmas a mechanism proposed, over those with a verdict (absent when none was recorded): `wrong` counts the `statement_wrong` verdicts whose negation Lean accepted
   * (`negationValidated`); `suspected` the ones that only a prover or a tool says are false, which are not counted as false.
   */
  holes?: { verdicts: number; wrong: number; share: number; suspected?: number };
}

function quantile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// The kind of the memory node a mechanism writes for the verdict of a proposed sub-lemma, and its false verdict (CA11), live in `@seshat/core`.

export function loopTelemetry(events: readonly HarnessEvent[]): LoopTelemetry {
  const taskProblem = new Map<string, string>();
  const attemptProblem = new Map<string, string>();
  const runs = new Map<string, { attemptId: string; startedSeq: number }>();
  const durations = new Map<string, number[]>();
  const charges = new Map<string, { usd: number; hit: number; out: number; recorded: boolean; lastInput: number | undefined }>();
  const finished: Array<{ attemptId: string; seq: number; data: Extract<HarnessEvent, { type: "attempt.finished" }>["data"] }> = [];
  let verdicts = 0;
  let wrong = 0;
  let suspected = 0;
  events.forEach((e, seq) => {
    switch (e.type) {
      case "task.created":
        if (e.data.problemId !== undefined) taskProblem.set(e.data.taskId, e.data.problemId);
        break;
      case "attempt.started": {
        const problemId = e.data.taskId === undefined ? undefined : taskProblem.get(e.data.taskId);
        if (problemId !== undefined) attemptProblem.set(e.data.attemptId, problemId);
        break;
      }
      case "tool_run.started":
        if (e.data.capability === "lean.check" && e.data.attemptId !== undefined) runs.set(e.data.toolRunId, { attemptId: e.data.attemptId, startedSeq: seq });
        break;
      case "tool_run.finished": {
        const run = runs.get(e.data.toolRunId);
        if (run !== undefined && e.data.outcome !== "aborted") durations.set(run.attemptId, [...(durations.get(run.attemptId) ?? []), e.data.durationMs / 1000]);
        break;
      }
      case "attempt.charged": {
        const c = charges.get(e.data.attemptId) ?? { usd: 0, hit: 0, out: 0, recorded: false, lastInput: undefined };
        c.usd += e.data.usd;
        c.hit += e.data.cacheReadUsd ?? 0;
        c.out += e.data.outputUsd ?? 0;
        c.recorded ||= e.data.cacheReadUsd !== undefined || e.data.outputUsd !== undefined;
        // A response cut by a transient error has no context to speak of.
        if (e.data.retry === undefined) c.lastInput = e.data.inputTokens;
        charges.set(e.data.attemptId, c);
        break;
      }
      case "attempt.finished":
        finished.push({ attemptId: e.data.attemptId, seq, data: e.data });
        break;
      case "node.recorded":
        if (e.type === "node.recorded" && e.data.kind === HOLE_VERDICT_KIND) {
          const node = e.data.data as { verdict?: unknown; negationValidated?: unknown } | null;
          if (typeof node?.verdict === "string") {
            verdicts += 1;
            if (node.verdict === HOLE_FALSE_VERDICT) {
              if (node.negationValidated === true) wrong += 1;
              else suspected += 1;
            }
          }
        }
        break;
      default:
        break;
    }
  });

  const attempts: AttemptLoop[] = finished.map(({ attemptId, data }) => {
    const problemId = attemptProblem.get(attemptId);
    const secs = durations.get(attemptId) ?? [];
    const checks = data.checks ?? secs.length;
    const charge = charges.get(attemptId);
    const split =
      charge?.recorded === true
        ? { cacheHitUsd: charge.hit, outputUsd: charge.out, cacheMissUsd: Math.max(0, data.usd - charge.hit - charge.out) }
        : undefined;
    const median = quantile(secs, 0.5);
    const p95 = quantile(secs, 0.95);
    return {
      attemptId,
      ...(problemId !== undefined ? { problemId } : {}),
      checks,
      ...(median !== undefined ? { medianSec: median } : {}),
      ...(p95 !== undefined ? { p95Sec: p95 } : {}),
      ...(checks > 0 ? { outputTokensPerCheck: data.outputTokens / checks } : {}),
      usd: data.usd,
      ...(split !== undefined ? { split } : {}),
      ...(charge?.lastInput !== undefined ? { endContextTokens: charge.lastInput } : {}),
      ...(data.stoppedBy !== undefined ? { stoppedBy: data.stoppedBy } : {}),
    };
  });

  const byProblem = new Map<string, typeof finished>();
  for (const f of finished) {
    const problemId = attemptProblem.get(f.attemptId);
    if (problemId !== undefined) byProblem.set(problemId, [...(byProblem.get(problemId) ?? []), f]);
  }
  const problems: ProblemLoop[] = [...byProblem].sort(([a], [b]) => (a < b ? -1 : 1)).map(([problemId, list]) => {
    const seen = new Set<string>();
    let failed = 0;
    let repeated = 0;
    for (const { data } of list) {
      if (data.outcome !== "invalid") continue;
      const signature = data.failureDetail ?? data.failureClass;
      if (signature === undefined) continue;
      failed += 1;
      if (seen.has(signature)) repeated += 1;
      seen.add(signature);
    }
    return {
      problemId,
      attempts: list.length,
      ...(failed > 0 ? { repeatedFailures: { repeated, failed, rate: repeated / failed } } : {}),
      openHoles: list.flatMap(({ data }) => data.holes ?? []),
    };
  });

  const allSecs = [...durations.values()].flat();
  const checks = attempts.reduce((n, a) => n + a.checks, 0);
  const outputTokens = finished.reduce((n, f) => n + f.data.outputTokens, 0);
  const splits = attempts.flatMap((a) => (a.split === undefined ? [] : [a.split]));
  const stoppedBy: Record<string, number> = {};
  for (const a of attempts) if (a.stoppedBy !== undefined) stoppedBy[a.stoppedBy] = (stoppedBy[a.stoppedBy] ?? 0) + 1;
  const median = quantile(allSecs, 0.5);
  const p95 = quantile(allSecs, 0.95);
  const endContext = quantile(attempts.flatMap((a) => (a.endContextTokens === undefined ? [] : [a.endContextTokens])), 0.5);
  return {
    attempts,
    problems,
    totals: {
      checks,
      ...(median !== undefined ? { medianSec: median } : {}),
      ...(p95 !== undefined ? { p95Sec: p95 } : {}),
      ...(checks > 0 ? { outputTokensPerCheck: outputTokens / checks } : {}),
      ...(splits.length > 0
        ? { split: { cacheHitUsd: splits.reduce((n, s) => n + s.cacheHitUsd, 0), cacheMissUsd: splits.reduce((n, s) => n + s.cacheMissUsd, 0), outputUsd: splits.reduce((n, s) => n + s.outputUsd, 0) } }
        : {}),
      ...(endContext !== undefined ? { medianEndContextTokens: endContext } : {}),
      stoppedBy,
    },
    ...(verdicts > 0 ? { holes: { verdicts, wrong, share: wrong / verdicts, ...(suspected > 0 ? { suspected } : {}) } } : {}),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const sec = (x: number | undefined): string => (x === undefined ? "n/a" : `${x.toFixed(1)} s`);
const usd = (x: number): string => `$${x.toFixed(3)}`;

function series(values: readonly number[], limit = 12): string {
  if (values.length === 0) return "not recorded";
  const step = Math.max(1, Math.ceil(values.length / limit));
  const picked = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  return picked.join(" > ");
}

/** The "Loop" section of the report, as markdown lines. Empty when the run made no attempt. */
export function renderLoop(loop: LoopTelemetry): string[] {
  if (loop.attempts.length === 0) return [];
  const t = loop.totals;
  const out: string[] = ["## Loop", ""];
  out.push(
    `${loop.attempts.length} attempt(s), ${t.checks} Lean check(s). A check takes ${sec(t.medianSec)} at the median and ${sec(t.p95Sec)} at the 95th centile; ` +
      `${t.outputTokensPerCheck === undefined ? "no output tokens per check" : `${t.outputTokensPerCheck.toFixed(0)} output token(s) per check`}; ` +
      `a session ends with a context of ${t.medianEndContextTokens === undefined ? "n/a" : `${t.medianEndContextTokens.toFixed(0)} token(s)`} at the median.`,
  );
  if (t.split !== undefined) {
    const sum = t.split.cacheHitUsd + t.split.cacheMissUsd + t.split.outputUsd;
    out.push(
      sum > 0
        ? `Dollars by cache hit ${pct(t.split.cacheHitUsd / sum)}, cache miss ${pct(t.split.cacheMissUsd / sum)} (writes included), output ${pct(t.split.outputUsd / sum)}.`
        : "Dollars by cache hit, miss and output: nothing was spent.",
    );
  } else out.push("Dollars by cache hit, miss and output: not recorded (the journal's charges do not carry the split).");
  out.push(`Stop reasons: ${Object.entries(t.stoppedBy).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "not recorded"}.`);
  out.push(loop.holes === undefined ? "Proposed sub-lemmas that turned out false: not recorded." : `Proposed sub-lemmas that turned out false (a Lean-checked negation): ${loop.holes.wrong} of ${loop.holes.verdicts} (${pct(loop.holes.share)}).${loop.holes.suspected !== undefined ? ` Suspected false, unverified: ${loop.holes.suspected}.` : ""}`, "");
  out.push("| Attempt | Checks | Median / 95th s | Output tokens per check | Hit / miss / output $ | End context | Stopped by |", "|---|---|---|---|---|---|---|");
  for (const a of loop.attempts) {
    out.push(
      `| ${a.attemptId} | ${a.checks} | ${a.medianSec === undefined ? "n/a" : `${a.medianSec.toFixed(1)} / ${(a.p95Sec ?? a.medianSec).toFixed(1)}`} | ${a.outputTokensPerCheck === undefined ? "n/a" : a.outputTokensPerCheck.toFixed(0)} | ${
        a.split === undefined ? "not recorded" : `${usd(a.split.cacheHitUsd)} / ${usd(a.split.cacheMissUsd)} / ${usd(a.split.outputUsd)}`
      } | ${a.endContextTokens ?? "n/a"} | ${a.stoppedBy ?? "n/a"} |`,
    );
  }
  if (loop.problems.length > 0) {
    out.push("", "| Problem | Attempts | Repeated failures | Open holes over time |", "|---|---|---|---|");
    for (const p of loop.problems) {
      out.push(`| ${p.problemId.replace(/\|/g, "\\|")} | ${p.attempts} | ${p.repeatedFailures === undefined ? "no failure" : `${p.repeatedFailures.repeated} of ${p.repeatedFailures.failed} (${pct(p.repeatedFailures.rate)})`} | ${series(p.openHoles)} |`);
    }
  }
  return [...out, ""];
}
