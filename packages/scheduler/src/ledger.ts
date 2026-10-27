import {
  acceptanceHolds,
  EXTERNAL_BLOCKER,
  isFinalTaskStatus,
  type Journal,
  newId,
  type RouteAction,
  type RouteSignalType,
  TASK_WRITER,
  type TaskAcceptance,
  type TaskBudget,
  type TaskFilter,
  type TaskKind,
  type TaskRow,
} from "@seshat/core";
import type { RoutingInfo, TaskInfo, TaskProposal, TaskProposalResult } from "@seshat/lines";

/** A task to make. */
export interface NewTask {
  kind: TaskKind;
  problemId?: string;
  claimId?: string;
  edgeId?: string;
  dependsOn?: readonly string[];
  owner?: string;
  acceptance: TaskAcceptance;
  budget?: TaskBudget;
  parentTaskId?: string;
  proposedBy?: string;
  title?: string;
}

/** A routing decision to record. */
export interface Routing {
  taskId: string;
  action: RouteAction;
  signal: { type: RouteSignalType; value: string };
  reason: string;
  attemptId?: string;
  nodeId?: string;
}

export interface TaskLedgerOptions {
  /** The most tasks that lines may have proposed for one problem: a line that proposes without end is refused. Default 200. */
  maxProposed?: number;
}

/** The problem a line's proposal is for. */
export interface ProposalContext {
  problemId: string;
  /** The problem's claim, the default subject of a proposal. */
  claimId: string;
  /** The proposing line's id. */
  line: string;
}

/**
 * The orchestrator's handle on the task ledger (documentation/ledger.md). It is the only writer of
 * task events: every move goes through the journal's rules, which refuse an illegal one, so these
 * methods throw when the move is not allowed and write nothing. Lines never get one; they read the
 * ledger and propose tasks through `TaskApi`, and the orchestrator commits what it accepts here
 * (`propose`).
 */
export class TaskLedger {
  private readonly journal: Journal;
  private readonly maxProposed: number;

  constructor(journal: Journal, options: TaskLedgerOptions = {}) {
    this.journal = journal;
    this.maxProposed = options.maxProposed ?? 200;
  }

  get(taskId: string): TaskRow | undefined {
    return this.journal.projection.task(taskId);
  }

  /** The tasks that meet every criterion of the filter, in the order they were made. */
  list(filter: TaskFilter = {}): TaskRow[] {
    return this.journal.projection.tasks(filter);
  }

  /** Makes a task, `pending`. Returns its id. */
  create(task: NewTask): string {
    const taskId = newId("tsk");
    this.journal.emit(
      "task.created",
      {
        taskId,
        kind: task.kind,
        dependsOn: [...(task.dependsOn ?? [])],
        acceptance: task.acceptance,
        budget: task.budget ?? {},
        ...(task.problemId !== undefined ? { problemId: task.problemId } : {}),
        ...(task.claimId !== undefined ? { claimId: task.claimId } : {}),
        ...(task.edgeId !== undefined ? { edgeId: task.edgeId } : {}),
        ...(task.owner !== undefined ? { owner: task.owner } : {}),
        ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
        ...(task.proposedBy !== undefined ? { proposedBy: task.proposedBy } : {}),
        ...(task.title !== undefined ? { title: task.title } : {}),
      },
      TASK_WRITER,
    );
    return taskId;
  }

  assign(taskId: string, owner: string, reason: string): void {
    this.journal.emit("task.assigned", { taskId, owner, reason }, TASK_WRITER);
  }

  /** `pending` or `blocked` to `ready`. */
  markReady(taskId: string, reason: string): void {
    this.move(taskId, "ready", reason);
  }

  /** `ready` to `running`. The task needs an owner. */
  start(taskId: string, reason: string): void {
    this.move(taskId, "running", reason);
  }

  /** `running` to `done`. The journal refuses it while the task's criterion does not hold. */
  complete(taskId: string, reason: string): void {
    this.move(taskId, "done", reason);
  }

  /** Whether the task's criterion holds now. */
  holds(taskId: string): boolean {
    const p = this.journal.projection;
    const task = this.require(taskId);
    return acceptanceHolds(task.acceptance, { claimStatus: (id) => p.claim(id)?.status, edgeStatus: (id) => p.edge(id)?.status });
  }

  /** Completes the task if it is running and its criterion holds. Returns whether it did. */
  completeIfHolds(taskId: string, reason: string): boolean {
    if (this.require(taskId).status !== "running" || !this.holds(taskId)) return false;
    this.complete(taskId, reason);
    return true;
  }

  /** `running` or `blocked` to `failed`. */
  fail(taskId: string, reason: string): void {
    this.move(taskId, "failed", reason);
  }

  /** Any task that has not ended to `cancelled`. */
  cancel(taskId: string, reason: string): void {
    this.move(taskId, "cancelled", reason);
  }

  /** To `blocked`, by the tasks or `ext:<name>` keys named. */
  block(taskId: string, blockedBy: readonly string[], reason: string): void {
    this.move(taskId, "blocked", reason, [...blockedBy]);
  }

  private move(taskId: string, to: TaskRow["status"], reason: string, blockedBy?: string[]): void {
    const task = this.require(taskId);
    this.journal.emit(
      "task.status_changed",
      { taskId, from: task.status, to, reason, ...(blockedBy !== undefined ? { blockedBy } : {}) },
      TASK_WRITER,
    );
  }

  /**
   * Moves to `ready` the tasks of a problem (or of the run) whose dependencies are `done`: the
   * `pending` ones, and the `blocked` ones whose blockers are all tasks that are `done`. A task that
   * waits for an `ext:` key is released by `markReady`, by whoever knows the wait is over. Returns
   * the ids moved, in the order the tasks were made.
   */
  promote(problemId?: string): string[] {
    const p = this.journal.projection;
    const moved: string[] = [];
    for (const task of p.tasks({ ...(problemId !== undefined ? { problemId } : {}), statuses: ["pending", "blocked"] })) {
      const waitsFor = [...task.depends_on, ...(task.blocked_by ?? [])];
      if (waitsFor.some((id) => EXTERNAL_BLOCKER.test(id) || p.task(id)?.status !== "done")) continue;
      this.markReady(task.task_id, task.status === "blocked" ? "its blockers are done" : "its dependencies are done");
      moved.push(task.task_id);
    }
    return moved;
  }

  /**
   * After `run.resumed`: the tasks that were `running` when the process ended go back to `ready`,
   * to be started again with what is left of their budget. Returns their ids.
   */
  interrupt(reason: string, problemId?: string): string[] {
    const moved: string[] = [];
    for (const task of this.journal.projection.tasks({ ...(problemId !== undefined ? { problemId } : {}), statuses: ["running"] })) {
      this.move(task.task_id, "ready", reason);
      moved.push(task.task_id);
    }
    return moved;
  }

  /** Cancels every task of a problem that has not ended, for this reason. Returns their ids. */
  closeProblem(problemId: string, reason: string): string[] {
    const closed: string[] = [];
    for (const task of this.journal.projection.tasks({ problemId })) {
      if (isFinalTaskStatus(task.status)) continue;
      this.cancel(task.task_id, reason);
      closed.push(task.task_id);
    }
    return closed;
  }

  /** Records a routing decision. It changes no status. */
  route(decision: Routing): void {
    this.journal.emit(
      "task.routed",
      {
        taskId: decision.taskId,
        action: decision.action,
        signal: decision.signal,
        reason: decision.reason,
        ...(decision.attemptId !== undefined ? { attemptId: decision.attemptId } : {}),
        ...(decision.nodeId !== undefined ? { nodeId: decision.nodeId } : {}),
      },
      TASK_WRITER,
    );
  }

  /**
   * Commits a task that a line proposed for a problem, or refuses it with a reason, writing
   * nothing. The task is the problem's, proposed by the line, `pending`, and owned by the line
   * unless the orchestrator assigns it elsewhere; its dependencies and parent must be tasks of the
   * same problem; a line may have only so many proposed tasks per problem. Anything else the
   * journal refuses (a claim that does not exist, a criterion of the wrong shape) comes back as the
   * reason.
   */
  propose(context: ProposalContext, proposal: TaskProposal): TaskProposalResult {
    const p = this.journal.projection;
    const proposer = `line:${context.line}`;
    const proposed = p.tasks({ problemId: context.problemId }).filter((task) => task.proposed_by !== null).length;
    if (proposed >= this.maxProposed) {
      return { accepted: false, reason: `the problem already has ${proposed} proposed tasks, the most the orchestrator takes` };
    }
    for (const id of [...(proposal.dependsOn ?? []), ...(proposal.parentTaskId !== undefined ? [proposal.parentTaskId] : [])]) {
      if (p.task(id)?.problem_id !== context.problemId) return { accepted: false, reason: `${id} is not a task of this problem` };
    }
    // A proposal that names no claim and no edge is about the problem's claim.
    const claimId = proposal.claimId ?? (proposal.edgeId === undefined ? context.claimId : undefined);
    try {
      const taskId = this.create({
        kind: proposal.kind,
        problemId: context.problemId,
        ...(claimId !== undefined ? { claimId } : {}),
        ...(proposal.edgeId !== undefined ? { edgeId: proposal.edgeId } : {}),
        ...(proposal.dependsOn !== undefined ? { dependsOn: proposal.dependsOn } : {}),
        owner: proposer,
        acceptance: proposal.acceptance,
        ...(proposal.budget !== undefined ? { budget: proposal.budget } : {}),
        ...(proposal.parentTaskId !== undefined ? { parentTaskId: proposal.parentTaskId } : {}),
        proposedBy: proposer,
        ...(proposal.title !== undefined ? { title: proposal.title } : {}),
      });
      return { accepted: true, taskId };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private require(taskId: string): TaskRow {
    const task = this.journal.projection.task(taskId);
    if (task === undefined) throw new Error(`unknown task ${taskId}`);
    return task;
  }
}

/** A task as a line sees it. */
export function taskInfo(row: TaskRow): TaskInfo {
  return {
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    dependsOn: row.depends_on,
    acceptance: row.acceptance,
    budget: row.budget,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.owner !== null ? { owner: row.owner } : {}),
    ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
    ...(row.edge_id !== null ? { edgeId: row.edge_id } : {}),
    ...(row.parent_task_id !== null ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.proposed_by !== null ? { proposedBy: row.proposed_by } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.blocked_by !== null ? { blockedBy: row.blocked_by } : {}),
  };
}

/** A routing decision as a line sees it. */
export function routingInfo(row: {
  task_id: string;
  action: RouteAction;
  signal_type: RouteSignalType;
  signal_value: string;
  reason: string;
  attempt_id: string | null;
  node_id: string | null;
}): RoutingInfo {
  return {
    taskId: row.task_id,
    action: row.action,
    signal: { type: row.signal_type, value: row.signal_value },
    reason: row.reason,
    ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
    ...(row.node_id !== null ? { nodeId: row.node_id } : {}),
  };
}
