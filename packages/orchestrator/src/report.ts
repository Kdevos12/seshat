import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EventDataMap, type HarnessEvent, readEvents, SITE_PROVER_SESSION } from "@seshat/core";
import { leanEnvOfConfig, type LeanEnvRecord } from "@seshat/lean-env";
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
  /** The Lean environment the run was pinned to (documentation/lean-env.md); absent for a run on a host that names none. */
  leanEnv?: LeanEnvRecord;
  /** True when the run's last `run.finished` is more recent than its last resumption: a run that was resumed and cut again has not finished. */
  finished: boolean;
  stopped?: string;
  /** The times the run continued after its process ended; absent for a run that never did. */
  resumed?: ResumedLine;
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
   * The spend by site, the biggest first: the provers' sessions under `prover.session`, the lines'
   * one-shot calls under the site they name, and `unknown` for a call recorded before the tags. It
   * shows what share of the budget each place takes, which caps what a cheaper way of deciding there
   * can save. `harness ablate` reads it with `siteSpend` and `mergeSiteSpend`.
   */
  sites: SiteLine[];
  /**
   * The redundant attempts (plan §6): of the attempts that carry a strategy label, the share that
   * failed in a way an earlier attempt on the claim, or on an equivalent one, had already failed.
   * Absent when no attempt has a label, which is every run without the M1 line.
   */
  redundancy?: Redundancy;
}

/** What one site of the harness spent (documentation/ledger.md, "Sites"). */
export interface SiteLine {
  site: string;
  /** Model responses: a session's turns, or one for a one-shot call. */
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Its part of the total cost, from 0 to 1. */
  share: number;
}

/** What the resumptions of a run found and did (documentation/ledger.md, "Resume"). */
export interface ResumedLine {
  /** How many times the run was resumed. */
  times: number;
  /** Sessions, tool runs and tasks the interruptions cut, added up. */
  interrupted: { attempts: number; toolRuns: number; tasks: number };
  /** Resumptions that found a last line of the journal cut by the crash. */
  tornTails: number;
}

export interface ToolUse {
  calls: number;
  outcomes: Record<string, number>;
  attempts: number;
  proofs: number;
}

/**
 * The spend of a run by site, the biggest first, read from its events alone: an attempt under the
 * site it started with (`prover.session` when it names none), at its own totals, or at the sum of
 * its charges when it never finished; a one-shot call under its site, or `unknown`. A function of
 * events, so that any tool that reads journals can use it.
 */
export function siteSpend(events: readonly HarnessEvent[]): SiteLine[] {
  const sites = new Map<string, Omit<SiteLine, "share">>();
  const add = (site: string, usd: number, inputTokens: number, outputTokens: number, calls: number) => {
    const entry = sites.get(site) ?? { site, calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += calls;
    entry.usd += usd;
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    sites.set(site, entry);
  };
  const siteOf = new Map<string, string>();
  const charged = new Map<string, { usd: number; inputTokens: number; outputTokens: number; calls: number }>();
  const ended = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case "attempt.started":
        siteOf.set(event.data.attemptId, event.data.site ?? SITE_PROVER_SESSION);
        break;
      case "attempt.charged": {
        const d = event.data;
        const sum = charged.get(d.attemptId) ?? { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
        sum.usd += d.usd;
        sum.inputTokens += d.inputTokens;
        sum.outputTokens += d.outputTokens;
        sum.calls += 1;
        charged.set(d.attemptId, sum);
        break;
      }
      case "attempt.finished": {
        const d = event.data;
        ended.add(d.attemptId);
        add(siteOf.get(d.attemptId) ?? SITE_PROVER_SESSION, d.usd, d.inputTokens, d.outputTokens, d.turns);
        break;
      }
      case "model_call.finished": {
        const d = event.data;
        add(d.site ?? "unknown", d.usd, d.inputTokens, d.outputTokens, 1);
        break;
      }
      default:
        break;
    }
  }
  for (const [attemptId, sum] of charged) {
    if (!ended.has(attemptId)) add(siteOf.get(attemptId) ?? SITE_PROVER_SESSION, sum.usd, sum.inputTokens, sum.outputTokens, sum.calls);
  }
  return withShares([...sites.values()]);
}

/** Adds up the spend of several runs by site (an ablation compares configs over many runs), the biggest first. */
export function mergeSiteSpend(runs: ReadonlyArray<readonly SiteLine[]>): SiteLine[] {
  const sites = new Map<string, Omit<SiteLine, "share">>();
  for (const run of runs) {
    for (const line of run) {
      const entry = sites.get(line.site) ?? { site: line.site, calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
      entry.calls += line.calls;
      entry.usd += line.usd;
      entry.inputTokens += line.inputTokens;
      entry.outputTokens += line.outputTokens;
      sites.set(line.site, entry);
    }
  }
  return withShares([...sites.values()]);
}

function withShares(lines: Array<Omit<SiteLine, "share">>): SiteLine[] {
  const total = lines.reduce((sum, line) => sum + line.usd, 0);
  return lines
    .sort((a, b) => b.usd - a.usd || a.site.localeCompare(b.site))
    .map((line) => ({ ...line, share: total > 0 ? line.usd / total : 0 }));
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
  // A run that was resumed finishes again: its end is the last one, if no resumption came after it.
  const resumptions = events.flatMap((e, seq) => (e.type === "run.resumed" ? [{ seq, data: e.data }] : []));
  const lastFinished = events.findLastIndex((e) => e.type === "run.finished");
  const finished =
    lastFinished > (resumptions.at(-1)?.seq ?? -1) ? (events[lastFinished]?.data as EventDataMap["run.finished"] | undefined) : undefined;
  const targets = new Map<string, string>();
  const problems: ProblemLine[] = [];
  const outcomes: Record<string, number> = {};
  const attempts = { total: 0, outcomes: {} as Record<string, number>, stoppedBy: {} as Record<string, number>, failures: {} as Record<string, number> };
  const capabilities = new Map<string, string>();
  const checks: { total: number; outcomes: Record<string, number>; durations: number[] } = { total: 0, outcomes: {}, durations: [] };
  const tools = new Map<string, { calls: number; outcomes: Record<string, number>; attempts: Set<string> }>();
  const proofAttempts = new Set<string>();
  const modelCalls = { total: 0, outcomes: {} as Record<string, number>, lines: {} as Record<string, number> };
  // What a session that never finished cost, from its charges.
  const charges = new Map<string, { usd: number; inputTokens: number; outputTokens: number }>();
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
      case "attempt.charged": {
        const d = event.data;
        const sum = charges.get(d.attemptId) ?? { usd: 0, inputTokens: 0, outputTokens: 0 };
        sum.usd += d.usd;
        sum.inputTokens += d.inputTokens;
        sum.outputTokens += d.outputTokens;
        charges.set(d.attemptId, sum);
        break;
      }
      case "attempt.finished": {
        const d = event.data;
        charges.delete(d.attemptId);
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
  for (const sum of charges.values()) {
    usd += sum.usd;
    inputTokens += sum.inputTokens;
    outputTokens += sum.outputTokens;
  }
  const proofs = (outcomes.proved ?? 0) + (outcomes.refuted ?? 0) + (outcomes.candidate ?? 0);
  const durations = [...checks.durations].sort((a, b) => a - b);
  const medianMs = percentile(durations, 0.5);
  const p90Ms = percentile(durations, 0.9);
  const lines = (started.config as { lines?: Array<{ id?: unknown }> } | null)?.lines?.flatMap((l) => (typeof l.id === "string" ? [l.id] : []));
  const redundant = redundancy(events);
  const leanEnv = leanEnvOfConfig(started.config);
  return {
    runId: started.runId,
    benchId: started.benchId,
    host: started.host,
    config: started.config,
    ...(started.codeRev !== undefined ? { codeRev: started.codeRev } : {}),
    ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
    ...(leanEnv !== undefined ? { leanEnv } : {}),
    finished: finished !== undefined,
    ...(finished?.stopped !== undefined ? { stopped: finished.stopped } : {}),
    ...(resumptions.length > 0
      ? {
          resumed: {
            times: resumptions.length,
            interrupted: {
              attempts: resumptions.reduce((sum, r) => sum + r.data.interrupted.attempts, 0),
              toolRuns: resumptions.reduce((sum, r) => sum + r.data.interrupted.toolRuns, 0),
              tasks: resumptions.reduce((sum, r) => sum + r.data.interrupted.tasks, 0),
            },
            tornTails: resumptions.filter((r) => r.data.tornTail !== undefined).length,
          },
        }
      : {}),
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
    sites: siteSpend(events),
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
      `${report.lines !== undefined ? ` Lines: ${report.lines.join(", ")}.` : ""}` +
      `${report.leanEnv !== undefined ? ` Lean environment: ${report.leanEnv.name}${report.leanEnv.hash !== null ? ` (${report.leanEnv.hash.slice(0, 12)})` : ", not resolved"}.` : ""}`,
    report.finished ? (report.stopped !== undefined ? `The run stopped early: ${report.stopped}.` : "The run is complete.") : "The run has not finished.",
    ...(report.resumed !== undefined
      ? [
          `The run was resumed ${report.resumed.times} time(s) after its process ended: ${report.resumed.interrupted.attempts} session(s), ` +
            `${report.resumed.interrupted.toolRuns} tool run(s) and ${report.resumed.interrupted.tasks} task(s) were cut` +
            `${report.resumed.tornTails > 0 ? `, and the journal's last line was cut ${report.resumed.tornTails} time(s)` : ""}.`,
        ]
      : []),
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
    ...(report.sites.length > 0
      ? [
          `Spend by site: ${report.sites.map((s) => `${s.site} ${money(s.usd)} (${(s.share * 100).toFixed(0)}%, ${s.calls} call(s))`).join("; ")}.`,
        ]
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
