import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chainOfJournal, type MemoryChain } from "./chain.ts";
import type { EventBody, EventDataMap, EventType, HarnessEvent } from "./events.ts";
import { statementIdV0 } from "./ids.ts";
import { EventLog, readEvents } from "./log.ts";
import { Projection, StaleProjectionError } from "./projection.ts";
import { EPOCH_FIELDS, provenanceProblems } from "./provenance.ts";
import { type EdgeLink, isEdgeKind, LINK_KINDS, NODE_KIND, SITE } from "./records.ts";
import { assertTransition, isEdgeStatus } from "./status.ts";
import {
  acceptanceHolds,
  acceptanceProblems,
  assertTaskTransition,
  budgetProblems,
  describeAcceptance,
  EXTERNAL_BLOCKER,
  isRouteAction,
  isRouteSignalType,
  isTaskKind,
  isTaskStatus,
  TASK_WRITER,
} from "./tasks.ts";

/** The node kinds only a person writes: the hints and steers of the research team. */
export const HUMAN_NODE_KINDS: readonly string[] = ["hint", "steer"];

/**
 * The single writer of a run: every fact goes through `emit`, which checks the invariants against
 * the projection, appends to the journal, then updates the projection.
 */
export class Journal {
  readonly log: EventLog;
  readonly projection: Projection;
  /** The earlier journals this run starts on (its `run.started`'s `memoryFrom`), if any. */
  readonly chain: MemoryChain | undefined;
  private readonly unsubscribe: () => void;

  /**
   * Catches the projection up with the journal. Throws `StaleProjectionError` if it cannot, or if it was
   * built on another chain of earlier journals than `chain`.
   */
  constructor(log: EventLog, projection: Projection, chain?: MemoryChain) {
    this.log = log;
    this.projection = projection;
    this.chain = chain;
    if (projection.chainHash() !== chain?.hash) {
      // A projection with no events of its own and no chain takes the chain; any other is of another history.
      if (chain === undefined || projection.chainHash() !== undefined || projection.lastSeq() >= 0) {
        throw new StaleProjectionError("the projection was built on another chain of earlier journals");
      }
      projection.attachChain(chain);
    }
    const seq = projection.lastSeq();
    if (seq > log.length - 1) {
      throw new StaleProjectionError(`projection is at seq ${seq}, journal ends at ${log.length - 1}`);
    }
    if (seq >= 0 || log.length > 0) {
      const events = readEvents(log.path);
      if (seq >= 0 && events[seq]?.hash !== projection.lastHash()) {
        throw new StaleProjectionError(`projection does not match the journal at seq ${seq}`);
      }
      for (const event of events.slice(seq + 1)) projection.apply(event);
    }
    this.unsubscribe = log.onAppend((event) => projection.apply(event));
  }

  /**
   * Opens `<dir>/journal.jsonl` and its projection `<dir>/projection.sqlite`. A projection that
   * lags is caught up; one that does not match is deleted and rebuilt from the journal.
   *
   * `memory` is the chain of earlier journals a new run starts on (`loadMemoryChain`). A journal that
   * already has events reads its own chain from its `run.started`, checked against what it pinned
   * (`MemoryChainError` when an earlier journal is gone or changed).
   */
  static open(dir: string, run: string, options: { durable?: boolean; deferRepair?: boolean; memory?: MemoryChain } = {}): Journal {
    const { memory, ...logOptions } = options;
    const file = join(dir, "journal.jsonl");
    const chain = memory ?? chainOfJournal(file);
    mkdirSync(dir, { recursive: true });
    const log = EventLog.open(file, { run, ...logOptions });
    const path = join(dir, "projection.sqlite");
    try {
      try {
        return Journal.attach(log, path, chain);
      } catch (error) {
        if (!(error instanceof StaleProjectionError)) throw error;
      }
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      return Journal.attach(log, path, chain);
    } catch (error) {
      log.close();
      throw error;
    }
  }

  private static attach(log: EventLog, path: string, chain: MemoryChain | undefined): Journal {
    const projection = Projection.open(path);
    try {
      return new Journal(log, projection, chain);
    } catch (error) {
      projection.close();
      throw error;
    }
  }

  emit<K extends EventType>(type: K, data: EventDataMap[K], actor: string): Extract<HarnessEvent, { type: K }> {
    this.check({ type, data } as EventBody, actor);
    return this.log.append(type, data, actor);
  }

  private check(event: EventBody, actor: string): void {
    const p = this.projection;
    // A validation of an earlier run in another Lean environment counts for nothing: nothing cites it.
    if (event.type === "claim.status_changed" || event.type === "edge.added" || event.type === "edge.status_changed") {
      const id = event.data.validationId;
      if (id !== undefined && p.earlierValidation(id)) {
        throw new Error(
          `validation ${id} is from an earlier run in another Lean environment: it counts for nothing until its proof passes validate again in this run`,
        );
      }
    }
    switch (event.type) {
      case "claim.created": {
        const d = event.data;
        if (p.claim(d.claimId)) throw new Error(`claim ${d.claimId} already exists`);
        // Edges name claims and nodes by id alone, so the two share one space of ids.
        if (p.node(d.claimId)) throw new Error(`${d.claimId} is already a node`);
        // A claim starts open and reaches every other status through the checked status changes below.
        if (d.status !== "open") throw new Error(`claim ${d.claimId} is created open, not ${String(d.status)}`);
        if (d.kind !== undefined && d.kind !== "formal" && d.kind !== "informal") {
          throw new Error(`claim ${d.claimId} has unknown kind ${String(d.kind)}`);
        }
        if (d.parentId !== undefined && !p.claim(d.parentId)) throw new Error(`unknown parent claim ${d.parentId}`);
        return;
      }
      case "claim.status_changed": {
        const claim = p.claim(event.data.claimId);
        if (!claim) throw new Error(`unknown claim ${event.data.claimId}`);
        if (claim.status !== event.data.from) {
          throw new Error(`claim ${event.data.claimId} is ${claim.status}, not ${event.data.from}`);
        }
        assertTransition(event.data.from, event.data.to);
        // Trust policy: a candidate (`computed`) needs a proof of the claim that passed the fast check.
        if (event.data.to === "computed") {
          const id = event.data.validationId;
          const validation = id === undefined ? undefined : p.validation(id);
          if (!validation || validation.verdict !== "valid") {
            throw new Error(`claim ${event.data.claimId} can become computed only with a valid validation of the claim`);
          }
          if (validation.claim_id !== event.data.claimId) {
            throw new Error(`validation ${id} validates claim ${validation.claim_id}, not ${event.data.claimId}`);
          }
          if (validation.negation) {
            throw new Error(`validation ${id} proves the negation of the claim, so claim ${event.data.claimId} cannot become computed`);
          }
        }
        // Trust policy: only a certified proof (kernel replay) settles a claim: a proof of the claim
        // makes it proved, a proof of its negation makes it refuted.
        if (event.data.to === "proved" || event.data.to === "refuted") {
          const id = event.data.validationId;
          const validation = id === undefined ? undefined : p.validation(id);
          if (!validation || validation.verdict !== "valid" || validation.method !== "kernel_replay") {
            throw new Error(`claim ${event.data.claimId} can become ${event.data.to} only with a certified validation`);
          }
          if (validation.claim_id !== event.data.claimId) {
            throw new Error(`validation ${id} certifies claim ${validation.claim_id}, not ${event.data.claimId}`);
          }
          if (validation.negation !== (event.data.to === "refuted")) {
            const proves = validation.negation ? "the negation of the claim" : "the claim";
            throw new Error(`validation ${id} certifies ${proves}, so claim ${event.data.claimId} cannot become ${event.data.to}`);
          }
        }
        return;
      }
      case "problem.registered":
        if (!p.claim(event.data.claimId)) throw new Error(`unknown claim ${event.data.claimId}`);
        if (p.problem(event.data.problemId)) throw new Error(`problem ${event.data.problemId} is already registered`);
        return;
      case "problem.finished": {
        const problem = p.problem(event.data.problemId);
        if (!problem) throw new Error(`unknown problem ${event.data.problemId}`);
        if (problem.finished_seq !== null) throw new Error(`problem ${event.data.problemId} already finished`);
        if (problem.claim_id !== event.data.claimId) {
          throw new Error(`problem ${event.data.problemId} is about claim ${problem.claim_id}, not ${event.data.claimId}`);
        }
        return;
      }
      case "validation.finished":
        if (!p.claim(event.data.claimId)) throw new Error(`unknown claim ${event.data.claimId}`);
        if (p.validation(event.data.validationId)) throw new Error(`validation ${event.data.validationId} already exists`);
        if (event.data.problemId !== undefined && !p.problem(event.data.problemId)) throw new Error(`unknown problem ${event.data.problemId}`);
        return;
      case "attempt.started": {
        const d = event.data;
        if (!p.claim(d.claimId)) throw new Error(`unknown claim ${d.claimId}`);
        if (p.attempt(d.attemptId)) throw new Error(`attempt ${d.attemptId} already exists`);
        if (d.site !== undefined && !SITE.test(d.site)) throw new Error(`attempt ${d.attemptId}: bad site ${JSON.stringify(d.site)}`);
        this.checkProvenance(`attempt ${d.attemptId}`, d.provenance);
        this.checkDraw(d.attemptId, d.included, d.withheld);
        if (d.taskId !== undefined) {
          // Work is done inside a running task, for the task's own claim.
          const task = p.task(d.taskId);
          if (!task) throw new Error(`unknown task ${d.taskId}`);
          if (task.status !== "running") throw new Error(`attempt ${d.attemptId} works for task ${d.taskId}, which is ${task.status}, not running`);
          if (task.claim_id !== null && task.claim_id !== d.claimId) {
            throw new Error(`attempt ${d.attemptId} is about claim ${d.claimId}, but task ${d.taskId} is about claim ${task.claim_id}`);
          }
        }
        return;
      }
      case "attempt.charged": {
        const d = event.data;
        const attempt = p.attempt(d.attemptId);
        if (!attempt) throw new Error(`unknown attempt ${d.attemptId}`);
        if (attempt.finished_seq !== null) throw new Error(`attempt ${d.attemptId} already finished`);
        for (const [name, value] of [["usd", d.usd], ["inputTokens", d.inputTokens], ["outputTokens", d.outputTokens]] as const) {
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`attempt ${d.attemptId}: ${name} must be a non-negative number`);
        }
        return;
      }
      case "attempt.finished": {
        const attempt = p.attempt(event.data.attemptId);
        if (!attempt) throw new Error(`unknown attempt ${event.data.attemptId}`);
        if (attempt.finished_seq !== null) throw new Error(`attempt ${event.data.attemptId} already finished`);
        return;
      }
      case "lesson.recorded":
        if (!p.attempt(event.data.attemptId)) throw new Error(`unknown attempt ${event.data.attemptId}`);
        this.checkProvenance(`a lesson of attempt ${event.data.attemptId}`, event.data.provenance);
        return;
      case "tool_run.started":
        if (p.toolRun(event.data.toolRunId)) throw new Error(`tool run ${event.data.toolRunId} already exists`);
        return;
      case "tool_run.finished": {
        const run = p.toolRun(event.data.toolRunId);
        if (!run) throw new Error(`unknown tool run ${event.data.toolRunId}`);
        if (run.finished_seq !== null) throw new Error(`tool run ${event.data.toolRunId} already finished`);
        return;
      }
      case "edge.added": {
        const d = event.data;
        if (p.edge(d.edgeId)) throw new Error(`edge ${d.edgeId} already exists`);
        if (!isEdgeKind(d.kind)) throw new Error(`edge ${d.edgeId} has unknown kind ${String(d.kind)}`);
        if (!isEdgeStatus(d.status)) throw new Error(`edge ${d.edgeId} has unknown status ${String(d.status)}`);
        if (d.to.length === 0) throw new Error(`edge ${d.edgeId} has no target`);
        if (d.kind !== "decomposes_into" && d.to.length !== 1) {
          throw new Error(`a ${d.kind} edge has one target, edge ${d.edgeId} has ${d.to.length}`);
        }
        if (new Set(d.to).size !== d.to.length) throw new Error(`edge ${d.edgeId} names a target twice`);
        if (d.to.includes(d.from)) throw new Error(`edge ${d.edgeId} goes from ${d.from} to itself`);
        for (const id of [d.from, ...d.to]) {
          if (!p.claim(id) && !p.node(id)) throw new Error(`edge ${d.edgeId}: unknown claim or node ${id}`);
        }
        if (d.link !== undefined && !LINK_KINDS.includes(d.kind)) {
          throw new Error(`edge ${d.edgeId}: no lemma checks a ${d.kind} edge, so it has no link`);
        }
        if (d.attemptId !== undefined && !p.attempt(d.attemptId)) throw new Error(`unknown attempt ${d.attemptId}`);
        if (d.toolRunId !== undefined && !p.toolRun(d.toolRunId)) throw new Error(`unknown tool run ${d.toolRunId}`);
        if (d.validationId !== undefined && !p.validation(d.validationId)) throw new Error(`unknown validation ${d.validationId}`);
        if (d.status === "lean_checked") this.checkLink(d.edgeId, d.link, d.validationId);
        return;
      }
      case "edge.status_changed": {
        const d = event.data;
        const edge = p.edge(d.edgeId);
        if (!edge) throw new Error(`unknown edge ${d.edgeId}`);
        if (edge.status !== d.from) throw new Error(`edge ${d.edgeId} is ${edge.status}, not ${d.from}`);
        if (!isEdgeStatus(d.to)) throw new Error(`edge ${d.edgeId}: unknown status ${String(d.to)}`);
        if (d.to === d.from) throw new Error(`edge ${d.edgeId} is already ${d.to}`);
        if (d.validationId !== undefined && !p.validation(d.validationId)) throw new Error(`unknown validation ${d.validationId}`);
        if (d.to === "lean_checked") {
          const link = edge.link_name === null || edge.link_statement === null ? undefined : { name: edge.link_name, statement: edge.link_statement };
          this.checkLink(d.edgeId, link, d.validationId);
        }
        return;
      }
      case "node.recorded": {
        const d = event.data;
        if (p.node(d.nodeId)) throw new Error(`node ${d.nodeId} already exists`);
        if (p.claim(d.nodeId)) throw new Error(`${d.nodeId} is already a claim`);
        if (!NODE_KIND.test(d.kind)) throw new Error(`node ${d.nodeId}: bad kind ${JSON.stringify(d.kind)}`);
        if (d.claimId !== undefined && !p.claim(d.claimId)) throw new Error(`unknown claim ${d.claimId}`);
        // The research team's answers are a person's: no line or model can write one in a person's name (documentation/human.md).
        if (HUMAN_NODE_KINDS.includes(d.kind) && !actor.startsWith("human:")) {
          throw new Error(`node ${d.nodeId}: a ${d.kind} is the research team's, written by human:NAME, not by ${actor}`);
        }
        this.checkProvenance(`node ${d.nodeId}`, d.provenance);
        return;
      }
      case "node.updated":
        if (!p.node(event.data.nodeId)) throw new Error(`unknown node ${event.data.nodeId}`);
        return;
      case "model_call.finished": {
        const d = event.data;
        if (p.modelCall(d.modelCallId)) throw new Error(`model call ${d.modelCallId} already exists`);
        if (d.problemId !== undefined && !p.problem(d.problemId)) throw new Error(`unknown problem ${d.problemId}`);
        if (d.attemptId !== undefined && !p.attempt(d.attemptId)) throw new Error(`unknown attempt ${d.attemptId}`);
        if (d.site !== undefined && !SITE.test(d.site)) throw new Error(`model call ${d.modelCallId}: bad site ${JSON.stringify(d.site)}`);
        return;
      }
      case "run.started":
      case "run.finished":
        return;
      case "run.resumed": {
        this.onlyOrchestrator(event.type, actor);
        const expected = p.resumptions().length + 1;
        if (event.data.resumption !== expected) throw new Error(`this is resumption ${expected} of the run, not ${event.data.resumption}`);
        return;
      }
      case "turn.started": {
        this.onlyOrchestrator(event.type, actor);
        const turns = p.turns();
        if (turns.started !== turns.ended) throw new Error(`turn ${turns.started} has not ended: a turn begins only when the one before has`);
        if (event.data.turn !== turns.started + 1) throw new Error(`this is turn ${turns.started + 1} of the run, not ${event.data.turn}`);
        for (const [name, value] of Object.entries(event.data.limit)) {
          if (typeof value !== "number" || !(value > 0)) throw new Error(`turn ${event.data.turn}: the limit ${name} must be a positive number`);
        }
        return;
      }
      case "turn.ended": {
        this.onlyOrchestrator(event.type, actor);
        const turns = p.turns();
        if (turns.started !== turns.ended + 1) throw new Error("no turn is open: a turn ends once, after it began");
        if (event.data.turn !== turns.started) throw new Error(`turn ${turns.started} is the one that is open, not ${event.data.turn}`);
        if (typeof event.data.reason !== "string" || event.data.reason === "") throw new Error(`turn ${event.data.turn}: a turn ends for a reason`);
        return;
      }
      case "memory.epoch_opened": {
        this.onlyOrchestrator(event.type, actor);
        const d = event.data;
        const expected = p.currentEpoch() + 1;
        if (d.epoch !== expected) throw new Error(`this is epoch ${expected} of the memory, not ${String(d.epoch)}`);
        if (typeof d.reason !== "string" || d.reason === "") throw new Error(`epoch ${d.epoch}: an epoch needs a reason`);
        if (!Array.isArray(d.changes) || d.changes.length === 0) throw new Error(`epoch ${d.epoch}: it opens because something changed, and changes says what`);
        for (const change of d.changes) {
          if (!EPOCH_FIELDS.includes(change?.field)) throw new Error(`epoch ${d.epoch}: ${JSON.stringify(change)} is not a change that opens an epoch (${EPOCH_FIELDS.join(", ")})`);
          if (typeof change.from !== "string" || typeof change.to !== "string" || change.from === change.to) {
            throw new Error(`epoch ${d.epoch}: the change of ${change.field} goes from one value to another`);
          }
        }
        this.checkProvenance(`epoch ${d.epoch}`, d.provenance, true);
        return;
      }
      case "task.created":
        this.onlyOrchestrator(event.type, actor);
        this.checkTaskCreated(event.data);
        return;
      case "task.assigned": {
        this.onlyOrchestrator(event.type, actor);
        const d = event.data;
        const task = p.task(d.taskId);
        if (!task) throw new Error(`unknown task ${d.taskId}`);
        if (task.status !== "pending" && task.status !== "ready" && task.status !== "blocked") {
          throw new Error(`task ${d.taskId} is ${task.status}: only a task that has not started can change owner`);
        }
        if (typeof d.owner !== "string" || d.owner === "") throw new Error(`task ${d.taskId}: the owner must name who works on it`);
        if (typeof d.reason !== "string" || d.reason === "") throw new Error(`task ${d.taskId}: a new owner needs a reason`);
        return;
      }
      case "task.status_changed":
        this.onlyOrchestrator(event.type, actor);
        this.checkTaskMove(event.data);
        return;
      case "task.routed": {
        this.onlyOrchestrator(event.type, actor);
        const d = event.data;
        if (!p.task(d.taskId)) throw new Error(`unknown task ${d.taskId}`);
        if (!isRouteAction(d.action)) throw new Error(`task ${d.taskId}: unknown routing action ${String(d.action)}`);
        if (typeof d.signal !== "object" || d.signal === null || !isRouteSignalType(d.signal.type)) {
          throw new Error(`task ${d.taskId}: unknown routing signal ${JSON.stringify(d.signal)}`);
        }
        if (typeof d.signal.value !== "string" || d.signal.value === "") throw new Error(`task ${d.taskId}: a routing signal needs a value`);
        if (typeof d.reason !== "string" || d.reason === "") throw new Error(`task ${d.taskId}: a routing decision needs a reason`);
        if (d.attemptId !== undefined && !p.attempt(d.attemptId)) throw new Error(`unknown attempt ${d.attemptId}`);
        if (d.nodeId !== undefined && !p.node(d.nodeId)) throw new Error(`unknown node ${d.nodeId}`);
        return;
      }
    }
  }

  /** A provenance, when there is one (or has to be), has the six fields of the stamp. */
  private checkProvenance(what: string, provenance: unknown, required = false): void {
    if (provenance === undefined) {
      if (required) throw new Error(`${what} needs a provenance`);
      return;
    }
    const problems = provenanceProblems(provenance);
    if (problems.length > 0) throw new Error(`${what}: ${problems.join("; ")}`);
  }

  /** The items a draw included and withheld are two lists of ids, with no id twice and none in both. */
  private checkDraw(attemptId: string, included: unknown, withheld: unknown): void {
    const seen = new Set<string>();
    for (const [name, list] of [["included", included], ["withheld", withheld]] as const) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new Error(`attempt ${attemptId}: ${name} is a list of item ids`);
      for (const id of list) {
        if (typeof id !== "string" || id === "") throw new Error(`attempt ${attemptId}: ${name} holds item ids`);
        if (seen.has(id)) throw new Error(`attempt ${attemptId}: item ${id} is drawn twice (included and withheld together, or listed twice)`);
        seen.add(id);
      }
    }
  }

  /** Task events are the orchestrator's: a line proposes a task through its context and the orchestrator commits it. */
  private onlyOrchestrator(type: EventType, actor: string): void {
    if (actor !== TASK_WRITER) throw new Error(`${type} is written by the ${TASK_WRITER} only, not by ${actor}`);
  }

  private checkTaskCreated(d: EventDataMap["task.created"]): void {
    const p = this.projection;
    if (p.task(d.taskId)) throw new Error(`task ${d.taskId} already exists`);
    if (!isTaskKind(d.kind)) throw new Error(`task ${d.taskId} has unknown kind ${String(d.kind)}`);
    if (d.problemId !== undefined && !p.problem(d.problemId)) throw new Error(`unknown problem ${d.problemId}`);
    if (d.claimId !== undefined && !p.claim(d.claimId)) throw new Error(`unknown claim ${d.claimId}`);
    if (d.edgeId !== undefined && !p.edge(d.edgeId)) throw new Error(`unknown edge ${d.edgeId}`);
    if (!Array.isArray(d.dependsOn)) throw new Error(`task ${d.taskId}: dependsOn must be a list of task ids`);
    if (new Set(d.dependsOn).size !== d.dependsOn.length) throw new Error(`task ${d.taskId} depends on a task twice`);
    // A task depends only on tasks that already exist, so the dependencies cannot make a cycle.
    for (const id of d.dependsOn) {
      if (!p.task(id)) throw new Error(`task ${d.taskId} depends on unknown task ${id}`);
    }
    if (d.parentTaskId !== undefined && !p.task(d.parentTaskId)) throw new Error(`unknown parent task ${d.parentTaskId}`);
    const shape = [...acceptanceProblems(d.acceptance), ...budgetProblems(d.budget)];
    if (shape.length > 0) throw new Error(`task ${d.taskId}: ${shape.join("; ")}`);
    if (d.acceptance.type === "claim" && !p.claim(d.acceptance.claimId)) throw new Error(`task ${d.taskId}: its criterion names unknown claim ${d.acceptance.claimId}`);
    if (d.acceptance.type === "edge" && !p.edge(d.acceptance.edgeId)) throw new Error(`task ${d.taskId}: its criterion names unknown edge ${d.acceptance.edgeId}`);
    if (d.owner !== undefined && (typeof d.owner !== "string" || d.owner === "")) throw new Error(`task ${d.taskId}: the owner must name who works on it`);
    if (d.proposedBy !== undefined && (typeof d.proposedBy !== "string" || d.proposedBy === "")) {
      throw new Error(`task ${d.taskId}: proposedBy must name the line that proposed it`);
    }
  }

  /**
   * The deterministic rules of the ledger. A task is `ready` when its dependencies are `done`; it
   * `runs` with an owner; it is `blocked` by something named; it is `done` only when its acceptance
   * criterion holds in the projection; a `running` task goes back to `ready` only after the run was
   * resumed since it started. Nothing here reads or writes a claim: a task event never changes a
   * claim's status.
   */
  private checkTaskMove(d: EventDataMap["task.status_changed"]): void {
    const p = this.projection;
    const task = p.task(d.taskId);
    if (!task) throw new Error(`unknown task ${d.taskId}`);
    if (!isTaskStatus(d.from) || !isTaskStatus(d.to)) throw new Error(`task ${d.taskId}: unknown status ${String(d.from)} -> ${String(d.to)}`);
    if (task.status !== d.from) throw new Error(`task ${d.taskId} is ${task.status}, not ${d.from}`);
    assertTaskTransition(d.from, d.to);
    if (typeof d.reason !== "string" || d.reason === "") throw new Error(`task ${d.taskId}: a status change needs a reason`);
    if (d.to !== "blocked" && d.blockedBy !== undefined) throw new Error(`task ${d.taskId}: only a blocked task has blockedBy`);

    if (d.to === "ready" || d.to === "running") {
      const open = task.depends_on.filter((id) => p.task(id)?.status !== "done");
      if (open.length > 0) throw new Error(`task ${d.taskId} cannot be ${d.to}: ${open.join(", ")} not done`);
    }
    if (d.from === "blocked" && d.to === "ready") {
      const open = (task.blocked_by ?? []).filter((id) => !EXTERNAL_BLOCKER.test(id) && p.task(id)?.status !== "done");
      if (open.length > 0) throw new Error(`task ${d.taskId} is still blocked by ${open.join(", ")}`);
    }
    if (d.from === "running" && d.to === "ready" && !(task.running_seq !== null && p.lastResumedSeq() > task.running_seq)) {
      throw new Error(`task ${d.taskId} can go back to ready only after the run was resumed since it started`);
    }
    if (d.to === "running" && task.owner === null) throw new Error(`task ${d.taskId} has no owner, so it cannot run`);
    if (d.to === "blocked") {
      const by = d.blockedBy;
      if (!Array.isArray(by) || by.length === 0) throw new Error(`task ${d.taskId} is blocked by nothing: blockedBy names what it waits for`);
      if (new Set(by).size !== by.length) throw new Error(`task ${d.taskId}: blockedBy names the same thing twice`);
      for (const id of by) {
        if (typeof id !== "string") throw new Error(`task ${d.taskId}: blockedBy holds task ids and ext:<name> keys`);
        if (EXTERNAL_BLOCKER.test(id)) continue;
        if (id === d.taskId) throw new Error(`task ${d.taskId} cannot be blocked by itself`);
        const blocker = p.task(id);
        if (!blocker) throw new Error(`task ${d.taskId} is blocked by unknown task ${id}`);
        if (blocker.status === "done") throw new Error(`task ${d.taskId} is blocked by task ${id}, which is done`);
      }
    }
    if (d.to === "done" && !acceptanceHolds(task.acceptance, { claimStatus: (id) => p.claim(id)?.status, edgeStatus: (id) => p.edge(id)?.status })) {
      throw new Error(`task ${d.taskId} cannot be done: its criterion does not hold (${describeAcceptance(task.acceptance)})`);
    }
  }

  /**
   * Trust policy for edges: an edge is `lean_checked` only when Lean checked its link lemma, that
   * is, a valid validation (fast check or certification) of a claim whose statement is the link's.
   * Whether the lemma says what the edge says is the job of whoever proposed it; a claim's status
   * still needs a certified proof of that claim, so a wrong edge can mislead a search but cannot
   * prove anything.
   */
  private checkLink(edgeId: string, link: EdgeLink | undefined, validationId: string | undefined): void {
    if (link === undefined) throw new Error(`edge ${edgeId} has no link lemma, so it cannot be lean_checked`);
    const validation = validationId === undefined ? undefined : this.projection.validation(validationId);
    if (!validation || validation.verdict !== "valid" || validation.negation) {
      throw new Error(`edge ${edgeId} can be lean_checked only with a valid validation of its link lemma`);
    }
    const claim = this.projection.claim(validation.claim_id);
    if (!claim || statementIdV0(claim.statement) !== statementIdV0(link.statement)) {
      throw new Error(`validation ${validationId} checks claim ${validation.claim_id}, not the link lemma of edge ${edgeId}`);
    }
  }

  close(): void {
    this.unsubscribe();
    this.log.close();
    this.projection.close();
  }
}
