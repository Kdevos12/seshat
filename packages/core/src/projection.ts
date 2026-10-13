import { DatabaseSync } from "node:sqlite";
import type { HarnessEvent, ProblemOutcome, SourceRef } from "./events.ts";
import type { ClaimStatus } from "./status.ts";

export interface ClaimRow {
  claim_id: string;
  statement_id: string;
  statement: string;
  origin: string;
  status: ClaimStatus;
  created_seq: number;
  updated_seq: number;
}

export interface AttemptRow {
  attempt_id: string;
  claim_id: string;
  prover: string;
  iteration: number;
  model: string;
  outcome: string | null;
  failure_class: string | null;
  stopped_by: string | null;
  error: string | null;
  usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  turns: number | null;
  started_seq: number;
  finished_seq: number | null;
}

export interface ToolRunRow {
  tool_run_id: string;
  attempt_id: string | null;
  capability: string;
  implementation: string;
  version: string;
  input_hash: string;
  outcome: string | null;
  duration_ms: number | null;
  started_seq: number;
  finished_seq: number | null;
}

export interface LessonRow {
  seq: number;
  attempt_id: string;
  claim_id: string;
  text: string;
}

export interface ValidationRow {
  validation_id: string;
  claim_id: string;
  attempt_id: string | null;
  method: "repl" | "kernel_replay";
  verdict: "valid" | "invalid";
  reasons: string[];
  axioms: string[];
  submission_hash: string;
  seq: number;
}

export interface ProblemRow {
  problem_id: string;
  claim_id: string;
  target: string;
  source: SourceRef;
  domain: string[];
  seq: number;
  outcome: ProblemOutcome | null;
  reason: string | null;
  finished_seq: number | null;
}

export interface RunSummary {
  problems: number;
  /** Problems whose claim is `proved` (certified). */
  solved: number;
  /** Problems whose claim is `computed`: a proof passed the fast check, not yet certified. */
  candidates: number;
  attempts: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

/** The projection is not a prefix of the journal (it is ahead, from another journal, or older code). */
export class StaleProjectionError extends Error {}

/** Version of the tables below, kept in SQLite's `user_version`. A projection of another version is rebuilt. */
export const PROJECTION_VERSION = 2;

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists problems (
  problem_id text primary key, claim_id text not null, target text not null,
  source_json text not null, domain_json text not null, seq integer not null,
  outcome text, reason text, finished_seq integer);
create table if not exists claims (
  claim_id text primary key, statement_id text not null, statement text not null,
  origin text not null, status text not null, created_seq integer not null, updated_seq integer not null);
create index if not exists claims_by_statement on claims (statement_id);
create table if not exists attempts (
  attempt_id text primary key, claim_id text not null, prover text not null, iteration integer not null,
  model text not null, outcome text, failure_class text, stopped_by text, error text, usd real, input_tokens integer,
  output_tokens integer, duration_ms integer, turns integer, started_seq integer not null, finished_seq integer);
create index if not exists attempts_by_claim on attempts (claim_id);
create table if not exists tool_runs (
  tool_run_id text primary key, attempt_id text, capability text not null, implementation text not null,
  version text not null, input_hash text not null, outcome text, duration_ms integer,
  started_seq integer not null, finished_seq integer);
create index if not exists tool_runs_by_attempt on tool_runs (attempt_id);
create table if not exists lessons (
  seq integer primary key, attempt_id text not null, claim_id text not null, text text not null);
create index if not exists lessons_by_claim on lessons (claim_id);
create table if not exists validations (
  validation_id text primary key, claim_id text not null, attempt_id text, method text not null, verdict text not null,
  reasons_json text not null, axioms_json text not null, submission_hash text not null, seq integer not null);
`;

/**
 * Queryable view of the journal in SQLite. Disposable: delete the file and replay the journal to
 * get it back. `apply` is idempotent, so replaying from any point is safe.
 */
export class Projection {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("pragma journal_mode = wal");
    const { user_version: version } = db.prepare("pragma user_version").get() as { user_version: number };
    const { n: tables } = db.prepare("select count(*) as n from sqlite_master where type = 'table'").get() as { n: number };
    if (version === 0 && tables === 0) {
      db.exec(SCHEMA);
      db.exec(`pragma user_version = ${PROJECTION_VERSION}`);
    } else if (version !== PROJECTION_VERSION) {
      db.close();
      throw new StaleProjectionError(`projection has version ${version}, this code writes version ${PROJECTION_VERSION}`);
    }
  }

  /** Opens or creates a projection. Throws `StaleProjectionError` if the file has another version. */
  static open(path: string): Projection {
    return new Projection(new DatabaseSync(path));
  }

  static inMemory(): Projection {
    return new Projection(new DatabaseSync(":memory:"));
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
  }

  lastSeq(): number {
    const value = this.meta("last_seq");
    return value === undefined ? -1 : Number(value);
  }

  /** Hash of the last applied event, to check that the projection belongs to a journal. */
  lastHash(): string | undefined {
    return this.meta("last_hash");
  }

  apply(event: HarnessEvent): void {
    if (event.seq <= this.lastSeq()) return;
    if (event.seq !== this.lastSeq() + 1) {
      throw new Error(`projection is at seq ${this.lastSeq()}, cannot apply seq ${event.seq}`);
    }
    this.db.exec("begin");
    try {
      this.applyUnchecked(event);
      this.setMeta("last_seq", String(event.seq));
      this.setMeta("last_hash", event.hash);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private applyUnchecked(event: HarnessEvent): void {
    const db = this.db;
    switch (event.type) {
      case "run.started":
      case "run.finished":
        return;
      case "problem.registered": {
        const d = event.data;
        db.prepare(
          "insert into problems (problem_id, claim_id, target, source_json, domain_json, seq) values (?, ?, ?, ?, ?, ?)",
        ).run(d.problemId, d.claimId, d.target, JSON.stringify(d.source), JSON.stringify(d.domain), event.seq);
        return;
      }
      case "problem.finished": {
        const d = event.data;
        db.prepare("update problems set outcome = ?, reason = ?, finished_seq = ? where problem_id = ?").run(
          d.outcome, d.reason ?? null, event.seq, d.problemId);
        return;
      }
      case "claim.created": {
        const d = event.data;
        db.prepare("insert into claims values (?, ?, ?, ?, ?, ?, ?)").run(
          d.claimId, d.statementId, d.statement, d.origin, d.status, event.seq, event.seq);
        return;
      }
      case "claim.status_changed": {
        const d = event.data;
        db.prepare("update claims set status = ?, updated_seq = ? where claim_id = ?").run(d.to, event.seq, d.claimId);
        return;
      }
      case "attempt.started": {
        const d = event.data;
        db.prepare(
          "insert into attempts (attempt_id, claim_id, prover, iteration, model, started_seq) values (?, ?, ?, ?, ?, ?)",
        ).run(d.attemptId, d.claimId, d.prover, d.iteration, d.model, event.seq);
        return;
      }
      case "attempt.finished": {
        const d = event.data;
        db.prepare(
          `update attempts set outcome = ?, failure_class = ?, stopped_by = ?, error = ?, usd = ?, input_tokens = ?,
           output_tokens = ?, duration_ms = ?, turns = ?, finished_seq = ? where attempt_id = ?`,
        ).run(
          d.outcome, d.failureClass ?? null, d.stoppedBy ?? null, d.error ?? null, d.usd, d.inputTokens, d.outputTokens,
          d.durationMs, d.turns, event.seq, d.attemptId);
        return;
      }
      case "tool_run.started": {
        const d = event.data;
        db.prepare(
          `insert into tool_runs (tool_run_id, attempt_id, capability, implementation, version, input_hash, started_seq)
           values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(d.toolRunId, d.attemptId ?? null, d.capability, d.implementation, d.version, d.inputHash, event.seq);
        return;
      }
      case "tool_run.finished": {
        const d = event.data;
        db.prepare("update tool_runs set outcome = ?, duration_ms = ?, finished_seq = ? where tool_run_id = ?").run(
          d.outcome, d.durationMs, event.seq, d.toolRunId);
        return;
      }
      case "lesson.recorded": {
        const d = event.data;
        db.prepare("insert into lessons values (?, ?, ?, ?)").run(event.seq, d.attemptId, d.claimId, d.text);
        return;
      }
      case "validation.finished": {
        const d = event.data;
        db.prepare("insert into validations values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          d.validationId, d.claimId, d.attemptId ?? null, d.method, d.verdict, JSON.stringify(d.reasons),
          JSON.stringify(d.axioms), d.submissionHash, event.seq);
        return;
      }
    }
  }

  claim(claimId: string): ClaimRow | undefined {
    return this.db.prepare("select * from claims where claim_id = ?").get(claimId) as ClaimRow | undefined;
  }

  claimsByStatement(statementId: string): ClaimRow[] {
    return this.db.prepare("select * from claims where statement_id = ? order by created_seq").all(statementId) as unknown as ClaimRow[];
  }

  problem(problemId: string): ProblemRow | undefined {
    const row = this.db.prepare("select * from problems where problem_id = ?").get(problemId) as StoredProblem | undefined;
    return row === undefined ? undefined : problemRow(row);
  }

  problems(): ProblemRow[] {
    const rows = this.db.prepare("select * from problems order by seq").all() as unknown as StoredProblem[];
    return rows.map(problemRow);
  }

  attempt(attemptId: string): AttemptRow | undefined {
    return this.db.prepare("select * from attempts where attempt_id = ?").get(attemptId) as AttemptRow | undefined;
  }

  attempts(claimId: string): AttemptRow[] {
    return this.db.prepare("select * from attempts where claim_id = ? order by started_seq").all(claimId) as unknown as AttemptRow[];
  }

  toolRun(toolRunId: string): ToolRunRow | undefined {
    return this.db.prepare("select * from tool_runs where tool_run_id = ?").get(toolRunId) as ToolRunRow | undefined;
  }

  toolRuns(attemptId: string): ToolRunRow[] {
    return this.db.prepare("select * from tool_runs where attempt_id = ? order by started_seq").all(attemptId) as unknown as ToolRunRow[];
  }

  lessons(claimId: string): LessonRow[] {
    return this.db.prepare("select * from lessons where claim_id = ? order by seq").all(claimId) as unknown as LessonRow[];
  }

  validation(validationId: string): ValidationRow | undefined {
    const row = this.db.prepare("select * from validations where validation_id = ?").get(validationId) as
      | (Omit<ValidationRow, "reasons" | "axioms"> & { reasons_json: string; axioms_json: string })
      | undefined;
    if (row === undefined) return undefined;
    const { reasons_json, axioms_json, ...rest } = row;
    return { ...rest, reasons: JSON.parse(reasons_json) as string[], axioms: JSON.parse(axioms_json) as string[] };
  }

  validations(claimId: string): ValidationRow[] {
    const rows = this.db.prepare("select * from validations where claim_id = ? order by seq").all(claimId) as unknown as Array<
      Omit<ValidationRow, "reasons" | "axioms"> & { reasons_json: string; axioms_json: string }
    >;
    return rows.map(({ reasons_json, axioms_json, ...rest }) => ({
      ...rest,
      reasons: JSON.parse(reasons_json) as string[],
      axioms: JSON.parse(axioms_json) as string[],
    }));
  }

  runSummary(): RunSummary {
    const p = this.db.prepare("select count(*) as n from problems").get() as { n: number };
    const byStatus = (status: string) =>
      (this.db.prepare(
        "select count(*) as n from problems join claims using (claim_id) where claims.status = ?",
      ).get(status) as { n: number }).n;
    const a = this.db.prepare(
      `select count(*) as n, coalesce(sum(usd), 0) as usd, coalesce(sum(input_tokens), 0) as input_tokens,
       coalesce(sum(output_tokens), 0) as output_tokens from attempts`,
    ).get() as { n: number; usd: number; input_tokens: number; output_tokens: number };
    return {
      problems: p.n,
      solved: byStatus("proved"),
      candidates: byStatus("computed"),
      attempts: a.n,
      usd: a.usd,
      inputTokens: a.input_tokens,
      outputTokens: a.output_tokens,
    };
  }

  close(): void {
    this.db.close();
  }
}

type StoredProblem = Omit<ProblemRow, "source" | "domain"> & { source_json: string; domain_json: string };

function problemRow({ source_json, domain_json, ...rest }: StoredProblem): ProblemRow {
  return { ...rest, source: JSON.parse(source_json) as SourceRef, domain: JSON.parse(domain_json) as string[] };
}
