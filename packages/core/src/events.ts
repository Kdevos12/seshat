import type { Json } from "./canonical-json.ts";
import type { MemoryFrom } from "./chain.ts";
import type { EpochChange, Provenance } from "./provenance.ts";
import type { AttemptRole, ClaimKind, EdgeKind, EdgeLink } from "./records.ts";
import type { ClaimStatus, EdgeStatus } from "./status.ts";
import type { RouteAction, RouteSignalType, TaskAcceptance, TaskBudget, TaskKind, TaskStatus } from "./tasks.ts";

/**
 * Every fact the harness learns is an event appended to the journal. The SQLite projection and all
 * indexes are derived from it and can be rebuilt; the journal is the only source of truth.
 */
export interface EventEnvelope<T extends string = string, D = unknown> {
  v: 1;
  /** Position in the journal, from 0. */
  seq: number;
  id: string;
  /** ISO 8601 time of the append. */
  ts: string;
  run: string;
  /** Who produced the fact: `orchestrator`, `prover:<id>`, `validator`, a capability id... */
  actor: string;
  type: T;
  data: D;
  /** Hash of the previous event, "" for the first one. */
  prev: string;
  /** sha256 of the canonical JSON of this envelope without `hash`. */
  hash: string;
}

export interface SourceRef {
  repo: string;
  rev: string;
  path: string;
  line?: number;
}

export interface TokenCost {
  usd: number;
  /** Input tokens in all: the ones billed at the full price, the cache reads and the cache writes. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Of `inputTokens`, the ones the provider read from its prompt cache (pi-ai's `cacheRead`). Absent
   * when none was, and in journals written before this field.
   */
  cachedInputTokens?: number;
}

/**
 * What a crash left at the end of a journal: a last line that is not a whole event. `dropped`: the
 * fragment was cut off and is gone (its byte count and hash are kept here); `completed`: the line
 * was a whole event, verified by the hash chain, missing only its newline, and it was kept.
 */
export interface TornTail {
  action: "dropped" | "completed";
  bytes: number;
  /** sha256 of the bytes after the last newline. */
  sha256: string;
}

/**
 * What a prover carries from one session to the next, as blobs: its regions, the text of its last
 * check, and the notes the next session starts from. A resumed prover starts from the carry of its
 * last finished session; a field that is absent is not set.
 */
export interface AttemptCarry {
  /** Blob of `{aux, proof}`. */
  regions: string;
  /** Blob of the last check as the prover read it. */
  lastCheck?: string;
  /** Blob of the notes. */
  notes?: string;
}

export type AttemptOutcome = "valid" | "invalid" | "no_submission" | "budget_exhausted" | "aborted" | "error";

/**
 * How a problem ended: `proved` (its own candidate, or a proof of its claim that its own lines
 * submitted, was certified), `refuted` (a proof of the negation of its claim, submitted by its own
 * lines, was certified, which a line that proves negations can do: the claim is `refuted`, not
 * `proved`; a claim that another problem settled does not count), `candidate` (passed the
 * fast check only, or the certifier could not decide), `unsolved` (the budget or the sessions ran
 * out, or the certifier rejected the candidate), `skipped` (it could not be set up: its file
 * changed, it cannot be cut into a sketch, or the original does not compile), `aborted` (the run was
 * stopped), `error` (the harness failed, Lean could not be reached, every prover kept failing, or
 * a certified proof or refutation of its claim contradicted the claim's status).
 */
export type ProblemOutcome = "proved" | "refuted" | "candidate" | "unsolved" | "skipped" | "aborted" | "error";

export interface EventDataMap {
  "run.started": {
    runId: string;
    benchId: string;
    problems: number;
    host: string;
    config: Json;
    codeRev?: string;
    /**
     * The earlier run this one starts on: its journal is replayed before this one, checked against
     * `lastHash` (documentation/memory.md, "Memory across runs"). Absent: a run from nothing.
     */
    memoryFrom?: MemoryFrom;
  };
  "run.finished": {
    runId: string;
    /** Problems that had at least one attempt. */
    attempted: number;
    /**
     * The three counts are the claims': a problem is counted when its claim has the status,
     * whichever problem settled it, so two problems that share a claim are counted twice. They are
     * not the problems' outcomes (`problem.finished`): a problem that found nothing of its own is
     * `unsolved` while its claim is `proved`.
     *
     * Problems whose claim is `proved`.
     */
    solved: number;
    /** Problems whose claim is `refuted`: a certified proof of the negation. Absent in journals older than the certifier. */
    refuted?: number;
    /**
     * Problems whose claim is `computed`: a proof passed the fast check and is not certified,
     * because the certifier gave no answer or the kernel rejected it (that problem is `unsolved`).
     */
    candidates: number;
    usd: number;
    /**
     * Why the run stopped before its last problem: `aborted`, `budget_exhausted`, `lean_unavailable`,
     * `lean_environment` (the Lean server cannot import the environment's libraries), or
     * `errors` (problems ended with a harness error in a row).
     */
    stopped?: string;
  };
  /**
   * The run continues after the process that ran it ended without finishing (a crash, a kill, a
   * usage limit), or after it stopped early. Written first by the orchestrator, before it closes what
   * the earlier process left open (documentation/ledger.md, "Resume").
   */
  "run.resumed": {
    runId: string;
    /** 1 for the first resumption of the run, then 2... */
    resumption: number;
    /** A last line that the crash cut, and what was done with it. */
    tornTail?: TornTail;
    /** What the journal accounts for as spent when the run continues: the budgets start from this. */
    spent: TokenCost;
    /** What was left open and is closed now. */
    interrupted: { attempts: number; toolRuns: number; tasks: number };
    codeRev?: string;
  };
  "problem.registered": {
    problemId: string;
    claimId: string;
    target: string;
    source: SourceRef;
    domain: string[];
  };
  "problem.finished": {
    problemId: string;
    claimId: string;
    outcome: ProblemOutcome;
    reason?: string;
    attempts: number;
    usd: number;
    durationMs: number;
  };
  "claim.created": {
    claimId: string;
    statementId: string;
    /**
     * A Lean statement in signature form: the binders, then `:` and the type, as between a theorem's
     * name and its `:=` (`(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`). Prose for an informal claim.
     */
    statement: string;
    origin: string;
    status: ClaimStatus;
    /** A short gloss in words. */
    gloss?: string;
    domain?: string[];
    /** Default `formal`. */
    kind?: ClaimKind;
    /** The claim this one was derived from (a variant, a subgoal, a part). */
    parentId?: string;
    /** The Lean text the statement needs before it: imports, `open`s, definitions. */
    header?: string;
  };
  "claim.status_changed": {
    claimId: string;
    from: ClaimStatus;
    to: ClaimStatus;
    reason: string;
    attemptId?: string;
    validationId?: string;
  };
  "attempt.started": {
    attemptId: string;
    claimId: string;
    prover: string;
    iteration: number;
    model: string;
    /** Absent: `prove`. */
    role?: AttemptRole;
    /** The strategy the attempt was given or declared. */
    strategy?: string;
    /** The part of the claim's sketch the attempt works on, when it works on one. */
    subgoal?: string;
    /** The task the attempt works for. It must be running. */
    taskId?: string;
    /** Where the model calls of the attempt are made. Absent: `prover.session`. */
    site?: string;
    /** Where this learned record comes from (documentation/memory.md, "Provenance and epochs"). */
    provenance?: Provenance;
    /**
     * The unverified memory items a line drew into the session, and the ones the draw withheld
     * (documentation/memory.md, "Randomized inclusion"). Absent: no draw was made for the session.
     */
    included?: string[];
    withheld?: string[];
    /**
     * The settings the session was given by a line that samples them (documentation/fleet.md,
     * "Sampled settings"): `temperature`, `thinking`, `directive`, `mode`... Absent: the run's own.
     */
    settings?: { [key: string]: Json };
    /**
     * True when the session's strategy was drawn by the exploration floor (documentation/fleet.md),
     * uniformly among the allowed labels and not from the posteriors. Absent: it was not.
     */
    exploration?: boolean;
  };
  /**
   * A model response of a session was paid for. The attempt's totals are in `attempt.finished`;
   * these events keep the cost of a session that never finished, which the budgets of a resumed run
   * count.
   */
  "attempt.charged": TokenCost & {
    attemptId: string;
  };
  "attempt.finished": TokenCost & {
    attemptId: string;
    outcome: AttemptOutcome;
    /** The kind of failure of the attempt's last check, for an `invalid` attempt. */
    failureClass?: string;
    /** Why the session ended: `model`, `turns`, `context`, `budget`, `solved`, `aborted`, `error`, or `line:<id>`. */
    stoppedBy?: string;
    /** What failed, for an `error` attempt. */
    error?: string;
    durationMs: number;
    turns: number;
    /** The strategy classified from what the attempt submitted. */
    strategy?: string;
    /** The strategy the model declared in its last `lean_check` that gave one; replaces the one given at the start. */
    declaredStrategy?: string;
    /** The names the final proof text uses. */
    premises?: string[];
    /** A short typed summary of the failure, such as `unsolved goals at case succ`. */
    failureDetail?: string;
    /** What the prover carries to its next session. */
    carry?: AttemptCarry;
  };
  "tool_run.started": {
    toolRunId: string;
    capability: string;
    implementation: string;
    version: string;
    inputHash: string;
    /** Time limit of the call. */
    timeoutMs?: number;
    attemptId?: string;
    /** Of a stateful capability: the calls with the same scope share state, in journal order. */
    scope?: string;
  };
  "tool_run.finished": {
    toolRunId: string;
    /** `aborted`: the caller gave up (a budget ran out, a run was stopped), not a failure of the tool. */
    outcome: "ok" | "error" | "timeout" | "aborted";
    durationMs: number;
    outputHash?: string;
    summary?: Json;
  };
  "lesson.recorded": {
    attemptId: string;
    claimId: string;
    text: string;
    provenance?: Provenance;
  };
  "validation.finished": {
    validationId: string;
    claimId: string;
    attemptId?: string;
    /** `repl`: fast check, a valid verdict makes a candidate. `kernel_replay`: certification. */
    method: "repl" | "kernel_replay";
    verdict: "valid" | "invalid";
    reasons: string[];
    axioms: string[];
    submissionHash: string;
    /** True when the submission proves the negation of the claim's statement: a refutation. */
    negation?: boolean;
    /** The problem whose workbench checked the submission: the problem that certifies what it made a candidate. */
    problemId?: string;
  };
  "edge.added": {
    edgeId: string;
    kind: EdgeKind;
    /** A claim or node id. */
    from: string;
    /** Claim or node ids: one, or the parts of a `decomposes_into`. */
    to: string[];
    status: EdgeStatus;
    attemptId?: string;
    toolRunId?: string;
    /** For a `lean_checked` edge, the valid validation of its link lemma. */
    validationId?: string;
    note?: string;
    /** The Lean lemma that makes the edge true, for the kinds a lemma can check. */
    link?: EdgeLink;
  };
  "edge.status_changed": {
    edgeId: string;
    from: EdgeStatus;
    to: EdgeStatus;
    reason: string;
    validationId?: string;
  };
  "node.recorded": {
    nodeId: string;
    /** A short lowercase word (`lemma`, `lesson`, `fingerprint`...); the package that owns it owns `data`. */
    kind: string;
    claimId?: string;
    data: Json;
    /** Set on a node a mechanism learned from outcomes rather than from Lean (Global Constraint 16). */
    provenance?: Provenance;
  };
  "node.updated": {
    nodeId: string;
    /** A JSON merge patch (RFC 7386) applied to the node's data. */
    patch: Json;
    reason: string;
  };
  "model_call.finished": TokenCost & {
    modelCallId: string;
    /** The line that made the call. */
    line: string;
    problemId?: string;
    attemptId?: string;
    /** `provider/id`. */
    model: string;
    outcome: "ok" | "error" | "aborted";
    /** Where the call is made, such as `graph.attempt` (`SITE`). Absent in journals older than the tags. */
    site?: string;
    /** Blob of the request (model, system prompt, prompt, token limit). */
    requestHash: string;
    /** Blob of the response's text. */
    responseHash?: string;
    error?: string;
    durationMs: number;
  };
  /**
   * A task of the ledger (documentation/ledger.md). Written by the orchestrator only: a line
   * proposes, the orchestrator commits. A task starts `pending`.
   */
  "task.created": {
    taskId: string;
    kind: TaskKind;
    problemId?: string;
    claimId?: string;
    edgeId?: string;
    /** Tasks that must be `done` before this one is `ready`. */
    dependsOn: string[];
    /** Who works on it: an actor such as `prover:p1` or `line:M12`. Set here or by `task.assigned`. */
    owner?: string;
    /** What must hold for the task to be `done`, in terms of claim and edge statuses. */
    acceptance: TaskAcceptance;
    budget: TaskBudget;
    parentTaskId?: string;
    /** The line that proposed the task; absent for a task the orchestrator made. */
    proposedBy?: string;
    /** A few words on what it is for. */
    title?: string;
  };
  "task.assigned": {
    taskId: string;
    owner: string;
    reason: string;
  };
  "task.status_changed": {
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason: string;
    /** For `blocked`: the task ids, or `ext:<name>` keys, that it waits for. */
    blockedBy?: string[];
  };
  /**
   * A routing decision: what to do about a task that met a typed signal. The event is the decision
   * and nothing more: it changes no status, of a task or of a claim.
   */
  "task.routed": {
    taskId: string;
    action: RouteAction;
    signal: { type: RouteSignalType; value: string };
    reason: string;
    /** The attempt whose failure it answers. */
    attemptId?: string;
    /** The `drift` node it answers. */
    nodeId?: string;
  };
  /**
   * The memory enters a new epoch: the prover model family, the prompts' major version or the Mathlib
   * revision is not the one of the memory's previous run. The unverified artifacts of older epochs
   * are in probation from here on (documentation/memory.md, "Provenance and epochs"). Written by the
   * orchestrator only; nothing is deleted.
   */
  "memory.epoch_opened": {
    /** The new epoch's number: the epoch before it plus one. Epoch 0 is the first, and has no event. */
    epoch: number;
    reason: string;
    changes: EpochChange[];
    /** The run that opened it. */
    provenance: Provenance;
  };
}

export type EventType = keyof EventDataMap;

export type HarnessEvent = { [K in EventType]: EventEnvelope<K, EventDataMap[K]> }[EventType];

/** An event before it is appended: the type and its data, correlated. */
export type EventBody = { [K in EventType]: { type: K; data: EventDataMap[K] } }[EventType];

export const EVENT_TYPES: readonly EventType[] = [
  "run.started",
  "run.finished",
  "problem.registered",
  "problem.finished",
  "claim.created",
  "claim.status_changed",
  "attempt.started",
  "attempt.finished",
  "tool_run.started",
  "tool_run.finished",
  "lesson.recorded",
  "validation.finished",
  "edge.added",
  "edge.status_changed",
  "node.recorded",
  "node.updated",
  "model_call.finished",
  "run.resumed",
  "attempt.charged",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.routed",
  "memory.epoch_opened",
];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}
