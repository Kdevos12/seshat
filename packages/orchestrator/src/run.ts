import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { BenchIndex, ProblemEntry } from "@seshat/bench";
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
} from "@seshat/core";
import { type JsonObject, type LineRegistry, resolveLines } from "@seshat/lines";
import { MemoryStore, type StatementIdentity } from "@seshat/memory";
import { messageOf, RegistryLeanCertifier, RegistryLeanChecker, type Registry } from "@seshat/registry";
import { Ledger } from "./budget.ts";
import { type ProblemLines, RunLines } from "./line-runtime.ts";
import { LINES } from "./lines.ts";
import { type Certification, type LoadedProblem, loadProblem, Workbench } from "./problem.ts";
import { PROMPT_VERSION, promptHash } from "./prompt.ts";
import { type ProverResult, runProver } from "./prover.ts";
import { type RunReport, writeReport } from "./report.ts";
import { ABORT_BUDGET, ABORT_SOLVED, ABORT_STOPPED, type SessionLimits } from "./session.ts";
import { checkTools, pinTools, toolName } from "./tools.ts";
import { ClaimBenches } from "./validate.ts";

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
  const { config } = o;
  const problems = checkConfig(config);
  if (problems.length > 0) throw new RunSetupError(`invalid run configuration: ${problems.join("; ")}`);
  const enabled = resolveLines(config.lines ?? [], o.lines ?? LINES, config.lineOptions ?? {});
  if (enabled.problems.length > 0) throw new RunSetupError(`the lines of the run: ${enabled.problems.join("; ")}`);
  const model = await resolveModel(o.models, config.model);
  if (existsSync(join(o.dir, "journal.jsonl")) && statSync(join(o.dir, "journal.jsonl")).size > 0) {
    throw new RunSetupError(`${o.dir} already holds a run; choose another directory`);
  }
  const runId = o.runId ?? newId("run");
  const log = o.log ?? (() => {});
  const created = !existsSync(o.dir);
  const journal = Journal.open(o.dir, runId);
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
    tools: pinned.tools.map((t) => ({ ...t })),
    bench: { hash: o.index.hash, source: { ...o.index.source } },
    registry: registry.hash,
    prompt: { version: PROMPT_VERSION, hash: promptHash(config.notesChars, config.tools.map(toolName)) },
    policy: { holes: SKETCH_POLICY.holes, timeoutSec: SKETCH_POLICY.timeoutSec, allowedAxioms: [...SKETCH_POLICY.allowedAxioms] },
    certifier: certifier === undefined ? null : `${certifier.implementation} ${certifier.version}`,
    // Only with lines, so that an M0 run records what it always did.
    ...(enabled.lines.length > 0
      ? {
          lines: enabled.lines.map(({ line, options }) => ({
            id: line.id,
            ...(line.version !== undefined ? { version: line.version } : {}),
            options,
          })),
        }
      : {}),
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
  log(
    certifier === undefined
      ? `no certifier on host ${registry.host.host}: a proof that passes the fast check stays a candidate`
      : `certifier: ${certifier.implementation} ${certifier.version}`,
  );

  // The memory and the lines' runtime exist only when a line is enabled: M0 runs as it always did.
  let runLines: RunLines | undefined;
  let benches: ClaimBenches | undefined;
  let memory: MemoryStore | undefined;
  if (enabled.lines.length > 0) {
    memory = new MemoryStore({ journal, blobs, ...(identity !== undefined ? { identity } : {}) });
    benches = new ClaimBenches({ journal, registry, memory, blobs, log, ...(certifier !== undefined ? { certifier } : {}) });
    runLines = new RunLines({
      lines: enabled.lines,
      runId,
      journal,
      blobs,
      registry,
      memory,
      benches,
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

  const solveProblem = async (entry: ProblemEntry): Promise<ProblemResult> => {
    const started = performance.now();
    const ledger = runLedger.child(config.budget.problemUsd);
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
    if (memory === undefined) {
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
    /**
     * A problem that is `unsolved` or only a `candidate` ends as `proved` or `refuted` when a
     * certified proof or refutation has settled its claim, whoever submitted it: a line, or the
     * problem that shares the claim. Any other outcome stands.
     */
    const outcomeOf = (outcome: ProblemOutcome): ProblemOutcome => {
      if (outcome !== "unsolved" && outcome !== "candidate") return outcome;
      const status = journal.projection.claim(claimId)?.status;
      return status === "proved" || status === "refuted" ? status : outcome;
    };
    const finish = (planned: ProblemOutcome, reason?: string, proof?: string): ProblemResult => {
      const outcome = outcomeOf(planned);
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
    /**
     * The end of a problem whose lines reached `beforeProvers`: their `afterProblem`, the
     * certification of what they submitted, then `finish`. A line that fails in `afterProblem` makes
     * the problem a harness error, except that a proof found stays found, as when certification
     * fails. The lines have nothing more to submit once `afterProblem` is over, so the candidates
     * of other claims, of negations, and a late one of this claim are certified after it.
     */
    const settle = async (lines: ProblemLines, workbench: Workbench, outcome: ProblemOutcome, reason?: string, proof?: string): Promise<ProblemResult> => {
      let failure: string | undefined;
      try {
        await lines.afterProblem({ outcome: outcomeOf(outcome), ...(reason !== undefined ? { reason } : {}), attempts, usd: ledger.usd });
      } catch (error) {
        failure = messageOf(error);
      }
      await benches?.certifyPending(o.signal, [workbench]);
      if (failure === undefined) return finish(outcome, reason, proof);
      if (outcome !== "proved" && outcome !== "candidate") return finish("error", failure);
      return finish(outcome, reason !== undefined ? `${reason}; ${failure}` : failure, proof);
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
        journal, registry, problem, claimId, reference, blobs, ...(certifier !== undefined ? { certifier } : {}),
      });
      workbench.onCandidate(() => controller.abort(ABORT_SOLVED));
      const transcript = (attemptId: string, messages: AgentMessage[]) =>
        writeFileSync(join(o.dir, "transcripts", `${attemptId}.json`), `${JSON.stringify(messages)}\n`);

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
          await problemLines.beforeProvers();
        } catch (error) {
          lineFailure = messageOf(error);
        }
      }
      // A problem the lines settled, or that ended while they worked, gets no prover.
      const idle = lines !== undefined && (lineFailure !== undefined || workbench.candidate !== undefined || controller.signal.aborted);
      const settled: PromiseSettledResult<ProverResult>[] = idle
        ? []
        : await Promise.allSettled(
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
                tools: pinned.tools,
                ...(lines !== undefined ? { lines } : {}),
              }).catch((error: unknown) => {
                // A harness failure stops the problem's other provers too.
                controller.abort(ABORT_STOPPED);
                throw error;
              }),
            ),
          );
      const provers = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      attempts = workbench.attemptIds.length;
      const crash = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");

      const candidate = workbench.candidate;
      if (candidate !== undefined) {
        const proof = join("proofs", `${slug(entry.fullName)}-${sha256Hex(entry.id).slice(0, 8)}.lean`);
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
      if (crash !== undefined) return await end("error", `the harness failed: ${messageOf(crash.reason)}`);
      if (o.signal?.aborted) return await end("aborted", "the run was stopped");
      if (ledger.exhausted) return await end("unsolved", runLedger.exhausted ? "the run's budget ran out" : "the problem's budget ran out");
      if (provers.length > 0 && provers.every((p) => p.stop === "errors")) return await end("error", proverErrors(journal, workbench.attemptIds));
      if (lines !== undefined && provers.length === 0) return await end("unsolved", "the lines ended the problem before the provers");
      return await end("unsolved", stopSummary(provers));
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

/** How a problem ends whose candidate the certifier answered for. */
function certifiedOutcome(certified: Certification): { outcome: ProblemOutcome; reason?: string } {
  if (certified.result.verdict !== "certified") {
    return { outcome: "unsolved", reason: `certification rejected the candidate: ${certified.result.reasons.join("; ")}` };
  }
  // A claim that is not `proved` after its proof was certified was settled the other way, or withdrawn.
  return certified.status === "proved"
    ? { outcome: "proved" }
    : { outcome: "error", reason: `the candidate was certified, but its claim is ${certified.status}` };
}

function slug(name: string): string {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80);
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
