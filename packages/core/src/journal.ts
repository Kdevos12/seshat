import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventBody, EventDataMap, EventType, HarnessEvent } from "./events.ts";
import { EventLog, readEvents } from "./log.ts";
import { Projection } from "./projection.ts";
import { assertTransition } from "./status.ts";

/** The projection is not a prefix of the journal (it is ahead, or from another journal). */
export class StaleProjectionError extends Error {}

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
      const projection = Projection.open(path);
      try {
        return new Journal(log, projection);
      } catch (error) {
        projection.close();
        if (!(error instanceof StaleProjectionError)) throw error;
      }
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      return new Journal(log, Projection.open(path));
    } catch (error) {
      log.close();
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
      case "claim.created":
        if (p.claim(event.data.claimId)) throw new Error(`claim ${event.data.claimId} already exists`);
        return;
      case "claim.status_changed": {
        const claim = p.claim(event.data.claimId);
        if (!claim) throw new Error(`unknown claim ${event.data.claimId}`);
        if (claim.status !== event.data.from) {
          throw new Error(`claim ${event.data.claimId} is ${claim.status}, not ${event.data.from}`);
        }
        assertTransition(event.data.from, event.data.to);
        // Trust policy: only a certified proof (kernel replay) settles a claim.
        if (event.data.to === "proved" || event.data.to === "refuted") {
          const id = event.data.validationId;
          const validation = id === undefined ? undefined : p.validation(id);
          if (!validation || validation.verdict !== "valid" || validation.method !== "kernel_replay") {
            throw new Error(`claim ${event.data.claimId} can become ${event.data.to} only with a certified validation`);
          }
          if (event.data.to === "proved" && validation.claim_id !== event.data.claimId) {
            throw new Error(`validation ${id} certifies claim ${validation.claim_id}, not ${event.data.claimId}`);
          }
        }
        return;
      }
      case "problem.registered":
        if (!p.claim(event.data.claimId)) throw new Error(`unknown claim ${event.data.claimId}`);
        return;
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
      case "run.started":
      case "run.finished":
        return;
    }
  }

  close(): void {
    this.unsubscribe();
    this.log.close();
    this.projection.close();
  }
}
