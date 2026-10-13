import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { BenchIndex, ProblemEntry } from "@math-harness/bench";
import {
  BlobStore,
  CheckFailedError,
  hashJson,
  Journal,
  type Json,
  type LeanCertifier,
  newId,
  type ProblemOutcome,
  ProofValidator,
  type Reference,
  SKETCH_POLICY,
  sha256Hex,
} from "@math-harness/core";
import { messageOf, RegistryLeanChecker, type Registry } from "@math-harness/registry";
import { Ledger } from "./budget.ts";
import { type LoadedProblem, loadProblem, Workbench } from "./problem.ts";
import { PROMPT_VERSION, promptHash } from "./prompt.ts";
import { type ProverResult, runProver } from "./prover.ts";
import { type RunReport, writeReport } from "./report.ts";
import { ABORT_BUDGET, ABORT_SOLVED, ABORT_STOPPED, type SessionLimits } from "./session.ts";

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
}

export const DEFAULT_CONFIG: Omit<RunConfig, "selection" | "model"> = {
  thinkingLevel: "medium",
  provers: 4,
  sessions: 8,
  limits: { turns: 40, contextTokens: 120_000 },
  notesChars: 4000,
  budget: { problemUsd: 5 },
  concurrency: 1,
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
  certifier?: LeanCertifier;
  /** Stops the run: the problems in progress end as `aborted`. */
  signal?: AbortSignal;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
  /** Revision of this repository. */
  codeRev?: string;
  runId?: string;
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

/**
 * The run could not start: its configuration, model, directory or registry is wrong. No event was
 * written, and a run directory created for the run was removed.
 */
export class RunSetupError extends Error {}

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
  const { config } = o;
  const problems = checkConfig(config);
  if (problems.length > 0) throw new RunSetupError(`invalid run configuration: ${problems.join("; ")}`);
  const model = await resolveModel(o.models, config.model);
  if (existsSync(join(o.dir, "journal.jsonl")) && statSync(join(o.dir, "journal.jsonl")).size > 0) {
    throw new RunSetupError(`${o.dir} already holds a run; choose another directory`);
  }
  const runId = o.runId ?? newId("run");
  const log = o.log ?? (() => {});
  const created = !existsSync(o.dir);
  const journal = Journal.open(o.dir, runId);
  const blobs = new BlobStore(join(o.dir, "blobs"));
  let registry: Registry;
  try {
    registry = o.registry(journal, blobs);
  } catch (error) {
    journal.close();
    if (created) rmSync(o.dir, { recursive: true, force: true });
    throw new RunSetupError(`the registry of the run: ${messageOf(error)}`, { cause: error });
  }
  for (const sub of ["transcripts", "proofs"]) mkdirSync(join(o.dir, sub), { recursive: true });

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
    bench: { hash: o.index.hash, source: { ...o.index.source } },
    registry: registry.hash,
    prompt: { version: PROMPT_VERSION, hash: promptHash(config.notesChars) },
    policy: { holes: SKETCH_POLICY.holes, timeoutSec: SKETCH_POLICY.timeoutSec, allowedAxioms: [...SKETCH_POLICY.allowedAxioms] },
    certifier: o.certifier === undefined ? null : `${o.certifier.implementation} ${o.certifier.version}`,
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

  const runLedger = new Ledger(config.budget.runUsd);
  const results: ProblemResult[] = [];
  let stopped: string | undefined;
  let failedInARow = 0;
  const stopReason = (): string | undefined => {
    if (stopped !== undefined) return stopped;
    if (o.signal?.aborted) return "aborted";
    if (runLedger.exhausted) return "budget_exhausted";
    return undefined;
  };

  const runProblem = async (entry: ProblemEntry, k: number): Promise<void> => {
    const result = await solveProblem(entry);
    results.push(result);
    failedInARow = result.outcome === "error" ? failedInARow + 1 : 0;
    if (failedInARow >= MAX_FAILED_PROBLEMS && stopped === undefined) stopped = "errors";
    log(
      `[${k + 1}/${o.problems.length}] ${entry.fullName}: ${result.outcome}` +
        `${result.reason !== undefined ? ` (${result.reason.slice(0, 160)})` : ""}, ${result.attempts} attempt(s), ` +
        `$${result.usd.toFixed(2)}, ${Math.round(result.durationMs / 1000)} s`,
    );
  };

  const solveProblem = async (entry: ProblemEntry): Promise<ProblemResult> => {
    const started = performance.now();
    const claimId = newId("clm");
    const ledger = runLedger.child(config.budget.problemUsd);
    let attempts = 0;
    journal.emit(
      "claim.created",
      { claimId, statementId: entry.statementId, statement: entry.statement, origin: `bench:${o.index.benchId}`, status: "open" },
      "orchestrator",
    );
    journal.emit(
      "problem.registered",
      {
        problemId: entry.id,
        claimId,
        target: entry.fullName,
        source: { repo: o.index.source.repo, rev: o.index.source.rev, path: entry.path, line: entry.line },
        domain: entry.ams.map((code) => `msc:${String(code).padStart(2, "0")}`),
      },
      "orchestrator",
    );
    const finish = (outcome: ProblemOutcome, reason?: string, proof?: string): ProblemResult => {
      const durationMs = Math.round(performance.now() - started);
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

    let problem: LoadedProblem;
    try {
      problem = loadProblem(o.checkout, entry);
    } catch (error) {
      return finish("skipped", messageOf(error));
    }

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
        journal, registry, problem, claimId, reference, blobs, ...(o.certifier !== undefined ? { certifier: o.certifier } : {}),
      });
      workbench.onCandidate(() => controller.abort(ABORT_SOLVED));
      const transcript = (attemptId: string, messages: AgentMessage[]) =>
        writeFileSync(join(o.dir, "transcripts", `${attemptId}.json`), `${JSON.stringify(messages)}\n`);
      const settled = await Promise.allSettled(
        Array.from({ length: config.provers }, (_, i) =>
          runProver({
            name: `p${i + 1}`,
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
          }).catch((error: unknown) => {
            // A harness failure stops the problem's other provers too.
            controller.abort(ABORT_STOPPED);
            throw error;
          }),
        ),
      );
      const provers = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      attempts = journal.projection.attempts(claimId).length;
      const crash = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");

      const candidate = workbench.candidate;
      if (candidate !== undefined) {
        const proof = join("proofs", `${slug(entry.fullName)}-${sha256Hex(entry.id).slice(0, 8)}.lean`);
        writeFileSync(join(o.dir, proof), candidate.report.checked);
        if (o.certifier === undefined) return finish("candidate", undefined, proof);
        try {
          const certified = await workbench.certify(o.signal);
          return certified?.verdict === "certified"
            ? finish("proved", undefined, proof)
            : finish("unsolved", `certification rejected the candidate: ${certified?.reasons.join("; ") ?? ""}`, proof);
        } catch (error) {
          return finish("candidate", `certification failed: ${messageOf(error)}`, proof);
        }
      }
      if (crash !== undefined) return finish("error", `the harness failed: ${messageOf(crash.reason)}`);
      if (o.signal?.aborted) return finish("aborted", "the run was stopped");
      if (ledger.exhausted) return finish("unsolved", runLedger.exhausted ? "the run's budget ran out" : "the problem's budget ran out");
      if (provers.length > 0 && provers.every((p) => p.stop === "errors")) return finish("error", proverErrors(journal, claimId));
      return finish("unsolved", stopSummary(provers));
    } finally {
      o.signal?.removeEventListener("abort", stop);
    }
  };

  let crashed: { error: unknown } | undefined;
  try {
    await pool(o.problems, config.concurrency, runProblem, () => stopReason() !== undefined);
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

/** Runs `run` on the items, `concurrency` at a time, in order, until `stop` says so. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
  stop: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const index = next++;
      await run(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function slug(name: string): string {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80);
}

function stopSummary(provers: readonly ProverResult[]): string {
  const counts = new Map<string, number>();
  for (const p of provers) counts.set(p.stop, (counts.get(p.stop) ?? 0) + 1);
  return `provers stopped: ${[...counts].map(([stop, n]) => `${n} ${stop}`).join(", ")}`;
}

function proverErrors(journal: Journal, claimId: string): string {
  const errors = journal.projection
    .attempts(claimId)
    .flatMap((a) => (a.error !== null ? [a.error] : []));
  return `every prover failed: ${[...new Set(errors)].slice(0, 3).join("; ")}`;
}
