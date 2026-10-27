import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type BenchIndex, type ProblemEntry, sample } from "@seshat/bench";
import {
  assemble,
  type BlobStore,
  canonicalJson,
  type EventDataMap,
  extractSubmission,
  type HarnessEvent,
  hashJson,
  type Journal,
  type Json,
  readEvents,
  sha256Hex,
  type TornTail,
  type ValidationReport,
  verifyChain,
} from "@seshat/core";
import type { JsonObject, ResumedProblem } from "@seshat/lines";
import { messageOf } from "@seshat/registry";
import type { TaskLedger } from "@seshat/scheduler";
import { chargedTotals } from "./budget.ts";
import type { Candidate, RecordedCertification, Workbench } from "./problem.ts";
import type { ProverResume } from "./prover.ts";
import type { ProblemResult, RunConfig } from "./run.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * Resuming a run (documentation/ledger.md, "Resume"): what the journal of a run whose process
 * ended says about the run, and the parts of it that the continuing process takes up again. The
 * journal is the only source: nothing here reads a file of the run directory that the journal does
 * not name, except `config.json` (the problems the run was given, which the journal keeps as a
 * hash) and the proofs written beside it.
 */

/** A run read back from its journal. */
export interface RecordedRun {
  runId: string;
  /** The `run.started` event's data. */
  started: EventDataMap["run.started"];
  /** The configuration the run began with, rebuilt from `started.config`. */
  config: RunConfig;
  /** The ids of the problems the run was given, in order, when `config.json` still holds them. */
  problemIds?: string[];
  /** Every whole event of the journal. A last line that a crash cut is not among them. */
  events: readonly HarnessEvent[];
}

/**
 * Reads the run of a directory: its journal, which has to verify, and the configuration `run.started`
 * recorded. Writes nothing, and takes no lock, so a journal that is cut at its end reads as the events
 * before the cut. Throws `RunSetupError` when the directory holds no run to resume.
 */
export function readRecordedRun(dir: string): RecordedRun {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) throw new RunSetupError(`${dir} holds no run: it has no journal.jsonl`);
  let events: HarnessEvent[];
  try {
    events = readEvents(path);
  } catch (error) {
    throw new RunSetupError(`the journal of ${dir} cannot be read: ${messageOf(error)}`, { cause: error });
  }
  const chain = verifyChain(events);
  if (!chain.ok) throw new RunSetupError(`the journal of ${dir} is corrupt at seq ${chain.seq}: ${chain.reason}`);
  const first = events.find((event) => event.type === "run.started");
  if (first === undefined || first.type !== "run.started") {
    throw new RunSetupError(`the journal of ${dir} has no run.started: the run did not begin, and there is nothing to resume`);
  }
  const problemIds = problemIdsOf(dir);
  return {
    runId: first.data.runId,
    started: first.data,
    config: configOf(first.data.config),
    ...(problemIds !== undefined ? { problemIds } : {}),
    events,
  };
}

/** The ids `config.json` lists, if the file is there and says. */
function problemIdsOf(dir: string): string[] | undefined {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { problems?: unknown };
    const ids = parsed.problems;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? (ids as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** The run's configuration, as `runBench` recorded it in `run.started`. */
function configOf(recorded: unknown): RunConfig {
  const missing = (what: string): never => {
    throw new RunSetupError(`run.started does not record ${what}, so the run cannot be rebuilt and cannot be resumed`);
  };
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) return missing("a configuration");
  const r = recorded as Record<string, unknown>;
  const text = (name: string): string => (typeof r[name] === "string" ? (r[name] as string) : missing(name));
  const whole = (name: string, value: unknown): number => (typeof value === "number" ? value : missing(name));
  const object = (name: string): Record<string, unknown> =>
    typeof r[name] === "object" && r[name] !== null && !Array.isArray(r[name]) ? (r[name] as Record<string, unknown>) : missing(name);
  const limits = object("limits");
  const budget = object("budget");
  const tools = Array.isArray(r.tools) ? r.tools : missing("tools");
  const lines = Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : undefined;
  const runUsd = budget.runUsd;
  return {
    selection: (r.selection ?? null) as Json,
    model: text("model"),
    thinkingLevel: text("thinkingLevel") as ThinkingLevel,
    provers: whole("provers", r.provers),
    sessions: whole("sessions", r.sessions),
    limits: { turns: whole("limits.turns", limits.turns), contextTokens: whole("limits.contextTokens", limits.contextTokens) },
    notesChars: whole("notesChars", r.notesChars),
    budget: { problemUsd: whole("budget.problemUsd", budget.problemUsd), ...(typeof runUsd === "number" ? { runUsd } : {}) },
    concurrency: whole("concurrency", r.concurrency),
    tools: tools.map((tool) => {
      const capability = (tool as { capability?: unknown } | null)?.capability;
      return typeof capability === "string" ? capability : missing("a tool's capability");
    }),
    ...(lines !== undefined
      ? {
          lines: lines.map((line) => (typeof line.id === "string" ? line.id : missing("a line's id"))),
          lineOptions: Object.fromEntries(
            lines.map((line) => [line.id as string, (typeof line.options === "object" && line.options !== null ? line.options : {}) as JsonObject]),
          ),
        }
      : {}),
  };
}

/** The ids of the problems a selection names in a bench, or undefined when it is not one the harness knows. */
function selectedIds(selection: Json, index: BenchIndex): string[] | undefined {
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) return undefined;
  if (selection.all === true) return index.problems.map((p) => p.id);
  if (Array.isArray(selection.ids) && selection.ids.every((id) => typeof id === "string")) return selection.ids as string[];
  if (typeof selection.sample === "number" && typeof selection.seed === "string") {
    return sample(index.problems, selection.sample, selection.seed).map((p) => p.id);
  }
  return undefined;
}

/**
 * The problems the run was given, in order, found in the bench: from `config.json`, or else from the
 * selection `run.started` recorded. They have to hash to what the journal says, and the bench has to
 * be the one the run used. Throws `RunSetupError` otherwise.
 */
export function problemsOf(recorded: RecordedRun, index: BenchIndex): ProblemEntry[] {
  const stored = recorded.started.config as { bench?: { hash?: unknown }; problemsHash?: unknown } | null;
  if (stored?.bench?.hash !== index.hash) {
    throw new RunSetupError(
      `the bench is not the one the run used (it recorded ${String(stored?.bench?.hash)}, this one is ${index.hash}): give the run's bench with --bench`,
    );
  }
  const ids = recorded.problemIds ?? selectedIds(recorded.config.selection, index);
  if (ids === undefined) throw new RunSetupError("the problems of the run are not recorded in config.json and cannot be recovered from its selection");
  if (hashJson(ids) !== stored.problemsHash) {
    throw new RunSetupError("the problems of the run are not the ones the journal recorded (their hash differs): config.json or the bench was changed");
  }
  const byId = new Map(index.problems.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new RunSetupError(`the bench has no problem ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
  return ids.map((id) => byId.get(id) as ProblemEntry);
}

const LABELS: Record<string, string> = {
  host: "the host",
  registry: "the capability registry (catalog and host profile)",
  tools: "the tools given to the provers",
  certifier: "the certifier",
  prompt: "the prompts",
  policy: "the validation policy",
  lines: "the lines (ids, versions or options)",
};

function show(value: Json | undefined): string {
  const text = value === undefined ? "nothing" : canonicalJson(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * What differs between what `run.started` recorded and what the process that resumes would run, by
 * the keys of `current`: a resumed run is the same run, so the prompts, the policy, the lines, the
 * capability registry, the tools and the certifier must be the ones it began with. A line of text
 * for each difference; none when they agree.
 */
export function configMismatches(recorded: unknown, current: Readonly<Record<string, Json | undefined>>): string[] {
  const stored = (typeof recorded === "object" && recorded !== null ? recorded : {}) as Record<string, Json | undefined>;
  const out: string[] = [];
  for (const [key, now] of Object.entries(current)) {
    const was = stored[key];
    if (canonicalJson((was ?? null) as Json) === canonicalJson((now ?? null) as Json)) continue;
    out.push(`${LABELS[key] ?? key}: the run recorded ${show(was)}, now ${show(now)}`);
  }
  return out;
}

/** What the process that resumes found open, and what it did about it. */
export interface Resumption {
  resumption: number;
  tornTail?: TornTail;
  interrupted: { attempts: number; toolRuns: number; tasks: number };
}

/**
 * Starts the resumption of an opened journal: writes `run.resumed` first, then closes what the
 * process that ended left open. A tool run with no end ends `aborted`. An attempt with no end ends
 * `aborted` with `stoppedBy: "interrupted"`, at the cost of its charges, and without a carry:
 * the session was cut, so its prover starts its next one from the last session that finished. A task
 * that was `running` goes back to `ready`, which the journal allows only after `run.resumed`. All
 * of it is written by the orchestrator.
 */
export function beginResumption(journal: Journal, tasks: TaskLedger, o: { runId: string; codeRev?: string }): Resumption {
  const p = journal.projection;
  const attempts = p.openAttempts();
  const toolRuns = p.openToolRuns();
  const running = p.tasks({ statuses: ["running"] });
  const total = p.totalSpend();
  const resumption = p.resumptions().length + 1;
  // The cut last line the journal was opened with, if there is one, is dealt with now: the first write of the resumption.
  const tornTail = journal.log.repair();
  // How long the cut work ran is known only as far as the last event its process wrote: a lower bound.
  const written = readEvents(journal.log.path);
  const lastWritten = Date.parse(written[written.length - 1]?.ts ?? "");
  const startedAt = new Map(written.map((e) => [e.seq, Date.parse(e.ts)]));
  const ranFor = (startedSeq: number): number => {
    const started = startedAt.get(startedSeq);
    return started === undefined || Number.isNaN(started) || Number.isNaN(lastWritten) ? 0 : Math.max(0, lastWritten - started);
  };
  const interrupted = { attempts: attempts.length, toolRuns: toolRuns.length, tasks: running.length };
  journal.emit(
    "run.resumed",
    {
      runId: o.runId,
      resumption,
      ...(tornTail !== undefined ? { tornTail } : {}),
      spent: { usd: total.usd, inputTokens: total.inputTokens, outputTokens: total.outputTokens },
      interrupted,
      ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
    },
    "orchestrator",
  );
  for (const run of toolRuns) journal.emit("tool_run.finished", { toolRunId: run.tool_run_id, outcome: "aborted", durationMs: ranFor(run.started_seq) }, "orchestrator");
  for (const attempt of attempts) {
    journal.emit(
      "attempt.finished",
      {
        attemptId: attempt.attempt_id,
        outcome: "aborted",
        stoppedBy: "interrupted",
        durationMs: ranFor(attempt.started_seq),
        ...chargedTotals(attempt),
      },
      "orchestrator",
    );
  }
  tasks.interrupt(`the process ended while the task ran; the run was resumed (resumption ${resumption})`);
  return { resumption, ...(tornTail !== undefined ? { tornTail } : {}), interrupted };
}

/** The relative path of the proof a problem's run writes, in the run directory. */
export function proofPath(entry: ProblemEntry): string {
  return join("proofs", `${entry.fullName.replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80)}-${sha256Hex(entry.id).slice(0, 8)}.lean`);
}

/**
 * The outcomes the earlier processes of the run wrote, as results, in the order they were written.
 * An outcome is final, even `aborted`: the problem is not worked on again.
 */
export function finishedResults(events: readonly HarnessEvent[], problems: readonly ProblemEntry[], dir: string): ProblemResult[] {
  const byId = new Map(problems.map((p) => [p.id, p]));
  const results: ProblemResult[] = [];
  for (const event of events) {
    if (event.type !== "problem.finished") continue;
    const d = event.data;
    const entry = byId.get(d.problemId);
    const proof = entry === undefined ? undefined : proofPath(entry);
    results.push({
      problemId: d.problemId,
      outcome: d.outcome,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      attempts: d.attempts,
      usd: d.usd,
      durationMs: d.durationMs,
      ...(proof !== undefined && existsSync(join(dir, proof)) ? { proof } : {}),
    });
  }
  return results;
}

/** A problem the run had registered and did not end. */
export interface InterruptedProblem {
  problemId: string;
  claimId: string;
  /** The attempts the problem's provers started, in order. */
  attemptIds: string[];
}

/** The problems registered and not finished, in the order they were registered. */
export function interruptedProblems(journal: Journal): InterruptedProblem[] {
  const p = journal.projection;
  return p
    .problems()
    .filter((row) => row.finished_seq === null)
    .map((row) => ({
      problemId: row.problem_id,
      claimId: row.claim_id,
      attemptIds: p
        .tasks({ problemId: row.problem_id })
        .flatMap((task) => p.attemptsOfTask(task.task_id))
        .sort((a, b) => a.started_seq - b.started_seq)
        .map((attempt) => attempt.attempt_id),
    }));
}

/**
 * What the journal holds of a problem, for the lines that rebuild their state (`ResumedProblem`).
 * `begun` and `endedProvers` are the orchestrator's, from the problem's tasks; the rest is read
 * from the journal. Call it after `beginResumption`, which ended the sessions the interruption cut.
 */
export function resumedProblemOf(journal: Journal, o: { problemId: string; begun: boolean; endedProvers: string[] }): ResumedProblem {
  const p = journal.projection;
  const attempts = p
    .tasks({ problemId: o.problemId })
    .flatMap((task) => p.attemptsOfTask(task.task_id))
    .sort((a, b) => a.started_seq - b.started_seq)
    .map((attempt) => ({
      attemptId: attempt.attempt_id,
      prover: attempt.prover,
      session: attempt.iteration,
      claimId: attempt.claim_id,
      interrupted: attempt.stopped_by === "interrupted",
    }));
  const modelCalls: Record<string, number> = {};
  for (const call of p.modelCallsOfProblem(o.problemId)) {
    if (call.site !== null) modelCalls[call.site] = (modelCalls[call.site] ?? 0) + 1;
  }
  return { begun: o.begun, attempts, endedProvers: o.endedProvers, modelCalls, workedClaims: p.claimsWithAttempts() };
}

/** What an interrupted problem's workbench takes up: the candidate its checks found, and the certifier's answer if the journal has one. */
export interface RecoveredCandidate {
  candidate: Candidate;
  answer?: RecordedCertification;
}

/**
 * The candidate a workbench had found before the interruption: the first valid fast check of its
 * claim (of the claim's negation, for a workbench of a refutation) that the problem's checks made (a
 * prover's or a line's), read back from the journal and the blob of the file that was checked, with
 * the certifier's answer for that file if the journal holds one. Without a valid check, there is no
 * candidate and nothing is returned. `problemId` is the workbench's own, or the problem whose lines
 * made a workbench that is not the problem's. Throws when the journal names a blob the run
 * directory lost.
 */
export function recoverCandidate(journal: Journal, blobs: BlobStore, workbench: Workbench, problemId: string | undefined = workbench.problemId): RecoveredCandidate | undefined {
  if (problemId === undefined) return undefined;
  const own = journal.projection.validationsOfProblem(problemId).filter((v) => v.claim_id === workbench.claimId && v.negation === workbench.negation);
  const found = own.find((v) => v.method === "repl" && v.verdict === "valid");
  if (found === undefined) return undefined;
  const submitted = blobs.get(found.submission_hash);
  if (submitted === undefined) {
    throw new Error(`the proof that passed the fast check (validation ${found.validation_id}) is gone: blob ${found.submission_hash} is not in the run directory`);
  }
  const report: ValidationReport = {
    verdict: "valid",
    method: "repl",
    reasons: found.reasons,
    axioms: found.axioms,
    messages: [],
    sorries: [],
    // As `ProofValidator.validate` assembled it from the regions of the submitted file.
    checked: assemble(workbench.sketch, extractSubmission(submitted)),
    submissionHash: found.submission_hash,
    editsOutsideRegions: false,
    holes: false,
  };
  const candidate: Candidate = {
    ...(found.attempt_id !== null ? { attemptId: found.attempt_id } : {}),
    problemId,
    validationId: found.validation_id,
    report,
  };
  const answered = own.find((v) => v.method === "kernel_replay" && v.submission_hash === found.submission_hash);
  return {
    candidate,
    ...(answered !== undefined
      ? { answer: { validationId: answered.validation_id, seq: answered.seq, verdict: answered.verdict, reasons: answered.reasons, axioms: answered.axioms } }
      : {}),
  };
}

/**
 * Where a prover's task stood when the run was interrupted, from the attempts that worked for it: the
 * number of the last session it started (a session that was cut counts as used), how many it made, how
 * many in a row ended with an error, and what the last session that finished handed on. Undefined for
 * a task whose prover had made no attempt. Throws when the journal names a blob the run directory lost.
 */
export function proverResumeOf(journal: Journal, blobs: BlobStore, taskId: string): ProverResume | undefined {
  const attempts = journal.projection.attemptsOfTask(taskId);
  if (attempts.length === 0) return undefined;
  const session = Math.max(...attempts.map((attempt) => attempt.iteration));
  // Sessions that the interruption cut say nothing about the prover's health: they neither add to the failures nor end the run of them.
  let failed = 0;
  for (const attempt of [...attempts].reverse()) {
    if (attempt.stopped_by === "interrupted") continue;
    if (attempt.outcome !== "error") break;
    failed += 1;
  }
  const carried = attempts.findLast((attempt) => attempt.carry !== null)?.carry ?? undefined;
  if (carried === undefined) return { session, attempts: attempts.length, failed };
  const blob = (hash: string, what: string): string => {
    const text = blobs.get(hash);
    if (text === undefined) throw new Error(`what prover ${attempts[0]?.prover ?? "?"} carried (${what}) is gone: blob ${hash} is not in the run directory`);
    return text;
  };
  const regions = JSON.parse(blob(carried.regions, "its regions")) as { aux?: unknown; proof?: unknown };
  if (typeof regions.aux !== "string" || typeof regions.proof !== "string") {
    throw new Error(`what prover ${attempts[0]?.prover ?? "?"} carried (its regions, blob ${carried.regions}) is not an aux and a proof`);
  }
  return {
    session,
    attempts: attempts.length,
    failed,
    carry: {
      regions: { aux: regions.aux, proof: regions.proof },
      ...(carried.lastCheck !== undefined ? { lastCheck: blob(carried.lastCheck, "its last check") } : {}),
      ...(carried.notes !== undefined ? { notes: blob(carried.notes, "its notes") } : {}),
    },
  };
}
