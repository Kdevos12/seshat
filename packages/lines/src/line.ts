import type {
  AttemptOutcome,
  ClaimStatus,
  Json,
  ProblemOutcome,
  RouteAction,
  RouteSignalType,
  Sketch,
  Submission,
  TaskAcceptance,
  TaskBudget,
  TaskKind,
  TaskStatus,
  TokenCost,
  ValidationReport,
} from "@seshat/core";
import type { MemoryStore, StatementIdentity } from "@seshat/memory";
import type { JsonSchema, Registry } from "@seshat/registry";
import type { LineId } from "./ids.ts";

/** A JSON object: a line's options, a tool's argument schema. */
export type JsonObject = { [key: string]: Json };

/**
 * A mechanism of the plan, as an ablation line (plan §6): what it adds to M0, the lines it needs,
 * and hooks the orchestrator calls at fixed points of a run, in `LINE_ORDER`. A run enables lines
 * with `--lines`; with none, it is M0.
 */
export interface Line {
  id: LineId;
  title: string;
  /** Lines that must be enabled with this one. */
  requires: readonly LineId[];
  /**
   * The line's options and their defaults. A run's values replace them key by key, and must have
   * the type of the default; a key that is not here is refused. A default of `null` means "not
   * set" and has no type: the run may give any JSON value for it (a number for an optional limit).
   */
  options?: JsonObject;
  /** Recorded in `run.started`: change it when the line's behavior changes. */
  version?: string;
  /**
   * How the run's memory names statements (plan §3.1): called once per run, with the run's
   * registry, so that an identity that needs Lean can use it. At most one enabled line gives it;
   * without one the memory names statements by their text (`TextIdentity`).
   */
  identity?: (env: IdentityEnv) => StatementIdentity;
  /**
   * The strategy labels the line classifies attempts with. When an enabled line gives some,
   * `lean_check` takes an optional `strategy` argument, one of the labels: the model declares what
   * it is trying, and the declaration is recorded beside the label the line classifies.
   */
  strategies?: readonly string[];
  /**
   * How a run with this line enabled may be resumed after its process ended (documentation/ledger.md,
   * "Resume"). Absent: the run is not resumed, because the line has not said it can be.
   */
  resume?: LineResume;
  hooks: LineHooks;
}

/**
 * What a line says of resuming a run it is enabled in. A resumed run is a new process: what a line
 * kept in memory is gone.
 *
 * - `"stateless"`: whatever the line knows when a hook runs, it reads from the journal, the memory
 *   or the ledger (`problem.memory`, `problem.tasks`), or it is its options, so that a hook called
 *   in the resumed process does what it would have done in the first. A problem that was cut gets
 *   its `beforeProvers` again if the cut came before the provers started, and its `afterProblem`
 *   again if the problem had not ended: those two hooks must be safe to call twice for a problem.
 * - `{refuse}`: the line keeps state that the journal cannot give back; the reason is shown to the
 *   person who tried to resume, and the run is not resumed.
 */
export type LineResume = "stateless" | { refuse: string };

/** What a line's `identity` factory gets. */
export interface IdentityEnv {
  registry: Registry;
}

/**
 * Every hook is optional and async. A hook that throws is a failure of the harness: outside a
 * session, it ends the problem (or the prover) with an error; inside one (`contextPacket`,
 * `beforeCheck`, `afterCheck`), it ends the session with an error.
 */
export interface LineHooks {
  /**
   * Once per problem, after its reference type is known and before any prover starts. It may
   * submit proofs or refutations through `validate`, add claims, edges and nodes, or settle the
   * problem: once a proof of the problem's claim passes, the remaining lines' `beforeProvers` and
   * the provers do not run.
   */
  beforeProvers?: (problem: ProblemContext) => Promise<void>;
  /**
   * Before each session, after `beforeSession`: a titled section for the session's opening
   * message, after the notes, the file and the last check.
   */
  briefing?: (session: SessionContext) => Promise<Briefing | undefined>;
  /**
   * The whole context of each model request of a session (M4), the first one included: the text
   * that replaces every message after the system prompt. Undefined leaves the request as it is.
   * At most one enabled line may give it.
   */
  contextPacket?: (session: SessionContext, request: PacketRequest) => Promise<string | undefined>;
  /** Before each session: extra tools for the prover, besides lean_check and the run's capabilities. */
  tools?: (session: SessionContext) => Promise<LineTool[]>;
  /**
   * Before each session, before its attempt is recorded: change its model, declare its strategy
   * or subgoal, skip it, or stop the prover. Decisions merge in `LINE_ORDER`: a later line's model,
   * strategy or subgoal wins, and the first `stop` or `skip` is taken.
   */
  beforeSession?: (session: SessionContext) => Promise<SessionDecision | undefined>;
  /**
   * Before each `lean_check` runs: a guard. A `reject` goes back to the model as a tool error and
   * the file is not checked: it is no check, no validation, and does not count. The first line in
   * `LINE_ORDER` that rejects is taken.
   */
  beforeCheck?: (session: SessionContext, proposal: Proposal) => Promise<CheckVeto | undefined>;
  /** After each `lean_check` of a session: a `stop` ends the session (a drift detector). */
  afterCheck?: (session: SessionContext, check: SessionCheck) => Promise<CheckDecision | undefined>;
  /**
   * After the lines' briefing sections are made, before the session starts: the sections the
   * session gets. Return the list to replace them: a line may drop a section or reword one (keep
   * its title), not add, replace or reorder one: each title returned must be one it was given, in
   * the same order, or the line has failed. Each line gets the list as the lines before it left it;
   * undefined keeps it.
   */
  reviewBriefing?: (session: SessionContext, sections: readonly Briefing[]) => Promise<Briefing[] | undefined>;
  /**
   * After each session, before its attempt is recorded: what it returns goes into
   * `attempt.finished` (a later line's fields win). Not called for a session the harness failed.
   */
  afterAttempt?: (problem: ProblemContext, attempt: FinishedAttempt) => Promise<AttemptAnnotation | undefined>;
  /**
   * After a prover has ended, whatever the reason: it starts no more session. Not called when the
   * harness failed in the prover, which ends the problem.
   */
  afterProver?: (problem: ProblemContext, end: ProverEnd) => Promise<void>;
  /**
   * After the provers, before `problem.finished`, for every problem whose `beforeProvers` point
   * was reached. Its signal is the run's, not the problem's, which is aborted when it is solved.
   */
  afterProblem?: (problem: ProblemContext, end: ProblemEnd) => Promise<void>;
}

/** What every hook of a problem gets. */
export interface ProblemContext {
  /** The line the context is for. */
  line: LineId;
  runId: string;
  problemId: string;
  /** The problem's claim. */
  claimId: string;
  target: Target;
  /** The problem's domains, such as `msc:11`. */
  domain: readonly string[];
  /** The run's memory, writing as `line:<id>`. */
  memory: MemoryStore;
  /**
   * The run's capability registry. Calls go through it, so they are tool runs in the journal; pass
   * `actor: "line:<id>"` (and the attempt, inside a session).
   */
  registry: Registry;
  /** One-shot model calls, charged to the problem's budget. */
  llm: Llm;
  /**
   * Submits a Lean proof of a claim, or of its negation, through the validator. The only way a
   * line raises a claim's status. The one other change of status a line makes is to lower one:
   * `memory.retractClaim(claimId, {reason})` takes back a claim whose status rested on something
   * withdrawn (`computed` back to `open`, a settled claim to `retracted`) and cannot raise any. The
   * line M2's revocation of a claim it composed is its only caller.
   */
  validate: (request: ValidateRequest) => Promise<ValidateResult>;
  budget: Budget;
  /**
   * The problem's task ledger (documentation/ledger.md): its tasks, read-only, and a way to
   * propose more. The orchestrator alone writes the ledger.
   */
  tasks: TaskApi;
  /** A line of the run's progress log. */
  log: (text: string) => void;
  /** Aborted when the problem ends: solved, out of budget, or the run stopped. */
  signal: AbortSignal;
  /** The line's options: its defaults with the run's values over them. */
  options: Readonly<JsonObject>;
}

/** The problem's theorem. */
export interface Target {
  /** Its full name in the file. */
  theorem: string;
  /** Its statement in signature form: the binders, then `:` and the type. */
  statement: string;
  /** The problem's file, in plain-header form. */
  source: string;
  /** The file cut around the theorem (documentation/validator.md). */
  sketch: Sketch;
}

/** The context of the hooks of one session of one prover. */
export interface SessionContext extends ProblemContext {
  /** The prover: `p1`, `p2`... */
  prover: string;
  /** The session's number for this prover, from 1, and the most it may have. */
  session: number;
  sessions: number;
  /** The session's attempt. `beforeSession` runs before it is recorded; a skipped session has none. */
  attemptId: string;
  /** `provider/id` of the session's model. */
  model: string;
  /** The prover's regions as the session starts. */
  regions: Submission;
  /** The strategy and subgoal `beforeSession` declared, recorded on `attempt.started`. */
  strategy?: string;
  subgoal?: string;
}

export interface Briefing {
  title: string;
  text: string;
}

/** A model request of a session, for `contextPacket`. */
export interface PacketRequest {
  /** The request's number in the session, from 1. */
  request: number;
  /** The session so far: the opening message, the model's messages and the tools' results. */
  transcript: readonly TranscriptEntry[];
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  /** The text of the message, without the model's thinking. */
  text: string;
  /** The tool calls of an assistant message. */
  toolCalls?: Array<{ name: string; arguments: JsonObject }>;
  /** The tool of a tool result. */
  tool?: string;
  isError?: boolean;
}

/** A tool a line gives provers, as a neutral spec that the orchestrator adapts to its agents. */
export interface LineTool {
  /** What the model calls it: lowercase letters, digits and `_`, not taken by another tool. */
  name: string;
  description: string;
  /** JSON Schema of the arguments: an object schema. */
  parameters: JsonObject;
  /** Runs a call; the text goes back to the model. An error goes back as a tool error. */
  run: (args: JsonObject, signal: AbortSignal) => Promise<string>;
}

export interface SessionDecision {
  /** `provider/id`: the model of this session. */
  model?: string;
  /** Declared for the session, recorded on `attempt.started`. */
  strategy?: string;
  subgoal?: string;
  /** Skip this session, for this reason: the prover goes on with its next one. */
  skip?: string;
  /** Stop the prover, for this reason: it starts no more session. */
  stop?: string;
}

/** A `lean_check` of a session. */
export interface SessionCheck {
  /** The check's number in the session, from 1. */
  index: number;
  submission: Submission;
  /** The strategy the model declared in this call, when the run offers labels and it gave one. */
  strategy?: string;
  report: ValidationReport;
  /** Set when the check was recorded as a validation (a file without holes). */
  validationId?: string;
  /** True when this check made the claim a candidate. */
  accepted: boolean;
}

/** What the model sent in a `lean_check` call, before it runs. */
export interface Proposal {
  aux: string;
  proof: string;
  /** The strategy the model declared in this call, when the run offers labels and it gave one. */
  strategy?: string;
}

export interface CheckVeto {
  /** Why the call is not run, in words the model can act on. It is sent back to the model. */
  reject: string;
}

export interface CheckDecision {
  /** End the session, for this reason. Its attempt ends `stoppedBy: "line:<id>"`. */
  stop?: string;
}

/** A session that has ended, for `afterAttempt`. */
export interface FinishedAttempt {
  attemptId: string;
  prover: string;
  session: number;
  model: string;
  outcome: AttemptOutcome;
  stoppedBy: string;
  /** The kind of failure of the last check, for an `invalid` attempt. */
  failureClass?: string;
  /** The regions of the session's last check, and what it said. */
  submission?: Submission;
  report?: ValidationReport;
  /** `lean_check` calls in the session. */
  checks: number;
  turns: number;
  cost: TokenCost;
  durationMs: number;
  /** The model's final message, when it wrote one. */
  notes?: string;
  /** The strategy and subgoal a line declared for the session in `beforeSession`. */
  strategy?: string;
  subgoal?: string;
  /** The strategy the model declared in its last `lean_check` that gave one. */
  declaredStrategy?: string;
}

/** What `afterAttempt` adds to `attempt.finished`. */
export interface AttemptAnnotation {
  /** The strategy classified from what the attempt submitted. */
  strategy?: string;
  /** The names the final proof uses. */
  premises?: string[];
  /** A short typed summary of the failure, such as `unsolved goals at case succ`. */
  failureDetail?: string;
  /**
   * The notes the prover's next session starts from, in place of the ones the model wrote (which
   * the journal keeps as it got them). An empty string leaves the next session with no notes.
   */
  notes?: string;
}

/** Why a prover ended (the values of the orchestrator's `ProverStop`). */
export type ProverStopReason = "solved" | "sessions" | "budget" | "aborted" | "errors" | "line";

/** A prover that has ended, for `afterProver`. */
export interface ProverEnd {
  /** `p1`, `p2`... */
  prover: string;
  stop: ProverStopReason;
  /** The sessions it started. */
  attempts: number;
}

/** How a problem ended, for `afterProblem`. */
export interface ProblemEnd {
  outcome: ProblemOutcome;
  reason?: string;
  attempts: number;
  usd: number;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** `provider/id`. Default: the run's model. */
  model?: string;
  /**
   * Where in the harness the call is made, in dotted lowercase words such as `graph.attempt`,
   * `abduction.rerank` or `conjecture.relevance`. It is recorded on the call's `model_call.finished`,
   * and the report adds up the spend by site (documentation/ledger.md, "Sites"). Give every call one:
   * a call without is recorded as `<line>.unlabeled`.
   */
  site?: string;
}

/** A call whose answer must be JSON of a given shape. */
export interface JsonRequest extends LlmRequest {
  /**
   * The shape of the answer, in the subset of JSON Schema that manifests use (`JsonSchema` of
   * `@seshat/registry`). The schema is added to the prompt: describe the content, not the format.
   */
  schema: JsonSchema;
}

export interface JsonResult<T = Json> {
  /** The answer, checked against the schema. The type is the caller's claim: the schema is what was checked. */
  value: T;
  /** The text the model wrote. */
  text: string;
  /** The cost of every call made: both, after a retry. */
  cost: TokenCost;
  /** `provider/id` of the model that answered. */
  model: string;
  /** The `model_call.finished` event of the call whose answer was taken. */
  modelCallId: string;
  /** The events of every call made, in order: one, or two after a retry. */
  modelCallIds: readonly string[];
}

export interface LlmResult {
  text: string;
  cost: TokenCost;
  /** `provider/id` of the model that answered. */
  model: string;
  /** The `model_call.finished` event of the call. */
  modelCallId: string;
}

/**
 * One-shot model calls, without tools. Each call is charged to the problem's budget and recorded
 * as a `model_call.finished` event, with its site and its request and response as blobs. A call
 * fails (rejects) when the budget is exhausted, the problem ends, or the model answers with an error.
 */
export interface Llm {
  complete: (request: LlmRequest) => Promise<LlmResult>;
  /**
   * A call whose answer is JSON that matches `request.schema`. An answer that is not JSON, or does
   * not match, is sent back to the model once with what was wrong; a second failure rejects with a
   * `JsonAnswerError` that says what was wrong with each answer. Both calls are charged and
   * recorded like any call, with the same site. Build one from a `complete` with `withJson`.
   */
  completeJson: <T = Json>(request: JsonRequest) => Promise<JsonResult<T>>;
}

export interface ValidateRequest {
  claimId: string;
  /** True to submit a proof of the claim's negation: a refutation. */
  negation?: boolean;
  /** The tactic proof, without `by`. */
  proof: string;
  /** Auxiliary declarations before the theorem, each named `aux_...`. */
  aux?: string;
  /** The attempt the proof comes from, if any. */
  attemptId?: string;
}

export interface ValidateResult {
  verdict: "valid" | "invalid";
  /** The `validation.finished` event, when the check was recorded. */
  validationId?: string;
  /**
   * The claim's status after the check. A check raises it to `computed` at most: the orchestrator
   * certifies what lines submit when the problem ends, and only then can the claim be `proved`
   * (or `refuted`).
   */
  status: ClaimStatus;
  reasons: string[];
  /** What the validator said; absent when the claim's reference file could not be checked. */
  report?: ValidationReport;
}

/** The problem's budget, as it stands. */
export interface Budget {
  /** Dollars the problem may spend. */
  readonly limitUsd: number | undefined;
  /** Spent so far, by the sessions and the lines' model calls. */
  readonly usd: number;
  readonly exhausted: boolean;
}

/** A task of the ledger as a line sees it (documentation/ledger.md). */
export interface TaskInfo {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  /** Why it has its status: the reason of its last move. */
  reason?: string;
  /** Who works on it, once someone does. */
  owner?: string;
  claimId?: string;
  edgeId?: string;
  dependsOn: readonly string[];
  /** What must hold for the task to be `done`, in terms of claim and edge statuses. */
  acceptance: TaskAcceptance;
  budget: TaskBudget;
  parentTaskId?: string;
  /** The line that proposed it; absent for a task the orchestrator made. */
  proposedBy?: string;
  title?: string;
  /** While `blocked`: what it waits for. */
  blockedBy?: readonly string[];
}

/** A routing decision about a task (documentation/ledger.md, "Routing"). */
export interface RoutingInfo {
  taskId: string;
  action: RouteAction;
  signal: { type: RouteSignalType; value: string };
  reason: string;
  attemptId?: string;
  nodeId?: string;
}

/**
 * A task a line asks for. The orchestrator commits it, or refuses it with a reason: it makes the
 * task for the problem the line is working on, with the line as its proposer and, unless the
 * ledger says otherwise, its owner. A line does not choose a task's status or its owner.
 */
export interface TaskProposal {
  kind: TaskKind;
  /** Default: the problem's claim, for the kinds that are about a claim. */
  claimId?: string;
  edgeId?: string;
  /** Tasks of the problem that must be done first. */
  dependsOn?: readonly string[];
  acceptance: TaskAcceptance;
  budget?: TaskBudget;
  /** The task this one continues or replaces, for example the one a routing decision was about. */
  parentTaskId?: string;
  title?: string;
}

export type TaskProposalResult = { accepted: true; taskId: string } | { accepted: false; reason: string };

/** Which tasks `TaskApi.list` returns; every given criterion must hold. */
export interface TaskQuery {
  statuses?: readonly TaskStatus[];
  kinds?: readonly TaskKind[];
  claimId?: string;
  owner?: string;
}

/**
 * The ledger as a line sees it: the problem's tasks, read-only, and a way to propose more. The
 * orchestrator alone writes the ledger; a line that wants work done asks, and reads the answer.
 */
export interface TaskApi {
  /** The problem's tasks, in the order they were made. */
  list: (query?: TaskQuery) => TaskInfo[];
  get: (taskId: string) => TaskInfo | undefined;
  /** The problem's tasks that may start now: `ready`, owned or not. */
  ready: () => TaskInfo[];
  /** The routing decisions about one task, or about every task of the problem. */
  routings: (taskId?: string) => RoutingInfo[];
  /** Proposes a task. Nothing is written when the orchestrator refuses it. */
  propose: (proposal: TaskProposal) => TaskProposalResult;
}
