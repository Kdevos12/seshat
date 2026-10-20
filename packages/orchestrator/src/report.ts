import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EventDataMap, type HarnessEvent, readEvents } from "@seshat/core";
import { type Redundancy, redundancy } from "@seshat/memory";

export interface ProblemLine {
  problemId: string;
  target: string;
  outcome: string;
  reason?: string;
  attempts: number;
  usd: number;
  durationMs: number;
}

/** What a run did, read from its journal alone. */
export interface RunReport {
  runId: string;
  benchId: string;
  host: string;
  config: unknown;
  codeRev?: string;
  /** The lines the run enabled, in `LINE_ORDER`; absent for an M0 run. */
  lines?: string[];
  finished: boolean;
  stopped?: string;
  /** Problems the run was given; those without a line had no outcome. */
  planned: number;
  problems: ProblemLine[];
  outcomes: Record<string, number>;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Dollars per problem with a proof: a candidate, or a certified proof or refutation; undefined when there is none. */
  usdPerProof?: number;
  attempts: { total: number; outcomes: Record<string, number>; stoppedBy: Record<string, number>; failures: Record<string, number> };
  leanChecks: { total: number; outcomes: Record<string, number>; medianMs?: number; p90Ms?: number };
  /**
   * The provers' calls of each capability besides lean.check: calls by outcome, the attempts that
   * made them, and how many of those attempts found a proof.
   */
  tools: Record<string, ToolUse>;
  /**
   * The lines' one-shot model calls, by outcome and by line; absent when there was none. Their
   * cost is in `usd` and the token counts.
   */
  modelCalls?: { total: number; outcomes: Record<string, number>; lines: Record<string, number> };
  /**
   * The redundant attempts (plan §6): of the attempts that carry a strategy label, the share that
   * failed in a way an earlier attempt on the claim, or on an equivalent one, had already failed.
   * Absent when no attempt has a label, which is every run without the M1 line.
   */
  redundancy?: Redundancy;
}

export interface ToolUse {
  calls: number;
  outcomes: Record<string, number>;
  attempts: number;
  proofs: number;
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function percentile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function buildReport(events: readonly HarnessEvent[]): RunReport {
  const started = events.find((e) => e.type === "run.started")?.data as EventDataMap["run.started"] | undefined;
  if (started === undefined) throw new Error("the journal has no run.started event");
  const finished = events.find((e) => e.type === "run.finished")?.data as EventDataMap["run.finished"] | undefined;
  const targets = new Map<string, string>();
  const problems: ProblemLine[] = [];
  const outcomes: Record<string, number> = {};
  const attempts = { total: 0, outcomes: {} as Record<string, number>, stoppedBy: {} as Record<string, number>, failures: {} as Record<string, number> };
  const capabilities = new Map<string, string>();
  const checks: { total: number; outcomes: Record<string, number>; durations: number[] } = { total: 0, outcomes: {}, durations: [] };
  const tools = new Map<string, { calls: number; outcomes: Record<string, number>; attempts: Set<string> }>();
  const proofAttempts = new Set<string>();
  const modelCalls = { total: 0, outcomes: {} as Record<string, number>, lines: {} as Record<string, number> };
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    switch (event.type) {
      case "problem.registered":
        targets.set(event.data.problemId, event.data.target);
        break;
      case "problem.finished": {
        const d = event.data;
        problems.push({
          problemId: d.problemId,
          target: targets.get(d.problemId) ?? d.problemId,
          outcome: d.outcome,
          ...(d.reason !== undefined ? { reason: d.reason } : {}),
          attempts: d.attempts,
          usd: d.usd,
          durationMs: d.durationMs,
        });
        count(outcomes, d.outcome);
        break;
      }
      case "attempt.finished": {
        const d = event.data;
        attempts.total += 1;
        count(attempts.outcomes, d.outcome);
        if (d.stoppedBy !== undefined) count(attempts.stoppedBy, d.stoppedBy);
        if (d.failureClass !== undefined) count(attempts.failures, d.failureClass);
        if (d.outcome === "valid") proofAttempts.add(d.attemptId);
        usd += d.usd;
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        break;
      }
      case "model_call.finished": {
        const d = event.data;
        modelCalls.total += 1;
        count(modelCalls.outcomes, d.outcome);
        count(modelCalls.lines, d.line);
        usd += d.usd;
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        break;
      }
      case "tool_run.started": {
        const d = event.data;
        capabilities.set(d.toolRunId, d.capability);
        // Only the provers' calls: an attempt's, and not the validator's Lean checks.
        if (d.capability === "lean.check" || d.attemptId === undefined) break;
        const use = tools.get(d.capability) ?? { calls: 0, outcomes: {}, attempts: new Set<string>() };
        tools.set(d.capability, use);
        use.calls += 1;
        use.attempts.add(d.attemptId);
        break;
      }
      case "tool_run.finished": {
        const capability = capabilities.get(event.data.toolRunId);
        if (capability !== "lean.check") {
          const use = capability === undefined ? undefined : tools.get(capability);
          if (use !== undefined) count(use.outcomes, event.data.outcome);
          break;
        }
        checks.total += 1;
        count(checks.outcomes, event.data.outcome);
        if (event.data.outcome === "ok") checks.durations.push(event.data.durationMs);
        break;
      }
      default:
        break;
    }
  }
  const proofs = (outcomes.proved ?? 0) + (outcomes.refuted ?? 0) + (outcomes.candidate ?? 0);
  const durations = [...checks.durations].sort((a, b) => a - b);
  const medianMs = percentile(durations, 0.5);
  const p90Ms = percentile(durations, 0.9);
  const lines = (started.config as { lines?: Array<{ id?: unknown }> } | null)?.lines?.flatMap((l) => (typeof l.id === "string" ? [l.id] : []));
  const redundant = redundancy(events);
  return {
    runId: started.runId,
    benchId: started.benchId,
    host: started.host,
    config: started.config,
    ...(started.codeRev !== undefined ? { codeRev: started.codeRev } : {}),
    ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
    finished: finished !== undefined,
    ...(finished?.stopped !== undefined ? { stopped: finished.stopped } : {}),
    planned: started.problems,
    problems,
    outcomes,
    usd,
    inputTokens,
    outputTokens,
    ...(proofs > 0 ? { usdPerProof: usd / proofs } : {}),
    attempts,
    leanChecks: {
      total: checks.total,
      outcomes: checks.outcomes,
      ...(medianMs !== undefined ? { medianMs } : {}),
      ...(p90Ms !== undefined ? { p90Ms } : {}),
    },
    tools: Object.fromEntries(
      [...tools].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, use]) => [
        id,
        { calls: use.calls, outcomes: use.outcomes, attempts: use.attempts.size, proofs: [...use.attempts].filter((a) => proofAttempts.has(a)).length },
      ]),
    ),
    ...(modelCalls.total > 0 ? { modelCalls } : {}),
    ...(redundant !== undefined ? { redundancy: redundant } : {}),
  };
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([k, n]) => `${n} ${k}`).join(", ");
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderRunReport(report: RunReport): string {
  const c = report.config as
    | { model?: string; provers?: number; sessions?: number; budget?: { problemUsd?: number }; tools?: { capability: string; implementation: string; version: string }[] }
    | null;
  const o = report.outcomes;
  const given = c?.tools ?? [];
  const tools = Object.entries(report.tools);
  const lines = [
    `# Run ${report.runId}`,
    "",
    `Bench ${report.benchId}, host ${report.host}${report.codeRev !== undefined ? `, code ${report.codeRev}` : ""}. ` +
      `Model ${c?.model ?? "?"}; per problem, ${c?.provers ?? "?"} prover(s) of at most ${c?.sessions ?? "?"} session(s) and ${money(c?.budget?.problemUsd ?? 0)}; ` +
      `tools: lean_check${given.length > 0 ? `, ${given.map((t) => `${t.capability} (${t.implementation} ${t.version})`).join(", ")}` : " only"}.` +
      `${report.lines !== undefined ? ` Lines: ${report.lines.join(", ")}.` : ""}`,
    report.finished ? (report.stopped !== undefined ? `The run stopped early: ${report.stopped}.` : "The run is complete.") : "The run has not finished.",
    "",
    "| Problems | |",
    "|---|---|",
    `| Proved (certified) | ${o.proved ?? 0} |`,
    `| Refuted (certified) | ${o.refuted ?? 0} |`,
    `| Candidates (fast check only) | ${o.candidate ?? 0} |`,
    `| Unsolved | ${o.unsolved ?? 0} |`,
    `| Skipped | ${o.skipped ?? 0} |`,
    `| Aborted | ${o.aborted ?? 0} |`,
    `| Harness errors | ${o.error ?? 0} |`,
    `| No outcome (not started, or the run was killed) | ${report.planned - report.problems.length} |`,
    "",
    `Cost: ${money(report.usd)} in total` +
      `${report.usdPerProof !== undefined ? `, ${money(report.usdPerProof)} per problem with a proof or a refutation` : ""}. ` +
      `Tokens: ${report.inputTokens} in, ${report.outputTokens} out.`,
    `Attempts: ${report.attempts.total} (${counts(report.attempts.outcomes)}). Sessions ended by: ${counts(report.attempts.stoppedBy)}. ` +
      `Last check of the invalid ones: ${counts(report.attempts.failures)}.`,
    `Lean checks: ${report.leanChecks.total} (${counts(report.leanChecks.outcomes)})` +
      `${report.leanChecks.medianMs !== undefined ? `; median ${(report.leanChecks.medianMs / 1000).toFixed(1)} s` : ""}` +
      `${report.leanChecks.p90Ms !== undefined ? `, 90th percentile ${(report.leanChecks.p90Ms / 1000).toFixed(1)} s` : ""}.`,
    ...tools.map(
      ([id, use]) =>
        `${id}: ${use.calls} call(s) (${counts(use.outcomes)}) in ${use.attempts} attempt(s), ` +
        `${use.proofs} of which found a proof.`,
    ),
    ...(report.modelCalls !== undefined
      ? [`The lines' model calls: ${report.modelCalls.total} (${counts(report.modelCalls.outcomes)}); by line: ${counts(report.modelCalls.lines)}.`]
      : []),
    ...(report.redundancy !== undefined
      ? [
          `Redundant attempts: ${report.redundancy.redundant} of ${report.redundancy.attempts} labeled attempts ` +
            `(${(report.redundancy.share * 100).toFixed(0)}%) failed again as an earlier attempt on the same claim or an equivalent one had.`,
        ]
      : []),
    "Measured: validity and cost. Not measured here: the fidelity of the formal statements, taken as given by the bench, " +
      "and novelty, since the bench's problems are solved ones.",
    "",
    "| Problem | Outcome | Attempts | Cost | Time | Note |",
    "|---|---|---|---|---|---|",
    ...report.problems.map(
      (p) =>
        `| ${cell(p.target)} | ${p.outcome} | ${p.attempts} | ${money(p.usd)} | ${Math.round(p.durationMs / 1000)} s | ${cell((p.reason ?? "").slice(0, 200))} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/** Writes `report.md` and `report.json` in a run directory, from its journal. */
export function writeReport(dir: string): RunReport {
  const report = buildReport(readEvents(join(dir, "journal.jsonl")));
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderRunReport(report));
  return report;
}
