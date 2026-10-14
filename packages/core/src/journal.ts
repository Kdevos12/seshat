import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventBody, EventDataMap, EventType, HarnessEvent } from "./events.ts";
import { statementIdV0 } from "./ids.ts";
import { EventLog, readEvents } from "./log.ts";
import { Projection, StaleProjectionError } from "./projection.ts";
import { type EdgeLink, isEdgeKind, LINK_KINDS, NODE_KIND } from "./records.ts";
import { assertTransition, isEdgeStatus } from "./status.ts";

/**
 * The single writer of a run: every fact goes through `emit`, which checks the invariants against
 * the projection, appends to the journal, then updates the projection.
 */
export class Journal {
  readonly log: EventLog;
  readonly projection: Projection;
  private readonly unsubscribe: () => void;

  /** Catches the projection up with the journal. Throws `StaleProjectionError` if it cannot. */
  constructor(log: EventLog, projection: Projection) {
    this.log = log;
    this.projection = projection;
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
   */
  static open(dir: string, run: string, options: { durable?: boolean } = {}): Journal {
    mkdirSync(dir, { recursive: true });
    const log = EventLog.open(join(dir, "journal.jsonl"), { run, ...options });
    const path = join(dir, "projection.sqlite");
    try {
      try {
        return Journal.attach(log, path);
      } catch (error) {
        if (!(error instanceof StaleProjectionError)) throw error;
      }
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      return Journal.attach(log, path);
    } catch (error) {
      log.close();
      throw error;
    }
  }

  private static attach(log: EventLog, path: string): Journal {
    const projection = Projection.open(path);
    try {
      return new Journal(log, projection);
    } catch (error) {
      projection.close();
      throw error;
    }
  }

  emit<K extends EventType>(type: K, data: EventDataMap[K], actor: string): Extract<HarnessEvent, { type: K }> {
    this.check({ type, data } as EventBody);
    return this.log.append(type, data, actor);
  }

  private check(event: EventBody): void {
    const p = this.projection;
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
        return;
      case "attempt.started":
        if (!p.claim(event.data.claimId)) throw new Error(`unknown claim ${event.data.claimId}`);
        if (p.attempt(event.data.attemptId)) throw new Error(`attempt ${event.data.attemptId} already exists`);
        return;
      case "attempt.finished": {
        const attempt = p.attempt(event.data.attemptId);
        if (!attempt) throw new Error(`unknown attempt ${event.data.attemptId}`);
        if (attempt.finished_seq !== null) throw new Error(`attempt ${event.data.attemptId} already finished`);
        return;
      }
      case "lesson.recorded":
        if (!p.attempt(event.data.attemptId)) throw new Error(`unknown attempt ${event.data.attemptId}`);
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
        return;
      }
      case "run.started":
      case "run.finished":
        return;
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
