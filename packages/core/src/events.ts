import type { Json } from "./canonical-json.ts";
import type { ClaimStatus } from "./status.ts";

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
  inputTokens: number;
  outputTokens: number;
}

export type AttemptOutcome = "valid" | "invalid" | "no_submission" | "budget_exhausted" | "aborted" | "error";

export interface EventDataMap {
  "run.started": {
    runId: string;
    benchId: string;
    problems: number;
    host: string;
    config: Json;
    codeRev?: string;
  };
  "run.finished": {
    runId: string;
    attempted: number;
    solved: number;
    usd: number;
  };
  "problem.registered": {
    problemId: string;
    claimId: string;
    target: string;
    source: SourceRef;
    domain: string[];
  };
  "claim.created": {
    claimId: string;
    statementId: string;
    statement: string;
    origin: string;
    status: ClaimStatus;
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
  };
  "attempt.finished": TokenCost & {
    attemptId: string;
    outcome: AttemptOutcome;
    failureClass?: string;
    durationMs: number;
    turns: number;
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
  "claim.created",
  "claim.status_changed",
  "attempt.started",
  "attempt.finished",
  "tool_run.started",
  "tool_run.finished",
  "lesson.recorded",
  "validation.finished",
];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}
