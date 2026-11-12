import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chainOfJournal,
  type EventDataMap,
  type HarnessEvent,
  type MemoryFrom,
  type MemorySummary,
  Projection,
  readEvents,
  SITE_PROVER_SESSION,
} from "@seshat/core";
import { leanEnvOfConfig, type LeanEnvRecord } from "@seshat/lean-env";
import { heuristicReport, type HeuristicStats, renderHeuristicReport } from "@seshat/heuristics";
import { type LessonReport, lessonReport, renderLessonReport } from "@seshat/lessons";
import { type ArchiveReport, archiveReport, renderArchiveReport } from "@seshat/scheduler";
import { type LibraryReport, libraryReport, renderLibraryReport } from "@seshat/library";
import { type Redundancy, redundancy } from "@seshat/memory";
import { type CacheReport, cacheReport } from "./cache-report.ts";
import { type LoopTelemetry, loopTelemetry, renderLoop } from "./loop-telemetry.ts";
import { type GateReport, gateReport, renderGateReport } from "./gate-report.ts";
import { type GraphReport, graphReport, renderGraphReport } from "./graph-report.ts";
import { type IntakeLine, intakeLines, renderIntake } from "./intake.ts";

export interface ProblemLine {
  problemId: string;
  target: string;
  outcome: string;
  reason?: string;
  attempts: number;
  usd: number;
  durationMs: number;
  /**
   * The escalation ladder (documentation/scheduler.md, "The ladder"): the rung that was on when the
   * problem ended and the dollars spent at each rung. Present for a run with the M12 line or a
   * `ladder.escalated` event; `solvedAtRung` is only for a certified outcome (`proved` or `refuted`): absent for a candidate, which the certifier has not confirmed, and for a problem with none.
   */
  ladder?: { endedAtRung: number; solvedAtRung?: number; usdByRung: Record<string, number> };
}

/** What a run did, read from its journal alone. */
export interface RunReport {
  /** Where the dollars and minutes of the loop go (plan change CA3, documentation/report.md); absent when the run made no attempt. */
  loop?: LoopTelemetry;
  runId: string;
  benchId: string;
  host: string;
  config: unknown;
  codeRev?: string;
  /** The lines the run enabled, in `LINE_ORDER`; absent for an M0 run. */
  lines?: string[];
  /** The Lean environment the run was pinned to (documentation/lean-env.md); absent for a run on a host that names none. */
  leanEnv?: LeanEnvRecord;
  /** The installed packs the run used, by content hash (documentation/packs.md); absent when none was installed. */
  packs?: Array<{ name: string; version: string; hash: string }>;
  /** True when the run's last `run.finished` is more recent than its last resumption: a run that was resumed and cut again has not finished. */
  finished: boolean;
  stopped?: string;
  /** The times the run continued after its process ended; absent for a run that never did. */
  resumed?: ResumedLine;
  /** The turns of a consortium run (documentation/human.md); absent for any other run. */
  turns?: TurnsLine;
  /** Problems the run was given; those without a line had no outcome. */
  planned: number;
  problems: ProblemLine[];
  outcomes: Record<string, number>;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, the ones the provider read from its prompt cache (pi-ai's `cacheRead`). */
  cachedInputTokens: number;
  /**
   * The prompt cache (documentation/m0-loop.md, "Prices"): per session, per line and, when the run had a ladder, per
   * rung, the share of input tokens read from the cache and the dollars it saved against a price with no cache. Absent
   * when nothing was charged.
   */
  cache?: CacheReport;
  /**
   * Where the dollars cannot be trusted (documentation/m0-loop.md, "Prices"): responses charged $0 for tokens, which no
   * dollar budget sees, and the dollars pi-ai reported above the host's price table. Absent when there are none.
   */
  priceGaps?: { unpricedResponses: number; unpricedInputTokens: number; unchargedUsd: number };
  /**
   * What the host's off-peak rate and `--offpeak` did: the dollars charged at the off-peak rate, and the waits for
   * off-peak hours (`turn.deferred`). Absent when there was neither.
   */
  offPeak?: OffPeakLine;
  /** Dollars per problem with a proof: a candidate, or a certified proof or refutation; undefined when there is none. */
  usdPerProof?: number;
  attempts: { total: number; outcomes: Record<string, number>; stoppedBy: Record<string, number>; failures: Record<string, number> };
  leanChecks: { total: number; outcomes: Record<string, number>; medianMs?: number; p90Ms?: number };
  /**
   * The harness's search of Lean declarations (`RunConfig.leanSearch`): the requests to `lean.search` and the `lean.check` runs that verify
   * their hits, apart from `leanChecks`, which counts the provers' and the validator's own. Absent when the run made none.
   */
  leanSearch?: { requests: number; requestMs: number; checks: number; checkMs: number };
  /** What lines M2 and M4 did (`graph-report.ts`), from the journal alone. Absent when neither was enabled. */
  graph?: GraphReport;
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
   * The sessions' requests sent again after a transient error cut their response (documentation/m0-loop.md, "Transient errors"):
   * how many, in how many attempts, and what the cut responses were charged (in `usd` already). Absent when there was none.
   */
  retries?: { requests: number; attempts: number; usd: number };
  /**
   * The sessions that the repeat rule of line M6 ended (plan change CA7, documentation/guards.md): the reason each journaled, which names the
   * failure and the strategy. Absent when there was none.
   */
  repeatStops?: string[];
  /** The run's budget in rounds (plan change CA8): the rounds that began and the problems parked, with the round and what they had spent. Absent when the run had none. */
  rounds?: { rounds: number; capUsd: number; parked: Array<{ problemId: string; round: number; usd: number }> };
  /**
   * The spend by site, the biggest first: the provers' sessions under `prover.session`, the lines'
   * one-shot calls under the site they name, and `unknown` for a call recorded before the tags. It
   * shows what share of the budget each place takes, which caps what a cheaper way of deciding there
   * can save. `harness ablate` reads it with `siteSpend` and `mergeSiteSpend`.
   */
  sites: SiteLine[];
  /**
   * The budget gate (documentation/scheduler.md, "The budget gate"): per site what it launched and skipped, the probes and widenings, and the
   * avoided spend as the gate's estimate. Absent when the run had no gate.
   */
  gate?: GateReport;
  /**
   * The redundant attempts (plan §6): of the attempts that carry a strategy label, the share that
   * failed in a way an earlier attempt on the claim, or on an equivalent one, had already failed.
   * Absent when no attempt has a label, which is every run without the M1 line.
   */
  redundancy?: Redundancy;
  /**
   * The lemma library (line M3, documentation/library.md): lemmas by domain, what the candidates came to, the share of accepted
   * proofs that use a library lemma, and the proofs that use a declaration of each source. Absent when the run recorded nothing of it.
   */
  library?: LibraryReport;
  /**
   * The lessons (line M5, documentation/lessons.md): their states, the presence counters, and the accepted attempts among those
   * that were drawn each lesson, with it and without it. Absent when the run recorded none.
   */
  lessons?: LessonReport;
  /**
   * The bank of heuristic cards (documentation/heuristics.md, "Statistics"): sessions given each family and card, against
   * the control of the same buckets, and how often a tactic card's session went the card's way. Absent with the bank off.
   */
  heuristics?: HeuristicStats;
  /**
   * The archive of decompositions and the schemas (line M15, documentation/archive.md): the cells filled, the diversity of mechanisms,
   * how the picks of a cell fared, and the schema hints with and without the draw. Absent when the run recorded none.
   */
  archive?: ArchiveReport;
  /**
   * What the run took from the earlier journals it started on (`--memory-from`); absent for a run that
   * started on none. The problems' outcomes above are the run's own certifications: nothing here is
   * credited to them.
   */
  memory?: MemoryLine;
  /** The intake step of each problem that had one (Task 36, documentation/literature.md); absent for a run without it. */
  intake?: IntakeLine[];
}

/** Off-peak spend and waits (documentation/human.md, "Off-peak"). */
export interface OffPeakLine {
  /** Dollars charged at the off-peak rate, and the share of the run's dollars they are. */
  usd: number;
  share: number;
  /** Waits for off-peak hours, how many ran anyway at a peak price because the wait limit came first, and the minutes waited in all. */
  deferred: number;
  ranAnyway: number;
  waitedMinutes: number;
}

/** The earlier memory a run started on (documentation/memory.md, "Memory across runs"). */
export interface MemoryLine {
  /** The run `run.started` names, with the hash and length of its journal that the run pinned. */
  from: MemoryFrom;
  /** The journals of the chain, the run named and the ones it was started on in turn. */
  journals: number;
  /** True when every journal of the chain was recorded in the Lean environment of this run: verified statuses carried. */
  sameEnvironment: boolean;
  /** What came from the chain; absent when the chain could not be read when the report was made. */
  taken?: MemorySummary;
  /** Why the chain could not be read. */
  unavailable?: string;
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

/** The turns of a consortium run: how many, why each ended, and whether the run waits for the team. */
export interface TurnsLine {
  /** Turns that began. */
  count: number;
  /** The turns' endings, by reason. */
  reasons: Record<string, number>;
  /** True when the last turn ended and problems still wait for the team: the run is paused, not finished. */
  paused: boolean;
  /** The last turn that ended. */
  last?: { turn: number; reason: string; detail: string; waiting: number };
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

/**
 * The dollars of each problem by ladder rung, from the events alone. A problem is at rung 0 until a
 * `ladder.escalated` event moves it. A session's cost counts at the rung of its `attempt.finished` (or
 * of its charges, when it never finished) and a one-shot call at the rung of its own event; a session
 * is a problem's through the task it works for.
 */
export function rungSpend(events: readonly HarnessEvent[]): Map<string, { endedAtRung: number; usdByRung: Record<string, number> }> {
  const out = new Map<string, { endedAtRung: number; usdByRung: Record<string, number> }>();
  const rungs = new Map<string, number>();
  const taskProblem = new Map<string, string>();
  const attemptProblem = new Map<string, string>();
  const unfinished = new Map<string, Array<{ problemId: string; usd: number; rung: number }>>();
  const entry = (problemId: string) => {
    const found = out.get(problemId) ?? { endedAtRung: 0, usdByRung: {} };
    out.set(problemId, found);
    return found;
  };
  const add = (problemId: string, rung: number, usd: number) => {
    const e = entry(problemId);
    e.usdByRung[String(rung)] = (e.usdByRung[String(rung)] ?? 0) + usd;
  };
  for (const event of events) {
    switch (event.type) {
      case "problem.registered":
        entry(event.data.problemId);
        break;
      case "task.created":
        if (event.data.problemId !== undefined) taskProblem.set(event.data.taskId, event.data.problemId);
        break;
      case "attempt.started": {
        const problemId = event.data.taskId === undefined ? undefined : taskProblem.get(event.data.taskId);
        if (problemId !== undefined) attemptProblem.set(event.data.attemptId, problemId);
        break;
      }
      case "ladder.escalated":
        rungs.set(event.data.problemId, event.data.to);
        entry(event.data.problemId).endedAtRung = event.data.to;
        break;
      case "attempt.charged": {
        const problemId = attemptProblem.get(event.data.attemptId);
        if (problemId === undefined) break;
        const list = unfinished.get(event.data.attemptId) ?? [];
        list.push({ problemId, usd: event.data.usd, rung: rungs.get(problemId) ?? 0 });
        unfinished.set(event.data.attemptId, list);
        break;
      }
      case "attempt.finished": {
        unfinished.delete(event.data.attemptId);
        const problemId = attemptProblem.get(event.data.attemptId);
        if (problemId !== undefined) add(problemId, rungs.get(problemId) ?? 0, event.data.usd);
        break;
      }
      case "model_call.finished": {
        const problemId = event.data.problemId ?? (event.data.attemptId === undefined ? undefined : attemptProblem.get(event.data.attemptId));
        // A call made by a session is in the session's totals already.
        if (problemId !== undefined && event.data.attemptId === undefined) add(problemId, rungs.get(problemId) ?? 0, event.data.usd);
        break;
      }
      default:
        break;
    }
  }
  for (const charges of unfinished.values()) for (const c of charges) add(c.problemId, c.rung, c.usd);
  return out;
}

export function buildReport(events: readonly HarnessEvent[]): RunReport {
  const loop = loopTelemetry(events);
  const started = events.find((e) => e.type === "run.started")?.data as EventDataMap["run.started"] | undefined;
  if (started === undefined) throw new Error("the journal has no run.started event");
  // A run that was resumed finishes again: its end is the last one, if no resumption came after it.
  const resumptions = events.flatMap((e, seq) => (e.type === "run.resumed" ? [{ seq, data: e.data }] : []));
  // A resumption that follows a turn the run ended by itself (a limit, a breakpoint) is the next turn, not the repair of a process
  // that ended: the tasks it finds `running` were left so by design. Only the other resumptions are interruptions.
  const crashed = resumptions.filter((r) => {
    const before = events.slice(0, r.seq).findLast((e) => e.type === "turn.started" || e.type === "turn.ended");
    return !(before?.type === "turn.ended" && before.data.reason !== "interrupted");
  });
  const lastFinished = events.findLastIndex((e) => e.type === "run.finished");
  const finished =
    lastFinished > (resumptions.at(-1)?.seq ?? -1) ? (events[lastFinished]?.data as EventDataMap["run.finished"] | undefined) : undefined;
  const turnEnds = events.flatMap((e) => (e.type === "turn.ended" ? [e.data] : []));
  const turnsStarted = events.filter((e) => e.type === "turn.started").length;
  const lastTurnEnd = turnEnds.at(-1);
  const targets = new Map<string, string>();
  const rungLines = rungSpend(events);
  const rungsOn = events.some((e) => e.type === "ladder.escalated") || (started.config as { lines?: Array<{ id?: unknown }> } | null)?.lines?.some((l) => l.id === "M12") === true;
  const problems: ProblemLine[] = [];
  const outcomes: Record<string, number> = {};
  const attempts = { total: 0, outcomes: {} as Record<string, number>, stoppedBy: {} as Record<string, number>, failures: {} as Record<string, number> };
  const repeatStops: string[] = [];
  const rotation = { rounds: 0, capUsd: 0, parked: [] as Array<{ problemId: string; round: number; usd: number }> };
  const capabilities = new Map<string, string>();
  const checks: { total: number; outcomes: Record<string, number>; durations: number[] } = { total: 0, outcomes: {}, durations: [] };
  // The search's own runs (actor `lean.search`): its requests, and the Lean checks that verify its hits. They are not the provers' checks.
  const search = { requests: 0, requestMs: 0, checks: 0, checkMs: 0 };
  const searchRuns = new Map<string, "requests" | "checks">();
  const tools = new Map<string, { calls: number; outcomes: Record<string, number>; attempts: Set<string> }>();
  const proofAttempts = new Set<string>();
  const modelCalls = { total: 0, outcomes: {} as Record<string, number>, lines: {} as Record<string, number> };
  // What a session that never finished cost, from its charges.
  const charges = new Map<string, { usd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  // The cache reads each attempt was charged, kept after the attempt ends. An `attempt.finished` that
  // the harness wrote from the charges (a session the harness failed in, or one a resumption cut)
  // carries no `cachedInputTokens`: the charges are the only record of them. A finished total, when
  // it has one, is the sum of the same charges, so the larger of the two is the attempt's figure.
  const cachedCharged = new Map<string, number>();
  // The same for the dollars charged at the off-peak rate, and the waits for off-peak hours.
  const offPeakCharged = new Map<string, number>();
  // Responses charged $0 for tokens (a model with no price anywhere), and the dollars pi-ai reported above the host's table.
  const gaps = { unpricedResponses: 0, unpricedInputTokens: 0, unchargedUsd: 0 };
  const gap = (d: { usd: number; inputTokens: number; unchargedUsd?: number }) => {
    if (d.usd === 0 && d.inputTokens > 0) {
      gaps.unpricedResponses += 1;
      gaps.unpricedInputTokens += d.inputTokens;
    }
    gaps.unchargedUsd += d.unchargedUsd ?? 0;
  };
  let offPeakUsd = 0;
  const waits = { deferred: 0, ranAnyway: 0, waitedMinutes: 0 };
  const retries = { requests: 0, attempts: new Set<string>(), usd: 0 };

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
          ...(rungsOn
            ? {
                ladder: {
                  endedAtRung: rungLines.get(d.problemId)?.endedAtRung ?? 0,
                  ...(d.outcome === "proved" || d.outcome === "refuted" || d.outcome === "candidate"
                    ? { solvedAtRung: rungLines.get(d.problemId)?.endedAtRung ?? 0 }
                    : {}),
                  usdByRung: rungLines.get(d.problemId)?.usdByRung ?? {},
                },
              }
            : {}),
        });
        count(outcomes, d.outcome);
        break;
      }
      case "attempt.charged": {
        const d = event.data;
        const sum = charges.get(d.attemptId) ?? { usd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        sum.usd += d.usd;
        sum.inputTokens += d.inputTokens;
        sum.outputTokens += d.outputTokens;
        sum.cachedInputTokens += d.cachedInputTokens ?? 0;
        charges.set(d.attemptId, sum);
        cachedCharged.set(d.attemptId, (cachedCharged.get(d.attemptId) ?? 0) + (d.cachedInputTokens ?? 0));
        offPeakCharged.set(d.attemptId, (offPeakCharged.get(d.attemptId) ?? 0) + (d.offPeakUsd ?? 0));
        gap(d);
        if (d.retry !== undefined) {
          retries.requests += 1;
          retries.attempts.add(d.attemptId);
          retries.usd += d.usd;
        }
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
        cachedInputTokens += Math.max(d.cachedInputTokens ?? 0, cachedCharged.get(d.attemptId) ?? 0);
        offPeakUsd += Math.max(d.offPeakUsd ?? 0, offPeakCharged.get(d.attemptId) ?? 0);
        break;
      }
      case "budget.round":
        rotation.rounds += 1;
        rotation.capUsd = event.data.capUsd;
        break;
      case "problem.parked":
        rotation.parked.push({ problemId: event.data.problemId, round: event.data.round, usd: event.data.usd });
        break;
      case "node.recorded": {
        const d = event.data.data;
        if (event.data.kind === "drift" && typeof d === "object" && d !== null && !Array.isArray(d) && d.kind === "repeated_failure" && d.action === "stopped_session" && typeof d.detail === "string") {
          repeatStops.push(d.detail);
        }
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
        cachedInputTokens += d.cachedInputTokens ?? 0;
        offPeakUsd += d.offPeakUsd ?? 0;
        gap(d);
        break;
      }
      case "turn.deferred": {
        const d = event.data;
        waits.deferred += 1;
        if (d.bounded) waits.ranAnyway += 1;
        waits.waitedMinutes += (Date.parse(d.until) - Date.parse(d.from)) / 60_000;
        break;
      }
      case "tool_run.started": {
        const d = event.data;
        capabilities.set(d.toolRunId, d.capability);
        if (event.actor === "lean.search" && (d.capability === "lean.check" || d.capability === "lean.search")) {
          searchRuns.set(d.toolRunId, d.capability === "lean.check" ? "checks" : "requests");
          break;
        }
        // Only the provers' calls: an attempt's, and not the validator's Lean checks.
        if (d.capability === "lean.check" || d.attemptId === undefined) break;
        const use = tools.get(d.capability) ?? { calls: 0, outcomes: {}, attempts: new Set<string>() };
        tools.set(d.capability, use);
        use.calls += 1;
        use.attempts.add(d.attemptId);
        break;
      }
      case "tool_run.finished": {
        const searchKind = searchRuns.get(event.data.toolRunId);
        if (searchKind !== undefined) {
          search[searchKind] += 1;
          search[searchKind === "checks" ? "checkMs" : "requestMs"] += event.data.durationMs;
          break;
        }
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
    cachedInputTokens += sum.cachedInputTokens;
  }
  for (const [attemptId, value] of offPeakCharged) if (charges.has(attemptId)) offPeakUsd += value;
  const proofs = (outcomes.proved ?? 0) + (outcomes.refuted ?? 0) + (outcomes.candidate ?? 0);
  const graph = graphReport(events, (started.config as { lines?: Array<{ id?: unknown }> } | null)?.lines?.flatMap((l) => (typeof l.id === "string" ? [l.id] : [])));
  const durations = [...checks.durations].sort((a, b) => a - b);
  const medianMs = percentile(durations, 0.5);
  const p90Ms = percentile(durations, 0.9);
  const lines = (started.config as { lines?: Array<{ id?: unknown }> } | null)?.lines?.flatMap((l) => (typeof l.id === "string" ? [l.id] : []));
  const redundant = redundancy(events);
  const library = libraryReport(events);
  const lessons = lessonReport(events);
  const heuristics = heuristicReport(events);
  const archive = archiveReport(events);
  const cache = cacheReport(events);
  const leanEnv = leanEnvOfConfig(started.config);
  const recordedPacks = (started.config as { packs?: unknown } | null)?.packs;
  const packs = Array.isArray(recordedPacks) ? (recordedPacks as Array<{ name: string; version: string; hash: string }>) : [];
  return {
    runId: started.runId,
    benchId: started.benchId,
    host: started.host,
    config: started.config,
    ...(started.codeRev !== undefined ? { codeRev: started.codeRev } : {}),
    ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
    ...(leanEnv !== undefined ? { leanEnv } : {}),
    ...(packs.length > 0 ? { packs } : {}),
    finished: finished !== undefined,
    ...(finished?.stopped !== undefined ? { stopped: finished.stopped } : {}),
    ...(crashed.length > 0
      ? {
          resumed: {
            times: crashed.length,
            interrupted: {
              attempts: crashed.reduce((sum, r) => sum + r.data.interrupted.attempts, 0),
              toolRuns: crashed.reduce((sum, r) => sum + r.data.interrupted.toolRuns, 0),
              tasks: crashed.reduce((sum, r) => sum + r.data.interrupted.tasks, 0),
            },
            tornTails: crashed.filter((r) => r.data.tornTail !== undefined).length,
          },
        }
      : {}),
    ...(turnsStarted > 0
      ? {
          turns: {
            count: turnsStarted,
            reasons: turnEnds.reduce<Record<string, number>>((all, end) => ({ ...all, [end.reason]: (all[end.reason] ?? 0) + 1 }), {}),
            paused: finished === undefined && lastTurnEnd !== undefined && lastTurnEnd.turn === turnsStarted && lastTurnEnd.waiting.length > 0,
            ...(lastTurnEnd !== undefined ? { last: { turn: lastTurnEnd.turn, reason: lastTurnEnd.reason, detail: lastTurnEnd.detail, waiting: lastTurnEnd.waiting.length } } : {}),
          },
        }
      : {}),
    planned: started.problems,
    problems,
    outcomes,
    usd,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cache !== undefined ? { cache } : {}),
    ...(gaps.unpricedResponses > 0 || gaps.unchargedUsd > 0 ? { priceGaps: gaps } : {}),
    ...(offPeakUsd > 0 || waits.deferred > 0
      ? { offPeak: { usd: offPeakUsd, share: usd > 0 ? offPeakUsd / usd : 0, ...waits } }
      : {}),
    ...(proofs > 0 ? { usdPerProof: usd / proofs } : {}),
    attempts,
    leanChecks: {
      total: checks.total,
      outcomes: checks.outcomes,
      ...(medianMs !== undefined ? { medianMs } : {}),
      ...(p90Ms !== undefined ? { p90Ms } : {}),
    },
    ...(search.requests > 0 || search.checks > 0 ? { leanSearch: search } : {}),
    ...(graph !== undefined ? { graph } : {}),
    tools: Object.fromEntries(
      [...tools].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, use]) => [
        id,
        { calls: use.calls, outcomes: use.outcomes, attempts: use.attempts.size, proofs: [...use.attempts].filter((a) => proofAttempts.has(a)).length },
      ]),
    ),
    ...(modelCalls.total > 0 ? { modelCalls } : {}),
    ...(repeatStops.length > 0 ? { repeatStops } : {}),
    ...(rotation.rounds > 0 ? { rounds: rotation } : {}),
    ...(retries.requests > 0 ? { retries: { requests: retries.requests, attempts: retries.attempts.size, usd: retries.usd } } : {}),
    sites: siteSpend(events),
    ...(gateReport(events) !== undefined ? { gate: gateReport(events) as GateReport } : {}),
    ...(redundant !== undefined ? { redundancy: redundant } : {}),
    ...(library !== undefined ? { library } : {}),
    ...(lessons !== undefined ? { lessons } : {}),
    ...(heuristics !== undefined ? { heuristics } : {}),
    ...(archive !== undefined ? { archive } : {}),
    ...(loop.attempts.length > 0 ? { loop } : {}),
    ...(intakeLines(events).length > 0 ? { intake: intakeLines(events) } : {}),
  };
}

function percent(ratio: number | undefined): string {
  return ratio === undefined ? "n/a" : `${(ratio * 100).toFixed(0)}%`;
}

/** The cache ratio and the dollars it saved: in all, by line, by rung, and per session in a table. */
function cacheParagraph(cache: CacheReport): string[] {
  const part = (key: string, s: CacheReport["total"]) => `${key} ${percent(s.ratio)} (saved ${money(s.savedUsd)})`;
  return [
    `Prompt cache: ${percent(cache.total.ratio)} of the input read from the cache, which saved ${money(cache.total.savedUsd)} against a price with no cache.` +
      ` By line: ${Object.entries(cache.byLine).map(([k, s]) => part(k, s)).join("; ")}.` +
      `${cache.byRung !== undefined ? ` By rung: ${Object.entries(cache.byRung).map(([k, s]) => part(k, s)).join("; ")}.` : ""}`,
    ...(cache.sessions.length > 0
      ? [
          "",
          "| Session (attempt) | Responses | Input tokens | Cached | Ratio | Saved |",
          "|---|---|---|---|---|---|",
          ...cache.sessions.map((s) => `| ${s.attemptId} | ${s.calls} | ${s.inputTokens} | ${s.cachedInputTokens} | ${percent(s.ratio)} | ${money(s.savedUsd)} |`),
          "",
        ]
      : []),
  ];
}

function priceGapsParagraph(g: NonNullable<RunReport["priceGaps"]>): string {
  return [
    g.unpricedResponses > 0
      ? `Warning: ${g.unpricedResponses} model response(s) (${g.unpricedInputTokens} input tokens) were charged $0 because their model has no price in the host profile or in pi-ai: no dollar budget saw them.`
      : "",
    g.unchargedUsd > 0 ? `The host's price table charged ${money(g.unchargedUsd)} less than the cost pi-ai reported for the same responses.` : "",
  ]
    .filter((text) => text !== "")
    .join(" ");
}

function offPeakParagraph(o: OffPeakLine): string {
  return (
    `Off-peak: ${money(o.usd)} of the run's dollars (${(o.share * 100).toFixed(0)}%) were charged at the off-peak rate.` +
    `${o.deferred > 0 ? ` The run waited ${o.deferred} time(s) for off-peak hours, ${o.waitedMinutes.toFixed(0)} minutes in all, and ran at a peak price ${o.ranAnyway} time(s) because the wait limit came first.` : ""}`
  );
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

function memoryParagraph(m: MemoryLine): string[] {
  const head = `Memory from the earlier run ${m.from.runId} (${m.journals} journal(s) in the chain, ${m.from.events} events in the first, last hash ${m.from.lastHash.slice(0, 12)}): `;
  if (m.taken === undefined) return [`${head}it could not be read when this report was made (${m.unavailable ?? "unknown reason"}).`];
  const t = m.taken;
  const carried = Object.entries(t.carried).map(([status, n]) => `${n} ${status}`).join(", ");
  return [
    `${head}${t.claims} claim(s), ${t.attempts} attempt(s), ${t.toolRuns} tool run(s), ${t.lessons} lesson(s), ${t.nodes} node(s), ${t.edges} edge(s), ${t.epochs} epoch(s). ` +
      `${m.sameEnvironment
        ? `The same Lean environment: ${t.validations.carried} validation(s) and the statuses of the claims carried${carried !== "" ? ` (${carried})` : ""}.`
        : `Another Lean environment for ${t.validations.notCarried} validation(s): ${t.reset} claim status(es) and ${t.edgesReset} edge status(es) of the earlier runs count for nothing until a stored proof passes validate again.`} ` +
      "A problem's outcome above comes from this run's own certifications, never from the earlier memory.",
  ];
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
      `${report.leanEnv !== undefined ? ` Lean environment: ${report.leanEnv.name}${report.leanEnv.hash !== null ? ` (${report.leanEnv.hash.slice(0, 12)})` : ", not resolved"}.` : ""}` +
      `${report.packs !== undefined ? ` Packs: ${report.packs.map((p) => `${p.name} ${p.version} (${p.hash.slice(0, 12)})`).join(", ")}.` : ""}`,
    report.finished
      ? report.stopped !== undefined
        ? `The run stopped early: ${report.stopped}.`
        : "The run is complete."
      : report.turns?.paused === true && report.turns.last !== undefined
        ? `The run is paused after turn ${report.turns.last.turn} (${report.turns.last.reason}: ${report.turns.last.detail}); ${report.turns.last.waiting} problem(s) wait for the team. Its account is turns/${report.turns.last.turn}/report.md.`
        : "The run has not finished.",
    ...(report.turns !== undefined ? [`Turns: ${report.turns.count} (ended by ${counts(report.turns.reasons)}).`] : []),
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
      `Tokens: ${report.inputTokens} in, ${report.outputTokens} out.` +
      `${report.cachedInputTokens > 0 ? ` Cached input: ${report.cachedInputTokens} of the ${report.inputTokens} (${((report.cachedInputTokens / report.inputTokens) * 100).toFixed(0)}%).` : ""}`,
    ...(report.cache !== undefined ? cacheParagraph(report.cache) : []),
    ...(report.offPeak !== undefined ? [offPeakParagraph(report.offPeak)] : []),
    ...(report.priceGaps !== undefined ? [priceGapsParagraph(report.priceGaps)] : []),
    `Attempts: ${report.attempts.total} (${counts(report.attempts.outcomes)}). Sessions ended by: ${counts(report.attempts.stoppedBy)}. ` +
      `Last check of the invalid ones: ${counts(report.attempts.failures)}.`,
    ...(report.rounds !== undefined
      ? [
          `The run's budget in rounds: ${report.rounds.rounds} round(s), the last allowing each problem ${money(report.rounds.capUsd)} in all; ${report.rounds.parked.length} parking(s)` +
            `${report.rounds.parked.length > 0 ? ` (${report.rounds.parked.slice(0, 5).map((p) => `${p.problemId} in round ${p.round} at ${money(p.usd)}`).join("; ")}${report.rounds.parked.length > 5 ? "; and more" : ""})` : ""}.`,
        ]
      : []),
    ...(report.repeatStops !== undefined
      ? [`Sessions ended by the repeat rule (${report.repeatStops.length}): ${report.repeatStops.slice(0, 5).join("; ")}${report.repeatStops.length > 5 ? `; and ${report.repeatStops.length - 5} more` : ""}.`]
      : []),
    ...(report.retries !== undefined
      ? [
          `Requests sent again after a transient error (a cut stream, a reset connection, a 5xx or a 429): ${report.retries.requests} ` +
            `in ${report.retries.attempts} attempt(s); the cut responses were charged ${money(report.retries.usd)}.`,
        ]
      : []),
    `Lean checks: ${report.leanChecks.total} (${counts(report.leanChecks.outcomes)})` +
      `${report.leanChecks.medianMs !== undefined ? `; median ${(report.leanChecks.medianMs / 1000).toFixed(1)} s` : ""}` +
      `${report.leanChecks.p90Ms !== undefined ? `, 90th percentile ${(report.leanChecks.p90Ms / 1000).toFixed(1)} s` : ""}.`,
    ...(report.leanSearch !== undefined
      ? [
          `Lean search (not in the checks above): ${report.leanSearch.requests} request(s), ${(report.leanSearch.requestMs / 1000).toFixed(1)} s; ` +
            `${report.leanSearch.checks} Lean check(s) of the hits, ${(report.leanSearch.checkMs / 1000).toFixed(1)} s.`,
        ]
      : []),
    ...(report.graph !== undefined ? renderGraphReport(report.graph) : []),
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
    ...(report.gate !== undefined ? renderGateReport(report.gate) : []),
    ...(report.redundancy !== undefined
      ? [
          `Redundant attempts: ${report.redundancy.redundant} of ${report.redundancy.attempts} labeled attempts ` +
            `(${(report.redundancy.share * 100).toFixed(0)}%) failed again as an earlier attempt on the same claim or an equivalent one had.`,
        ]
      : []),
    ...(report.library !== undefined ? [renderLibraryReport(report.library)] : []),
    ...(report.lessons !== undefined ? [renderLessonReport(report.lessons)] : []),
    ...(report.heuristics !== undefined ? [renderHeuristicReport(report.heuristics)] : []),
    ...(report.archive !== undefined ? [renderArchiveReport(report.archive)] : []),
    ...(report.memory !== undefined ? memoryParagraph(report.memory) : []),
    ...(report.intake !== undefined ? [...renderIntake(report.intake), ""] : []),
    "Measured: validity and cost. Not measured here: the fidelity of the formal statements, taken as given by the bench, " +
      "and novelty, since the bench's problems are solved ones.",
    "",
    "| Problem | Outcome | Attempts | Cost | Time | Note |",
    "|---|---|---|---|---|---|",
    ...report.problems.map(
      (p) =>
        `| ${cell(p.target)} | ${p.outcome} | ${p.attempts} | ${money(p.usd)} | ${Math.round(p.durationMs / 1000)} s | ${cell((p.reason ?? "").slice(0, 200))} |`,
    ),
    ...(report.problems.some((p) => p.ladder !== undefined)
      ? [
          "",
          "| Problem | Solving rung | Dollars per rung |",
          "|---|---|---|",
          ...report.problems.flatMap((p) =>
            p.ladder === undefined
              ? []
              : [
                  `| ${cell(p.target)} | ${p.ladder.solvedAtRung ?? "none"} | ${
                    Object.entries(p.ladder.usdByRung)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([rung, usd]) => `rung ${rung} ${money(usd)}`)
                      .join(", ") || "none"
                  } |`,
                ],
          ),
        ]
      : []),
    ...(report.loop !== undefined ? ["", ...renderLoop(report.loop)] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/** The earlier memory a run started on, from its `run.started`; the chain is read again and replayed under the run's own events. */
function memoryLine(journalPath: string, events: readonly HarnessEvent[]): MemoryLine | undefined {
  const first = events[0];
  if (first?.type !== "run.started" || first.data.memoryFrom === undefined) return undefined;
  const from = first.data.memoryFrom;
  try {
    const chain = chainOfJournal(journalPath);
    if (chain === undefined) return undefined;
    const projection = Projection.inMemory();
    try {
      projection.attachChain(chain);
      for (const event of events) projection.apply(event);
      return { from, journals: chain.segments.length, sameEnvironment: chain.segments.every((s) => s.carried), taken: projection.memorySummary() };
    } finally {
      projection.close();
    }
  } catch (error) {
    return { from, journals: 1, sameEnvironment: false, unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes `report.md` and `report.json` in a run directory, from its journal. */
export function writeReport(dir: string): RunReport {
  const events = readEvents(join(dir, "journal.jsonl"));
  const report = buildReport(events);
  const memory = memoryLine(join(dir, "journal.jsonl"), events);
  if (memory !== undefined) report.memory = memory;
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderRunReport(report));
  return report;
}
