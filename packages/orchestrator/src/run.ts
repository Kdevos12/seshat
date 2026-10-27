import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { BenchIndex, ProblemEntry } from "@seshat/bench";
import {
  BlobStore,
  budgetClassOf,
  CheckFailedError,
  hashJson,
  isFinalTaskStatus,
  Journal,
  type Json,
  type LeanCertifier,
  newId,
  type ProblemOutcome,
  ProofValidator,
  type ProvenanceContext,
  type Reference,
  SKETCH_POLICY,
  stampProvenance,
} from "@seshat/core";
import { type JsonObject, type LineRegistry, resolveLines, resumeRefusals } from "@seshat/lines";
import { MemoryStore, type StatementIdentity } from "@seshat/memory";
import { LEAN_CERTIFY, messageOf, RegistryLeanCertifier, RegistryLeanChecker, type Registry } from "@seshat/registry";
import { TaskLedger } from "@seshat/scheduler";
import { Ledger } from "./budget.ts";
import { type ProblemLines, RunLines } from "./line-runtime.ts";
import { LINES } from "./lines.ts";
import { type Certification, conflictNote, type LoadedProblem, loadProblem, Workbench } from "./problem.ts";
import { PROMPT_VERSION, promptHash } from "./prompt.ts";
import { createProverTasks, endProverTask } from "./prover-tasks.ts";
import { type ProverResult, type ProverResume, runProver } from "./prover.ts";
import { type RunReport, writeReport } from "./report.ts";
import {
  beginResumption,
  configMismatches,
  finishedResults,
  type InterruptedProblem,
  interruptedProblems,
  proofPath,
  problemsOf,
  proverResumeOf,
  resumedProblemOf,
  readRecordedRun,
  recoverCandidate,
  type RecordedRun,
} from "./resume.ts";
import { Router } from "./routing.ts";
import { ABORT_BUDGET, ABORT_SOLVED, ABORT_STOPPED, type SessionLimits } from "./session.ts";
import { RunSetupError } from "./setup-error.ts";
import { checkTools, pinTools, toolName } from "./tools.ts";
import { ClaimBenches, type PendingResult } from "./validate.ts";

/** Everything that decides what a run does, recorded in `run.started`. */
export interface RunConfig {
  /** How the problems were chosen, for the record: `{all: true}`, `{sample, seed}` or `{ids}`. */
  selection: Json;
  /** `provider/id`, as pi-ai names models. */
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Independent provers per problem. */
  provers: number;
  /** Sessions per prover. */
  sessions: number;
  limits: SessionLimits;
  /** Length limit of a prover's notes. */
  notesChars: number;
  /** Dollars per problem, and for the whole run. */
  budget: { problemUsd: number; runUsd?: number };
  /** Problems worked on at the same time. */
  concurrency: number;
  /** `direct` capabilities given to the provers besides lean_check, such as `compute.sage`. */
  tools: string[];
  /** The lines the run enables, such as `M1` (documentation/lines.md). None, or absent: M0. */
  lines?: string[];
  /** Options of the enabled lines, by line id: they replace the lines' defaults key by key. */
  lineOptions?: Record<string, JsonObject>;
}

export const DEFAULT_CONFIG: Omit<RunConfig, "selection" | "model"> = {
  thinkingLevel: "medium",
  provers: 4,
  sessions: 8,
  limits: { turns: 40, contextTokens: 120_000 },
  notesChars: 4000,
  budget: { problemUsd: 5 },
  concurrency: 1,
  tools: [],
};

export interface RunOptions {
  config: RunConfig;
  index: BenchIndex;
  /** The problems to work on, in order. */
  problems: readonly ProblemEntry[];
  /** A checkout of the bench's repository at its revision. */
  checkout: string;
  /** The run directory, created by the run: journal, blobs, transcripts, proofs, report. */
  dir: string;
  models: Models;
  /** Builds the registry of the run's host, writing tool runs to this journal and blobs. */
  registry: (journal: Journal, blobs: BlobStore) => Registry;
  /** Certifies the candidates. Default: the host's `lean.certify`, if its profile lists one; without a certifier no claim becomes `proved` or `refuted`. */
  certifier?: LeanCertifier;
  /** Stops the run: the problems in progress end as `aborted`. */
  signal?: AbortSignal;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
  /** Revision of this repository. */
  codeRev?: string;
  runId?: string;
  /** The lines that can be enabled, by id. Default: `LINES`, the lines implemented so far. */
  lines?: LineRegistry;
}

export interface ProblemResult {
  problemId: string;
  outcome: ProblemOutcome;
  reason?: string;
  attempts: number;
  usd: number;
  durationMs: number;
  /** Where the candidate proof was written. */
  proof?: string;
}

export interface RunResult {
  runId: string;
  dir: string;
  problems: ProblemResult[];
  usd: number;
  /** Why the run stopped before its last problem. */
  stopped?: string;
  /** The report written in the run directory. */
  report: RunReport;
}

/** Problems ending with a harness error in a row: the run stops. */
const MAX_FAILED_PROBLEMS = 3;

export { RunSetupError };

/** The problems of a configuration, or an empty list when it is sound. */
export function checkConfig(config: RunConfig): string[] {
  const problems: string[] = [];
  const whole = (name: string, value: number, min: number) => {
    if (!Number.isInteger(value) || value < min) problems.push(`${name} must be an integer of at least ${min}, got ${value}`);
  };
  whole("provers", config.provers, 1);
  whole("sessions", config.sessions, 1);
  whole("limits.turns", config.limits.turns, 1);
  whole("limits.contextTokens", config.limits.contextTokens, 1000);
  whole("notesChars", config.notesChars, 100);
  whole("concurrency", config.concurrency, 1);
  if (new Set(config.tools).size !== config.tools.length) problems.push(`tools lists a capability twice: ${config.tools.join(", ")}`);
  if (!(config.budget.problemUsd > 0)) problems.push(`budget.problemUsd must be positive, got ${config.budget.problemUsd}`);
  if (config.budget.runUsd !== undefined && !(config.budget.runUsd > 0)) {
    problems.push(`budget.runUsd must be positive, got ${config.budget.runUsd}`);
  }
  return problems;
}

/** Looks a `provider/id` model up, and checks that its provider has credentials. */
export async function resolveModel(models: Models, name: string): Promise<Model<Api>> {
  const slash = name.indexOf("/");
  if (slash <= 0) throw new RunSetupError(`model ${JSON.stringify(name)}: expected provider/id, as harness models lists them`);
  const provider = name.slice(0, slash);
  const id = name.slice(slash + 1);
  const model = models.getModel(provider, id);
  if (model === undefined) {
    const known = models.getModels(provider).map((m) => m.id);
    throw new RunSetupError(
      known.length === 0
        ? `unknown provider ${provider}`
        : `unknown model ${id} of ${provider}; known: ${known.slice(0, 30).join(", ")}${known.length > 30 ? ", ..." : ""}`,
    );
  }
  const auth = await models.getAuth(model).catch((error: unknown) => {
    throw new RunSetupError(`the credentials of ${provider}: ${messageOf(error)}`, { cause: error });
  });
  if (auth === undefined) {
    throw new RunSetupError(`no credentials for ${provider}: set its API key in the environment (pi-ai's README lists the variables)`);
  }
  return model;
}

/**
 * Runs M0 on a list of bench problems: for each, the provers work in parallel, each in its own Ralph
 * loop, until one finds a proof that passes the fast check, the problem's budget runs out, or every
 * prover has used its sessions. Every fact goes into the run's journal.
 */
export async function runBench(o: RunOptions): Promise<RunResult> {
  return await execute(o);
}

/** What `resumeBench` needs besides the run directory: the run's configuration comes from its journal. */
export interface ResumeOptions {
  /** The directory of the run to continue. */
  dir: string;
  /** The bench the run used: its hash has to be the one the run recorded. */
  index: BenchIndex;
  /** A checkout of the bench's repository at its revision. */
  checkout: string;
  models: Models;
  /** Builds the registry of the run's host; the run's capability registry, tools and certifier have to be the ones it began with. */
  registry: RunOptions["registry"];
  certifier?: LeanCertifier;
  /** Stops the resumed run: the problems in progress end as `aborted`. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Revision of this repository, recorded in `run.resumed`. */
  codeRev?: string;
  /** The lines that can be enabled, by id. Default: `LINES`. */
  lines?: LineRegistry;
}

/**
 * Continues a run whose process ended without finishing it (a kill, a crash, a usage limit), from its
 * journal alone (documentation/ledger.md, "Resume"). The run is the same: its configuration, bench,
 * prompts, registry, tools, certifier and lines are the ones `run.started` recorded, and a difference
 * is refused before anything is written. The problems that have an outcome keep it. A problem that
 * was begun and has none is taken up where the journal left it: the budgets start from what the
 * journal says was spent, a candidate it found is not found again, a certification it recorded is not
 * made again and one it did not is, and each prover goes on with the file, the last check and the notes
 * of its last session that finished. The problems not begun are run as in a fresh run.
 */
export async function resumeBench(o: ResumeOptions): Promise<RunResult> {
  const recorded = readRecordedRun(o.dir);
  const problems = problemsOf(recorded, o.index);
  return await execute(
    {
      config: recorded.config,
      index: o.index,
      problems,
      checkout: o.checkout,
      dir: o.dir,
      models: o.models,
      registry: o.registry,
      runId: recorded.runId,
      ...(o.certifier !== undefined ? { certifier: o.certifier } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      ...(o.log !== undefined ? { log: o.log } : {}),
      ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
      ...(o.lines !== undefined ? { lines: o.lines } : {}),
    },
    recorded,
  );
}

/** A problem to work on, and whether it was begun by the process before. */
interface QueuedProblem {
  entry: ProblemEntry;
  /** Its place in the run's list. */
  k: number;
  again?: InterruptedProblem;
}

async function execute(o: RunOptions, resume?: RecordedRun): Promise<RunResult> {
  const { config } = o;
  const problems = checkConfig(config);
  if (problems.length > 0) throw new RunSetupError(`invalid run configuration: ${problems.join("; ")}`);
  const enabled = resolveLines(config.lines ?? [], o.lines ?? LINES, config.lineOptions ?? {});
  if (enabled.problems.length > 0) throw new RunSetupError(`the lines of the run${resume !== undefined ? " as the journal recorded them" : ""}: ${enabled.problems.join("; ")}`);
  // What of the run is known before the registry is built: the prompts, the policy and the lines.
  const promptRecord = { version: PROMPT_VERSION, hash: promptHash(config.notesChars, config.tools.map(toolName)) };
  // Where the learned records of this run come from (documentation/memory.md, "Provenance and epochs").
  const provenance: ProvenanceContext = {
    modelId: config.model,
    promptVersion: PROMPT_VERSION,
    mathlibRev: o.index.source.rev,
    harnessVersion: o.codeRev ?? "unknown",
    budgetClass: budgetClassOf(config.budget.problemUsd),
  };
  const policyRecord = { holes: SKETCH_POLICY.holes, timeoutSec: SKETCH_POLICY.timeoutSec, allowedAxioms: [...SKETCH_POLICY.allowedAxioms] };
  const linesRecord = enabled.lines.map(({ line, options }) => ({
    id: line.id,
    ...(line.version !== undefined ? { version: line.version } : {}),
    options,
  }));
  if (resume !== undefined) {
    // Before anything is opened or written: a run is resumed only if nothing it was begun with changed.
    const refusals = resumeRefusals(enabled.lines);
    if (refusals.length > 0) throw new RunSetupError(`the run cannot be resumed: ${refusals.join("; ")}`);
    const changed = configMismatches(resume.started.config, {
      prompt: promptRecord,
      policy: policyRecord,
      ...(linesRecord.length > 0 ? { lines: linesRecord } : {}),
    });
    if (changed.length > 0) throw new RunSetupError(`the run cannot be resumed with this code: ${changed.join("; ")}`);
    // A run is complete when every problem has an outcome and its last end came after its last resumption.
    // One whose process ended after the last outcome and before `run.finished` is resumed to write it.
    const ended = new Set(resume.events.flatMap((event) => (event.type === "problem.finished" ? [event.data.problemId] : [])));
    const lastEnd = resume.events.findLastIndex((event) => event.type === "run.finished");
    const lastResumption = resume.events.findLastIndex((event) => event.type === "run.resumed");
    if (lastEnd > lastResumption && o.problems.every((entry) => ended.has(entry.id))) {
      throw new RunSetupError(`the run is complete: every problem has an outcome and the run finished, so there is nothing to resume in ${o.dir}`);
    }
  }
  const model = await resolveModel(o.models, config.model);
  if (resume === undefined && existsSync(join(o.dir, "journal.jsonl")) && statSync(join(o.dir, "journal.jsonl")).size > 0) {
    throw new RunSetupError(`${o.dir} already holds a run; choose another directory`);
  }
  const runId = resume?.runId ?? o.runId ?? newId("run");
  const log = o.log ?? (() => {});
  const created = resume === undefined && !existsSync(o.dir);
  let journal: Journal;
  try {
    // A resume may still refuse (the host, registry, tools or certifier are not the run's): it leaves the
    // journal's cut last line for `beginResumption` to deal with, so that a refusal writes nothing to it.
    journal = Journal.open(o.dir, runId, resume !== undefined ? { deferRepair: true } : {});
  } catch (error) {
    if (resume === undefined) throw error;
    throw new RunSetupError(`the journal of ${o.dir} cannot be opened: ${messageOf(error)}`, { cause: error });
  }
  const blobs = new BlobStore(join(o.dir, "blobs"));
  const abandon = async (message: string, cause: unknown, opened?: Registry): Promise<never> => {
    await opened?.close();
    journal.close();
    if (created) rmSync(o.dir, { recursive: true, force: true });
    throw new RunSetupError(message, { cause });
  };
  let registry: Registry;
  try {
    registry = o.registry(journal, blobs);
  } catch (error) {
    return await abandon(`the registry of the run: ${messageOf(error)}`, error);
  }
  const certifier = o.certifier ?? RegistryLeanCertifier.forHost(registry);
  // A certifier of the host that its factory refuses to make (no project, no sandbox) would fail every
  // certification of the run: the run says so now, and the journal records why.
  const unusable = o.certifier === undefined && certifier !== undefined ? await registry.usable(LEAN_CERTIFY) : undefined;
  const certifierDown = unusable !== undefined && !unusable.ok ? unusable.detail : undefined;
  const toolProblems = checkTools(registry, config.tools);
  if (toolProblems.length > 0) return await abandon(`the tools of the run: ${toolProblems.join("; ")}`, undefined, registry);
  // A tool that cannot be reached now would answer every prover's call with an error.
  const pinned = await pinTools(registry, config.tools);
  if (pinned.problems.length > 0) return await abandon(pinned.problems.join("; "), undefined, registry);
  // The statement identity of the run is the one an enabled line gives; without one, the text's.
  const giver = enabled.lines.find((entry) => entry.line.identity !== undefined)?.line;
  let identity: StatementIdentity | undefined;
  try {
    identity = giver?.identity?.({ registry });
  } catch (error) {
    return await abandon(`the statement identity of line ${giver?.id}: ${messageOf(error)}`, error, registry);
  }
  for (const sub of ["transcripts", "proofs"]) mkdirSync(join(o.dir, sub), { recursive: true });

  // The task ledger: the orchestrator is its only writer (documentation/ledger.md).
  const tasks = new TaskLedger(journal);
  const router = new Router(journal, tasks);

  const toolsRecord = pinned.tools.map((t) => ({ ...t }));
  const certifierRecord = certifier === undefined ? null : `${certifier.implementation} ${certifier.version}`;
  const certifierNote =
    certifier === undefined
      ? `no certifier on host ${registry.host.host}: a proof that passes the fast check stays a candidate`
      : certifierDown !== undefined
        ? `certifier ${certifier.implementation} ${certifier.version} is unavailable on host ${registry.host.host} (${certifierDown}): a proof that passes the fast check stays a candidate`
        : `certifier: ${certifier.implementation} ${certifier.version}`;
  if (resume === undefined) {
    const recorded: Json = {
      selection: config.selection,
      problemsHash: hashJson(o.problems.map((p) => p.id)),
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      provers: config.provers,
      sessions: config.sessions,
      limits: { turns: config.limits.turns, contextTokens: config.limits.contextTokens },
      notesChars: config.notesChars,
      budget: { problemUsd: config.budget.problemUsd, runUsd: config.budget.runUsd ?? null },
      concurrency: config.concurrency,
      tools: toolsRecord,
      bench: { hash: o.index.hash, source: { ...o.index.source } },
      registry: registry.hash,
      prompt: promptRecord,
      policy: policyRecord,
      certifier: certifierRecord,
      ...(certifierDown !== undefined ? { certifierUnavailable: certifierDown } : {}),
      // Only with lines, so that an M0 run records what it always did.
      ...(linesRecord.length > 0 ? { lines: linesRecord } : {}),
    };
    writeFileSync(
      join(o.dir, "config.json"),
      `${JSON.stringify({ runId, ...(recorded as object), problems: o.problems.map((p) => p.id), codeRev: o.codeRev ?? null }, null, 2)}\n`,
    );
    journal.emit(
      "run.started",
      {
        runId,
        benchId: o.index.benchId,
        problems: o.problems.length,
        host: registry.host.host,
        config: recorded,
        ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
      },
      "orchestrator",
    );
    log(`run ${runId}: ${o.problems.length} problem(s) of ${o.index.benchId} with ${config.model} on host ${registry.host.host}, in ${o.dir}`);
    for (const note of pinned.notes) log(note);
    log(certifierNote);
  } else {
    // What needs the registry is checked now that it is built: a host, registry, tool or certifier
    // that is not the run's would make it another run.
    const changed = [
      ...(resume.started.host !== registry.host.host ? [`the host: the run recorded ${resume.started.host}, now ${registry.host.host}`] : []),
      ...configMismatches(resume.started.config, { registry: registry.hash, tools: toolsRecord, certifier: certifierRecord }),
    ];
    if (changed.length > 0) return await abandon(`the run cannot be resumed here: ${changed.join("; ")}`, undefined, registry);
    const resumption = beginResumption(journal, tasks, { runId, ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}) });
    log(`resuming run ${runId}: ${o.problems.length} problem(s) of ${o.index.benchId} with ${config.model} on host ${registry.host.host}, in ${o.dir}`);
    log(
      `resumption ${resumption.resumption}: ${resumption.interrupted.attempts} session(s), ${resumption.interrupted.toolRuns} tool run(s) and ${resumption.interrupted.tasks} task(s) were cut by the interruption` +
        `${resumption.tornTail !== undefined ? `; the journal's last line was cut (${resumption.tornTail.bytes} bytes ${resumption.tornTail.action === "dropped" ? "dropped" : "kept: it was a whole event"})` : ""}`,
    );
    for (const note of pinned.notes) log(note);
    log(certifierNote);
  }

  // The memory and the lines' runtime exist only when a line is enabled: M0 runs as it always did.
  let runLines: RunLines | undefined;
  let benches: ClaimBenches | undefined;
  let memory: MemoryStore | undefined;
  if (enabled.lines.length > 0) {
    memory = new MemoryStore({ journal, blobs, provenance, ...(identity !== undefined ? { identity } : {}) });
    benches = new ClaimBenches({ journal, registry, memory, blobs, log, ...(certifier !== undefined ? { certifier } : {}) });
    runLines = new RunLines({
      lines: enabled.lines,
      runId,
      journal,
      blobs,
      registry,
      memory,
      benches,
      tasks,
      models: o.models,
      model: config.model,
      resolveModel: (name) => resolveModel(o.models, name),
      thinkingLevel: config.thinkingLevel,
      log,
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    });
    log(`lines: ${runLines.ids.join(", ")}`);
  }

  const runLedger = new Ledger(config.budget.runUsd);
  // The outcomes the earlier processes wrote stay; the budget starts from what the journal says was spent.
  const results: ProblemResult[] = resume === undefined ? [] : finishedResults(resume.events, o.problems, o.dir);
  if (resume !== undefined) runLedger.seed(journal.projection.totalSpend());
  let stopped: string | undefined;
  let failedInARow = 0;
  const stopReason = (): string | undefined => {
    if (stopped !== undefined) return stopped;
    if (o.signal?.aborted) return "aborted";
    if (runLedger.exhausted) return "budget_exhausted";
    return undefined;
  };

  const runProblem = async ({ entry, k, again }: QueuedProblem): Promise<void> => {
    const result = await solveProblem(entry, again);
    results.push(result);
    failedInARow = result.outcome === "error" ? failedInARow + 1 : 0;
    if (failedInARow >= MAX_FAILED_PROBLEMS && stopped === undefined) stopped = "errors";
    log(
      `[${k + 1}/${o.problems.length}] ${entry.fullName}: ${result.outcome}` +
        `${result.reason !== undefined ? ` (${result.reason.slice(0, 160)})` : ""}, ${result.attempts} attempt(s), ` +
        `$${result.usd.toFixed(2)}, ${Math.round(result.durationMs / 1000)} s`,
    );
  };

  /** An M0 problem's claim: one per problem. */
  const createClaim = (entry: ProblemEntry): string => {
    const claimId = newId("clm");
    journal.emit(
      "claim.created",
      { claimId, statementId: entry.statementId, statement: entry.statement, origin: `bench:${o.index.benchId}`, status: "open" },
      "orchestrator",
    );
    return claimId;
  };

  /**
   * Works on a problem. `again` is a problem the process before had registered and not ended: its claim
   * and its registration, its tasks, its spend, the candidate it found and what its provers carried are
   * taken from the journal (documentation/ledger.md, "Resume").
   */
  const solveProblem = async (entry: ProblemEntry, again?: InterruptedProblem): Promise<ProblemResult> => {
    const started = performance.now();
    const ledger = runLedger.child(config.budget.problemUsd);
    if (again !== undefined) ledger.seed(journal.projection.problemSpend(entry.id));
    const domain = entry.ams.map((code) => `msc:${String(code).padStart(2, "0")}`);
    let attempts = 0;
    // The problem's file is read before its claim is made: its prefix is the header the statement is read under.
    let loaded: LoadedProblem | undefined;
    let loadFailure = "";
    try {
      loaded = loadProblem(o.checkout, entry);
    } catch (error) {
      loadFailure = messageOf(error);
    }
    // With lines, the claim is the memory's: a problem whose statement and prefix already are a
    // claim shares it. A statement the memory cannot name (not in signature form, or the identity
    // fails on it) ends this problem as an error, with a claim made as in M0 to register it by.
    let claimId: string;
    let namingFailure: string | undefined;
    if (again !== undefined) {
      claimId = again.claimId;
    } else if (memory === undefined) {
      claimId = createClaim(entry);
    } else {
      try {
        claimId = (
          await memory.withActor("orchestrator").ensureClaim({
            statement: entry.statement,
            ...(loaded !== undefined ? { header: loaded.sketch.prefix } : {}),
            origin: `bench:${o.index.benchId}`,
            domain,
          })
        ).claimId;
      } catch (error) {
        namingFailure = messageOf(error);
        claimId = createClaim(entry);
      }
    }
    if (again === undefined) {
      journal.emit(
        "problem.registered",
        {
          problemId: entry.id,
          claimId,
          target: entry.fullName,
          source: { repo: o.index.source.repo, rev: o.index.source.rev, path: entry.path, line: entry.line },
          domain,
        },
        "orchestrator",
      );
    }
    const finish = (outcome: ProblemOutcome, reason?: string, proof?: string): ProblemResult => {
      const durationMs = Math.round(performance.now() - started);
      // What the problem did not finish is over with it: a task that was never started, or one a line proposed.
      tasks.closeProblem(entry.id, `the problem ended: ${outcome}`);
      journal.emit(
        "problem.finished",
        { problemId: entry.id, claimId, outcome, ...(reason !== undefined ? { reason } : {}), attempts, usd: ledger.usd, durationMs },
        "orchestrator",
      );
      return {
        problemId: entry.id, outcome, ...(reason !== undefined ? { reason } : {}), attempts, usd: ledger.usd, durationMs,
        ...(proof !== undefined ? { proof } : {}),
      };
    };
    /**
     * The end of a problem whose lines reached `beforeProvers`: their `afterProblem`, the
     * certification of what they submitted, then `finish`. `afterProblem` is told the outcome as it
     * stands: the problem's own candidate has been certified, what the lines submitted has not. The
     * lines have nothing more to submit once `afterProblem` is over, so their candidates for other
     * claims, for negations, and a late one for this claim are certified after it, and only this
     * problem's (`ClaimBenches.certifyPending`). A line that fails in `afterProblem` makes the problem
     * a harness error, except that a proof or a refutation found stays found, as when certification
     * fails.
     */
    const settle = async (lines: ProblemLines, workbench: Workbench, outcome: ProblemOutcome, reason?: string, proof?: string): Promise<ProblemResult> => {
      let failure: string | undefined;
      try {
        await lines.afterProblem({ outcome, ...(reason !== undefined ? { reason } : {}), attempts, usd: ledger.usd });
      } catch (error) {
        failure = messageOf(error);
      }
      const pending = await benches?.certifyPending({ problemId: entry.id, claimId, workbench }, o.signal);
      const ended = endOf({ outcome, ...(reason !== undefined ? { reason } : {}) }, claimId, pending, failure);
      return finish(ended.outcome, ended.reason, proof);
    };

    if (namingFailure !== undefined) return finish("error", `the memory could not name the statement: ${namingFailure}`);
    if (loaded === undefined) return finish("skipped", loadFailure);
    const problem = loaded;

    const controller = new AbortController();
    const stop = () => controller.abort(ABORT_STOPPED);
    if (o.signal?.aborted) stop();
    o.signal?.addEventListener("abort", stop, { once: true });
    try {
      let reference: Reference;
      try {
        const checker = new RegistryLeanChecker(registry, { actor: "orchestrator" });
        reference = await new ProofValidator(checker, { policy: SKETCH_POLICY }).reference(problem.sketch, problem.source, {
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return finish("aborted", "the run was stopped");
        if (error instanceof CheckFailedError && error.status === "server_error") {
          stopped ??= "lean_unavailable";
          return finish("error", `Lean could not be reached: ${error.message}`);
        }
        return finish("skipped", messageOf(error));
      }

      ledger.onExhausted(() => controller.abort(ABORT_BUDGET));
      const workbench = new Workbench({
        journal, registry, problem, claimId, problemId: entry.id, reference, blobs, ...(certifier !== undefined ? { certifier } : {}),
      });
      workbench.onCandidate(() => controller.abort(ABORT_SOLVED));
      const transcript = (attemptId: string, messages: AgentMessage[]) =>
        writeFileSync(join(o.dir, "transcripts", `${attemptId}.json`), `${JSON.stringify(messages)}\n`);

      // A problem that was begun: its attempts count as this problem's, and the candidate its checks
      // found is its candidate, with the certifier's answer for it if the journal holds one.
      let adopted = false;
      if (again !== undefined) {
        for (const attemptId of again.attemptIds) workbench.noteAttempt(attemptId);
        try {
          const recovered = recoverCandidate(journal, blobs, workbench);
          if (recovered !== undefined) {
            workbench.adopt(recovered.candidate, recovered.answer);
            adopted = true;
          }
        } catch (error) {
          return finish("error", `the problem could not be taken up again: ${messageOf(error)}`);
        }
        log(
          `${entry.fullName}: taking it up again after the interruption, ${again.attemptIds.length} attempt(s) so far` +
            `${adopted ? ", with a candidate that passed the fast check" : ""}`,
        );
      }

      // One task per prover: the ledger's record of the work (documentation/ledger.md). They exist before
      // the lines' `beforeProvers`, so that the lines can read them. A problem that was begun has them:
      // the ones the interruption cut are `ready` again.
      const proverTasks = createProverTasks(tasks, {
        problemId: entry.id,
        claimId,
        theorem: entry.fullName,
        provers: config.provers,
        sessions: config.sessions,
        problemUsd: config.budget.problemUsd,
      });
      // The provers had started if any of their tasks ever ran: the lines' `beforeProvers` came before that.
      const begun = again !== undefined && proverTasks.some((task) => (tasks.get(task.taskId)?.running_seq ?? null) !== null);
      // What ended before the interruption stays ended; the rest has work left.
      const endedBefore = proverTasks.flatMap((task) => {
        const row = tasks.get(task.taskId);
        return again !== undefined && row !== undefined && isFinalTaskStatus(row.status) ? [row] : [];
      });
      if (adopted) {
        // The candidate was found before the interruption: the prover that found it is done, and the
        // others have nothing left to do. Nothing runs; the candidate is certified as in a run that was not cut.
        const finder = workbench.candidate?.attemptId === undefined ? undefined : journal.projection.attempt(workbench.candidate.attemptId)?.task_id;
        for (const task of proverTasks) {
          if (tasks.get(task.taskId)?.status !== "ready") continue;
          const budget = "the problem's budget";
          if (task.taskId === finder) {
            tasks.start(task.taskId, `prover ${task.name} resumes after the interruption: its proof had passed the fast check`);
            endProverTask(tasks, task, { stop: "solved", sessions: config.sessions, budget });
          } else {
            endProverTask(tasks, task, { stop: "aborted", sessions: config.sessions, budget });
          }
        }
      }

      // With lines: the problem's lines, their `beforeProvers`, and `afterProblem` before the end.
      let lines: ProblemLines | undefined;
      let lineFailure: string | undefined;
      let end: (outcome: ProblemOutcome, reason?: string, proof?: string) => ProblemResult | Promise<ProblemResult> = finish;
      if (runLines !== undefined && memory !== undefined) {
        memory.setReference(claimId, { source: problem.source, theorem: entry.fullName });
        const problemLines = runLines.problem({
          problemId: entry.id,
          claimId,
          target: { theorem: entry.fullName, statement: entry.statement, source: problem.source, sketch: problem.sketch },
          domain,
          ledger,
          signal: controller.signal,
          workbench,
        });
        lines = problemLines;
        end = (outcome, reason, proof) => settle(problemLines, workbench, outcome, reason, proof);
        try {
          if (resume === undefined) {
            await problemLines.beforeProvers();
          } else {
            // What the lines submitted for other claims, and the interruption left uncertified, is taken up
            // again before the lines look at the graph, so that they see the claims as the journal has them.
            if (again !== undefined && benches !== undefined) await benches.recover({ problemId: entry.id, claimId, workbench }, controller.signal);
            const endedProvers = proverTasks.filter((task) => isFinalTaskStatus(tasks.get(task.taskId)?.status ?? "ready")).map((task) => task.name);
            // A line that rebuilds its state does it now; the others get `beforeProvers` unless the provers had started.
            await problemLines.resumeProblem(resumedProblemOf(journal, { problemId: entry.id, begun, endedProvers }));
          }
        } catch (error) {
          lineFailure = messageOf(error);
        }
      }
      // The provers that have work: all of them in a fresh problem, the ones that are `ready` in a problem
      // that was begun, each with what it carried. The journal has to give that back before any prover starts.
      const working = again === undefined ? proverTasks : proverTasks.filter((task) => tasks.get(task.taskId)?.status === "ready");
      const carried = new Map<string, ProverResume>();
      let resumeFailure: string | undefined;
      if (again !== undefined && !adopted) {
        try {
          for (const task of working) {
            const resumed = proverResumeOf(journal, blobs, task.taskId);
            if (resumed !== undefined) carried.set(task.taskId, resumed);
          }
        } catch (error) {
          resumeFailure = `the problem could not be taken up again: ${messageOf(error)}`;
        }
      }
      // A problem the lines settled, or that ended while they worked, gets no prover; nor does one whose
      // candidate was found before the interruption, or whose provers cannot be taken up again.
      const idle =
        adopted ||
        resumeFailure !== undefined ||
        (lines !== undefined && (lineFailure !== undefined || workbench.candidate !== undefined || controller.signal.aborted));
      const settled: PromiseSettledResult<ProverResult>[] = idle
        ? []
        : await Promise.allSettled(
            working.map((task) => {
              let ended = false;
              const end = (how: Parameters<typeof endProverTask>[2]) => {
                if (ended) return;
                ended = true;
                endProverTask(tasks, task, how);
              };
              const resumed = carried.get(task.taskId);
              tasks.start(task.taskId, resumed === undefined ? `prover ${task.name} starts` : `prover ${task.name} resumes after the interruption, at session ${resumed.session + 1}`);
              return runProver({
                name: task.name,
                taskId: task.taskId,
                blobs,
                workbench,
                journal,
                models: o.models,
                model,
                modelName: config.model,
                thinkingLevel: config.thinkingLevel,
                sessions: config.sessions,
                limits: config.limits,
                notesChars: config.notesChars,
                ledger,
                signal: controller.signal,
                transcript,
                tools: pinned.tools,
                stamp: (modelId) => stampProvenance(provenance, { modelId }),
                onAttemptEnd: (attempt) => void router.attemptEnded({ ...attempt, taskId: task.taskId, claimId }),
                onEnd: (result) =>
                  end({ stop: result.stop, sessions: config.sessions, budget: runLedger.exhausted ? "the run's budget" : "the problem's budget" }),
                ...(resumed !== undefined ? { resume: resumed } : {}),
                ...(lines !== undefined ? { lines } : {}),
              }).catch((error: unknown) => {
                // A harness failure stops the problem's other provers too.
                controller.abort(ABORT_STOPPED);
                end({ crash: messageOf(error) });
                throw error;
              });
            }),
          );
      const provers = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      attempts = workbench.attemptIds.length;
      const crash = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");

      const candidate = workbench.candidate;
      if (candidate !== undefined) {
        const proof = proofPath(entry);
        writeFileSync(join(o.dir, proof), candidate.report.checked);
        // Certified: proved. Rejected: unsolved, since the kernel refused the proof; the claim stays
        // `computed` and the validation says why. No answer (or no certifier): still a candidate.
        let outcome: ProblemOutcome = "candidate";
        let note: string | undefined;
        try {
          const certified = await workbench.certify(o.signal);
          if (certified !== undefined) {
            const answer = certifiedOutcome(certified);
            outcome = answer.outcome;
            note = answer.reason;
          }
        } catch (error) {
          note = `certification failed: ${messageOf(error)}`;
        }
        return await end(outcome, note, proof);
      }
      if (lineFailure !== undefined) return await end("error", lineFailure);
      if (resumeFailure !== undefined) return await end("error", resumeFailure);
      if (crash !== undefined) return await end("error", `the harness failed: ${messageOf(crash.reason)}`);
      if (o.signal?.aborted) return await end("aborted", "the run was stopped");
      if (ledger.exhausted) return await end("unsolved", runLedger.exhausted ? "the run's budget ran out" : "the problem's budget ran out");
      if (provers.length > 0 && provers.every((p) => p.stop === "errors")) return await end("error", proverErrors(journal, workbench.attemptIds));
      // The provers that ended before the interruption ended for the reasons their tasks give.
      const before = endedBefore.length === 0 ? "" : `before the interruption, ${endedBefore.map((row) => row.reason ?? row.status).join("; ")}`;
      if (provers.length === 0 && again !== undefined) return await end("unsolved", before === "" ? "no prover was left to run" : before);
      if (lines !== undefined && provers.length === 0) return await end("unsolved", "the lines ended the problem before the provers");
      return await end("unsolved", before === "" ? stopSummary(provers) : `${stopSummary(provers)}; ${before}`);
    } finally {
      o.signal?.removeEventListener("abort", stop);
    }
  };

  // The problems to work on, in order. After an interruption: first the ones the process before had begun
  // and not ended, which have to be taken up whatever is left of the run's budget (they end quickly if
  // none is), then the ones it had not begun. A problem with an outcome is not worked on again.
  const queue: QueuedProblem[] = [];
  if (resume === undefined) {
    for (const [k, entry] of o.problems.entries()) queue.push({ entry, k });
  } else {
    const begun = new Map(interruptedProblems(journal).map((problem) => [problem.problemId, problem]));
    const registered = new Set(journal.projection.problems().map((problem) => problem.problem_id));
    const untouched: QueuedProblem[] = [];
    for (const [k, entry] of o.problems.entries()) {
      const again = begun.get(entry.id);
      if (again !== undefined) queue.push({ entry, k, again });
      else if (!registered.has(entry.id)) untouched.push({ entry, k });
    }
    queue.push(...untouched);
  }
  let crashed: { error: unknown } | undefined;
  try {
    await pool(queue, config.concurrency, runProblem, (next) =>
      next.again !== undefined ? stopped !== undefined || o.signal?.aborted === true : stopReason() !== undefined,
    );
  } catch (error) {
    crashed = { error };
    stopped ??= "errors";
  } finally {
    stopped = stopReason() ?? (results.length < o.problems.length ? "aborted" : undefined);
    const summary = journal.projection.runSummary();
    journal.emit(
      "run.finished",
      {
        runId,
        attempted: results.filter((r) => r.attempts > 0).length,
        solved: summary.solved,
        refuted: summary.refuted,
        candidates: summary.candidates,
        usd: runLedger.usd,
        ...(stopped !== undefined ? { stopped } : {}),
      },
      "orchestrator",
    );
    await registry.close();
    journal.close();
  }
  if (crashed !== undefined) throw crashed.error;
  const report = writeReport(o.dir);
  return { runId, dir: o.dir, problems: results, usd: runLedger.usd, ...(stopped !== undefined ? { stopped } : {}), report };
}

/** Runs `run` on the items, `concurrency` at a time, in order, until `stop` says so of the next one. */
async function pool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>, stop: (next: T) => boolean): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop(items[next] as T)) {
      const index = next++;
      await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** How a problem ends whose candidate the certifier answered for. */
function certifiedOutcome(certified: Certification): { outcome: ProblemOutcome; reason?: string } {
  if (certified.result.verdict !== "certified") {
    return { outcome: "unsolved", reason: `certification rejected the candidate: ${certified.result.reasons.join("; ")}` };
  }
  // A claim that is not `proved` after its proof was certified was settled the other way, or withdrawn.
  return certified.status === "proved"
    ? { outcome: "proved" }
    : { outcome: "error", reason: conflictNote("the candidate", certified.status) };
}

/**
 * How a problem ends after its lines' `afterProblem` and the certification of what they submitted.
 * Only the problem's own results count for its outcome (documentation/m0-loop.md, "Certification"):
 * a certified proof or refutation of its claim that its lines submitted makes an `unsolved` or
 * `candidate` problem `proved` or `refuted`; a claim that another problem settled does not, whether
 * the other problem shares the claim or not. A certified proof or refutation that contradicts the
 * problem's own claim makes it an `error`, whichever way the contradiction goes; one about another
 * claim is noted in the reason and changes nothing else. A failure of a line in `afterProblem` ends
 * the problem as an error, unless a proof or a refutation was found (or a candidate).
 */
function endOf(
  planned: { outcome: ProblemOutcome; reason?: string },
  claimId: string,
  pending: PendingResult | undefined,
  failure: string | undefined,
): { outcome: ProblemOutcome; reason?: string } {
  const conflicts = pending?.conflicts ?? [];
  let outcome = planned.outcome;
  // The reason of an outcome that was not an error says why the problem was not solved, not why it failed.
  let reason = planned.reason;
  if (conflicts.some((c) => c.claimId === claimId)) {
    if (outcome !== "error") reason = undefined;
    outcome = "error";
  } else if (pending?.settled !== undefined && (outcome === "unsolved" || outcome === "candidate")) {
    outcome = pending.settled;
  }
  const notes = conflicts.map((c) => c.message);
  if (failure !== undefined && outcome !== "proved" && outcome !== "refuted" && outcome !== "candidate") {
    return { outcome: "error", reason: [...notes, failure].join("; ") };
  }
  if (reason !== undefined) notes.unshift(reason);
  if (failure !== undefined) notes.push(failure);
  return notes.length > 0 ? { outcome, reason: notes.join("; ") } : { outcome };
}

function stopSummary(provers: readonly ProverResult[]): string {
  const counts = new Map<string, number>();
  for (const p of provers) counts.set(p.stop, (counts.get(p.stop) ?? 0) + 1);
  return `provers stopped: ${[...counts].map(([stop, n]) => `${n} ${stop}`).join(", ")}`;
}

function proverErrors(journal: Journal, attemptIds: readonly string[]): string {
  const errors = attemptIds.flatMap((id) => {
    const error = journal.projection.attempt(id)?.error;
    return error === undefined || error === null ? [] : [error];
  });
  return `every prover failed: ${[...new Set(errors)].slice(0, 3).join("; ")}`;
}
