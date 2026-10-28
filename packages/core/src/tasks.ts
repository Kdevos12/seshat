import { type ClaimStatus, type EdgeStatus, edgeStatusRank, isEdgeStatus } from "./status.ts";

/**
 * The vocabulary of the task ledger (documentation/ledger.md). The ledger is a record of work, not of
 * mathematics: a task points at claims and edges and states what it must achieve in terms of their
 * statuses, and never holds a status of its own about them. The claim statuses and the task
 * statuses share no word, so that no reader takes one for the other.
 */

/** The only actor that appends task events: lines propose tasks through their context, the orchestrator commits them. */
export const TASK_WRITER = "orchestrator";

/** What a task is for. */
export const TASK_KINDS = ["prove", "refute", "formalize", "battery", "search", "compute", "abduce", "induce", "repair", "review"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

/**
 * Where a task is: `pending` (made, not yet cleared to start), `ready` (its dependencies are done
 * and it has an owner), `running`, then one end: `done` (its acceptance criterion holds), `failed`,
 * `cancelled`; `blocked` waits for something named.
 */
export const TASK_STATUSES = ["pending", "ready", "running", "done", "failed", "blocked", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * The deterministic transitions. `running` to `ready` is the one way back, and the journal allows it
 * only after the run was resumed (`run.resumed`) since the task started: it is how a task that a
 * crash interrupted returns to work. `done`, `failed` and `cancelled` are final: more work on the
 * same goal is a new task, with the old one as its parent.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["done", "failed", "blocked", "cancelled", "ready"],
  blocked: ["ready", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTaskTransition(from, to)) throw new Error(`illegal task status transition ${from} -> ${to}`);
}

/** A task in one of these has ended. */
export function isFinalTaskStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

/** What a task may spend; a missing limit is no limit. */
export interface TaskBudget {
  usd?: number;
  /** Sessions of a prover. */
  sessions?: number;
}

/** The claim statuses a criterion can ask for. */
export const ACCEPTANCE_CLAIM_STATUSES = ["computed", "proved_informal", "proved", "refuted"] as const;
export type AcceptanceClaimStatus = (typeof ACCEPTANCE_CLAIM_STATUSES)[number];

/**
 * What must hold for a task to be `done`, stated on a claim or an edge and read from the
 * projection: `{type: "claim", claimId, minStatus: "computed"}` holds when the claim is a candidate
 * or better; `{type: "edge", edgeId, minStatus: "lean_checked"}` when Lean checked the edge.
 */
export type TaskAcceptance =
  | { type: "claim"; claimId: string; minStatus: AcceptanceClaimStatus }
  | { type: "edge"; edgeId: string; minStatus: EdgeStatus };

/** The claim statuses that meet each minimum: a certified proof also is a candidate, and settles an informal claim. */
const CLAIM_MEETS: Record<AcceptanceClaimStatus, readonly ClaimStatus[]> = {
  computed: ["computed", "proved"],
  proved_informal: ["proved_informal", "proved"],
  proved: ["proved"],
  refuted: ["refuted"],
};

/** Whether a claim in `status` meets a criterion that asks for at least `min`. */
export function claimMeets(status: ClaimStatus, min: AcceptanceClaimStatus): boolean {
  return CLAIM_MEETS[min].includes(status);
}

/** Whether an edge in `status` meets a criterion that asks for at least `min` (the order of `edgeStatusRank`). */
export function edgeMeets(status: EdgeStatus, min: EdgeStatus): boolean {
  return edgeStatusRank(status) >= edgeStatusRank(min);
}

/** What `acceptanceHolds` reads. */
export interface AcceptanceView {
  claimStatus: (claimId: string) => ClaimStatus | undefined;
  edgeStatus: (edgeId: string) => EdgeStatus | undefined;
}

/** Whether the criterion holds now. A claim or an edge that does not exist meets nothing. */
export function acceptanceHolds(acceptance: TaskAcceptance, view: AcceptanceView): boolean {
  if (acceptance.type === "claim") {
    const status = view.claimStatus(acceptance.claimId);
    return status !== undefined && claimMeets(status, acceptance.minStatus);
  }
  const status = view.edgeStatus(acceptance.edgeId);
  return status !== undefined && edgeMeets(status, acceptance.minStatus);
}

/** The criterion in words, for messages and the report. */
export function describeAcceptance(acceptance: TaskAcceptance): string {
  return acceptance.type === "claim"
    ? `claim ${acceptance.claimId} is at least ${acceptance.minStatus}`
    : `edge ${acceptance.edgeId} is at least ${acceptance.minStatus}`;
}

/** The problems with a criterion's shape, or none. Whether its claim or edge exists is for the journal. */
export function acceptanceProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the acceptance criterion must be an object"];
  const a = value as Record<string, unknown>;
  if (a.type === "claim") {
    const problems: string[] = [];
    if (typeof a.claimId !== "string" || a.claimId === "") problems.push("a claim criterion needs a claimId");
    if (!(ACCEPTANCE_CLAIM_STATUSES as readonly unknown[]).includes(a.minStatus)) {
      problems.push(`a claim criterion asks for one of ${ACCEPTANCE_CLAIM_STATUSES.join(", ")}, not ${String(a.minStatus)}`);
    }
    return problems;
  }
  if (a.type === "edge") {
    const problems: string[] = [];
    if (typeof a.edgeId !== "string" || a.edgeId === "") problems.push("an edge criterion needs an edgeId");
    if (!isEdgeStatus(a.minStatus)) problems.push(`an edge criterion asks for an edge status, not ${String(a.minStatus)}`);
    return problems;
  }
  return [`the acceptance criterion has type claim or edge, not ${String(a.type)}`];
}

/** The problems with a budget, or none. */
export function budgetProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the budget must be an object"];
  const problems: string[] = [];
  for (const [key, limit] of Object.entries(value)) {
    if (key !== "usd" && key !== "sessions") problems.push(`the budget has no limit named ${key}`);
    else if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) problems.push(`budget.${key} must be a non-negative number`);
  }
  return problems;
}

/** Of a blocked task: what it waits for is another task's id, or an outside thing, `ext:<name>` (a person, a resource). */
export const EXTERNAL_BLOCKER = /^ext:[a-z][a-z0-9_.-]{0,63}$/;

/**
 * What a routing decision does with a failed task (documentation/ledger.md, "Routing"): try again
 * in a fresh session, try again with the strongest model configured (when every failure so far
 * comes from a weaker configuration), go back to the planning above the task, or open an
 * alternative under other constraints.
 */
export const ROUTE_ACTIONS = ["retry_fresh", "retry_stronger", "reset_upstream", "branch"] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export function isRouteAction(value: unknown): value is RouteAction {
  return typeof value === "string" && (ROUTE_ACTIONS as readonly string[]).includes(value);
}

/** What a routing decision answers: a failure class of the checks, a kind of drift, or a refuted subgoal. */
export const ROUTE_SIGNAL_TYPES = ["failure_class", "drift_kind", "subgoal_refuted"] as const;
export type RouteSignalType = (typeof ROUTE_SIGNAL_TYPES)[number];

export function isRouteSignalType(value: unknown): value is RouteSignalType {
  return typeof value === "string" && (ROUTE_SIGNAL_TYPES as readonly string[]).includes(value);
}
