import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, type Json, mergePatch } from "./canonical-json.ts";
import type { HarnessEvent, ProblemOutcome, SourceRef } from "./events.ts";
import type { AttemptRole, ClaimKind, EdgeKind } from "./records.ts";
import type { ClaimStatus, EdgeStatus } from "./status.ts";

export interface ClaimRow {
  claim_id: string;
  statement_id: string;
  statement: string;
  origin: string;
  status: ClaimStatus;
  created_seq: number;
  updated_seq: number;
  gloss: string | null;
  domain: string[];
  kind: ClaimKind;
  parent_id: string | null;
  header: string | null;
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
  role: AttemptRole | null;
  /** The strategy given when the attempt started, or the one the model declared in its last check. */
  declared_strategy: string | null;
  subgoal: string | null;
  /** The strategy classified when it finished. */
  strategy: string | null;
  premises: string[] | null;
  failure_detail: string | null;
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
  /** True for a validation of the claim's negation. */
  negation: boolean;
}

export interface EdgeRow {
  edge_id: string;
  kind: EdgeKind;
  from_id: string;
  /** The targets, in order. */
  to: string[];
  status: EdgeStatus;
  attempt_id: string | null;
  tool_run_id: string | null;
  /** The validation behind the current status: of `edge.added`, then of the last status change. */
  validation_id: string | null;
  note: string | null;
  link_name: string | null;
  link_statement: string | null;
  created_seq: number;
  updated_seq: number;
}

export interface NodeRow {
  node_id: string;
  kind: string;
  claim_id: string | null;
  /** The recorded data with every update's patch applied, in order. */
  data: Json;
  created_seq: number;
  updated_seq: number;
}

export interface ModelCallRow {
  model_call_id: string;
  line: string;
  problem_id: string | null;
  attempt_id: string | null;
  model: string;
  outcome: "ok" | "error" | "aborted";
  usd: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  seq: number;
}

/** Which edges `edges` returns; every given criterion must hold. */
export interface EdgeFilter {
  from?: string;
  /** An edge one of whose targets is this id. */
  to?: string;
  kinds?: readonly EdgeKind[];
  statuses?: readonly EdgeStatus[];
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
export const PROJECTION_VERSION = 3;

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists problems (
  problem_id text primary key, claim_id text not null, target text not null,
  source_json text not null, domain_json text not null, seq integer not null,
  outcome text, reason text, finished_seq integer);
create table if not exists claims (
  claim_id text primary key, statement_id text not null, statement text not null,
  origin text not null, status text not null, created_seq integer not null, updated_seq integer not null,
  gloss text, domain_json text, kind text not null, parent_id text, header text);
create index if not exists claims_by_statement on claims (statement_id);
create index if not exists claims_by_parent on claims (parent_id);
create table if not exists attempts (
  attempt_id text primary key, claim_id text not null, prover text not null, iteration integer not null,
  model text not null, outcome text, failure_class text, stopped_by text, error text, usd real, input_tokens integer,
  output_tokens integer, duration_ms integer, turns integer, started_seq integer not null, finished_seq integer,
  role text, declared_strategy text, subgoal text, strategy text, premises_json text, failure_detail text);
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
  reasons_json text not null, axioms_json text not null, submission_hash text not null, seq integer not null,
  negation integer not null);
create table if not exists edges (
  edge_id text primary key, kind text not null, from_id text not null, status text not null, attempt_id text,
  tool_run_id text, validation_id text, note text, link_name text, link_statement text,
  created_seq integer not null, updated_seq integer not null);
create index if not exists edges_by_from on edges (from_id);
create table if not exists edge_targets (
  edge_id text not null, position integer not null, to_id text not null, primary key (edge_id, position));
create index if not exists edge_targets_by_to on edge_targets (to_id);
create table if not exists nodes (
  node_id text primary key, kind text not null, claim_id text, data_json text not null,
  created_seq integer not null, updated_seq integer not null);
create index if not exists nodes_by_kind on nodes (kind, claim_id);
create table if not exists model_calls (
  model_call_id text primary key, line text not null, problem_id text, attempt_id text, model text not null,
  outcome text not null, usd real not null, input_tokens integer not null, output_tokens integer not null,
  duration_ms integer not null, seq integer not null);
`;

/**
 * The SQL of `Projection.edges`, and its values. The edges that end at an id are found through
 * `edge_targets_by_to`, then by their key: written as a correlated `exists (...)`, the same filter
 * made SQLite scan every edge, and `equivalents` and every graph query call it. A test reads the
 * query plan.
 */
export function edgesSql(filter: EdgeFilter): { sql: string; values: SQLInputValue[] } {
  const where: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.from !== undefined) {
    where.push("from_id = ?");
    values.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("edge_id in (select edge_id from edge_targets where to_id = ?)");
    values.push(filter.to);
  }
  for (const [column, list] of [["kind", filter.kinds], ["status", filter.statuses]] as const) {
    if (list === undefined) continue;
    where.push(`${column} in (${list.map(() => "?").join(", ") || "null"})`);
    values.push(...list);
  }
  return { sql: `select * from edges${where.length > 0 ? ` where ${where.join(" and ")}` : ""} order by created_seq`, values };
}

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
        ).run(d.problemId, d.claimId, d.target, canonicalJson(d.source), canonicalJson(d.domain), event.seq);
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
        db.prepare(
          `insert into claims (claim_id, statement_id, statement, origin, status, created_seq, updated_seq, gloss, domain_json,
           kind, parent_id, header) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.claimId, d.statementId, d.statement, d.origin, d.status, event.seq, event.seq, d.gloss ?? null,
          d.domain === undefined ? null : canonicalJson(d.domain), d.kind ?? "formal", d.parentId ?? null, d.header ?? null);
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
          `insert into attempts (attempt_id, claim_id, prover, iteration, model, started_seq, role, declared_strategy, subgoal)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(d.attemptId, d.claimId, d.prover, d.iteration, d.model, event.seq, d.role ?? null, d.strategy ?? null, d.subgoal ?? null);
        return;
      }
      case "attempt.finished": {
        const d = event.data;
        db.prepare(
          `update attempts set outcome = ?, failure_class = ?, stopped_by = ?, error = ?, usd = ?, input_tokens = ?,
           output_tokens = ?, duration_ms = ?, turns = ?, finished_seq = ?, strategy = ?, premises_json = ?, failure_detail = ?,
           declared_strategy = coalesce(?, declared_strategy)
           where attempt_id = ?`,
        ).run(
          d.outcome, d.failureClass ?? null, d.stoppedBy ?? null, d.error ?? null, d.usd, d.inputTokens, d.outputTokens,
          d.durationMs, d.turns, event.seq, d.strategy ?? null, d.premises === undefined ? null : canonicalJson(d.premises),
          d.failureDetail ?? null, d.declaredStrategy ?? null, d.attemptId);
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
        db.prepare(
          `insert into validations (validation_id, claim_id, attempt_id, method, verdict, reasons_json, axioms_json,
           submission_hash, seq, negation) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.validationId, d.claimId, d.attemptId ?? null, d.method, d.verdict, canonicalJson(d.reasons),
          canonicalJson(d.axioms), d.submissionHash, event.seq, d.negation === true ? 1 : 0);
        return;
      }
      case "edge.added": {
        const d = event.data;
        db.prepare(
          `insert into edges (edge_id, kind, from_id, status, attempt_id, tool_run_id, validation_id, note, link_name,
           link_statement, created_seq, updated_seq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.edgeId, d.kind, d.from, d.status, d.attemptId ?? null, d.toolRunId ?? null, d.validationId ?? null, d.note ?? null,
          d.link?.name ?? null, d.link?.statement ?? null, event.seq, event.seq);
        const target = db.prepare("insert into edge_targets (edge_id, position, to_id) values (?, ?, ?)");
        d.to.forEach((to, position) => target.run(d.edgeId, position, to));
        return;
      }
      case "edge.status_changed": {
        const d = event.data;
        db.prepare("update edges set status = ?, validation_id = ?, updated_seq = ? where edge_id = ?").run(
          d.to, d.validationId ?? null, event.seq, d.edgeId);
        return;
      }
      case "node.recorded": {
        const d = event.data;
        db.prepare("insert into nodes (node_id, kind, claim_id, data_json, created_seq, updated_seq) values (?, ?, ?, ?, ?, ?)").run(
          d.nodeId, d.kind, d.claimId ?? null, canonicalJson(d.data), event.seq, event.seq);
        return;
      }
      case "node.updated": {
        const d = event.data;
        const row = db.prepare("select data_json from nodes where node_id = ?").get(d.nodeId) as { data_json: string };
        const data = mergePatch(JSON.parse(row.data_json) as Json, d.patch);
        db.prepare("update nodes set data_json = ?, updated_seq = ? where node_id = ?").run(canonicalJson(data), event.seq, d.nodeId);
        return;
      }
      case "model_call.finished": {
        const d = event.data;
        db.prepare(
          `insert into model_calls (model_call_id, line, problem_id, attempt_id, model, outcome, usd, input_tokens,
           output_tokens, duration_ms, seq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.modelCallId, d.line, d.problemId ?? null, d.attemptId ?? null, d.model, d.outcome, d.usd, d.inputTokens,
          d.outputTokens, d.durationMs, event.seq);
        return;
      }
    }
  }

  claim(claimId: string): ClaimRow | undefined {
    const row = this.db.prepare("select * from claims where claim_id = ?").get(claimId) as StoredClaim | undefined;
    return row === undefined ? undefined : claimRow(row);
  }

  claimsByStatement(statementId: string): ClaimRow[] {
    const rows = this.db.prepare("select * from claims where statement_id = ? order by created_seq").all(statementId) as unknown as StoredClaim[];
    return rows.map(claimRow);
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
    const row = this.db.prepare("select * from attempts where attempt_id = ?").get(attemptId) as StoredAttempt | undefined;
    return row === undefined ? undefined : attemptRow(row);
  }

  attempts(claimId: string): AttemptRow[] {
    const rows = this.db.prepare("select * from attempts where claim_id = ? order by started_seq").all(claimId) as unknown as StoredAttempt[];
    return rows.map(attemptRow);
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
    const row = this.db.prepare("select * from validations where validation_id = ?").get(validationId) as StoredValidation | undefined;
    return row === undefined ? undefined : validationRow(row);
  }

  validations(claimId: string): ValidationRow[] {
    const rows = this.db.prepare("select * from validations where claim_id = ? order by seq").all(claimId) as unknown as StoredValidation[];
    return rows.map(validationRow);
  }

  edge(edgeId: string): EdgeRow | undefined {
    const row = this.db.prepare("select * from edges where edge_id = ?").get(edgeId) as StoredEdge | undefined;
    return row === undefined ? undefined : this.edgeRow(row);
  }

  /** The edges that meet every criterion of the filter, in the order they were added. */
  edges(filter: EdgeFilter = {}): EdgeRow[] {
    const { sql, values } = edgesSql(filter);
    const rows = this.db.prepare(sql).all(...values) as unknown as StoredEdge[];
    return rows.map((row) => this.edgeRow(row));
  }

  private edgeRow(row: StoredEdge): EdgeRow {
    const targets = this.db.prepare("select to_id from edge_targets where edge_id = ? order by position").all(row.edge_id) as unknown as Array<{
      to_id: string;
    }>;
    return { ...row, to: targets.map((t) => t.to_id) };
  }

  node(nodeId: string): NodeRow | undefined {
    const row = this.db.prepare("select * from nodes where node_id = ?").get(nodeId) as StoredNode | undefined;
    return row === undefined ? undefined : nodeRow(row);
  }

  /** The nodes of a kind (of one claim, if given), in the order they were recorded. */
  nodes(kind: string, claimId?: string): NodeRow[] {
    const rows = (
      claimId === undefined
        ? this.db.prepare("select * from nodes where kind = ? order by created_seq").all(kind)
        : this.db.prepare("select * from nodes where kind = ? and claim_id = ? order by created_seq").all(kind, claimId)
    ) as unknown as StoredNode[];
    return rows.map(nodeRow);
  }

  modelCall(modelCallId: string): ModelCallRow | undefined {
    return this.db.prepare("select * from model_calls where model_call_id = ?").get(modelCallId) as ModelCallRow | undefined;
  }

  /** Counts and costs of the run: the attempts' and the lines' model calls. */
  runSummary(): RunSummary {
    const p = this.db.prepare("select count(*) as n from problems").get() as { n: number };
    const byStatus = (status: string) =>
      (this.db.prepare(
        "select count(*) as n from problems join claims using (claim_id) where claims.status = ?",
      ).get(status) as { n: number }).n;
    const costs = (table: string) =>
      this.db.prepare(
        `select count(*) as n, coalesce(sum(usd), 0) as usd, coalesce(sum(input_tokens), 0) as input_tokens,
         coalesce(sum(output_tokens), 0) as output_tokens from ${table}`,
      ).get() as { n: number; usd: number; input_tokens: number; output_tokens: number };
    const a = costs("attempts");
    const m = costs("model_calls");
    return {
      problems: p.n,
      solved: byStatus("proved"),
      candidates: byStatus("computed"),
      attempts: a.n,
      usd: a.usd + m.usd,
      inputTokens: a.input_tokens + m.input_tokens,
      outputTokens: a.output_tokens + m.output_tokens,
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

type StoredClaim = Omit<ClaimRow, "domain"> & { domain_json: string | null };

function claimRow({ domain_json, ...rest }: StoredClaim): ClaimRow {
  return { ...rest, domain: domain_json === null ? [] : (JSON.parse(domain_json) as string[]) };
}

type StoredAttempt = Omit<AttemptRow, "premises"> & { premises_json: string | null };

function attemptRow({ premises_json, ...rest }: StoredAttempt): AttemptRow {
  return { ...rest, premises: premises_json === null ? null : (JSON.parse(premises_json) as string[]) };
}

type StoredValidation = Omit<ValidationRow, "reasons" | "axioms" | "negation"> & {
  reasons_json: string;
  axioms_json: string;
  negation: number;
};

function validationRow({ reasons_json, axioms_json, negation, ...rest }: StoredValidation): ValidationRow {
  return { ...rest, reasons: JSON.parse(reasons_json) as string[], axioms: JSON.parse(axioms_json) as string[], negation: negation === 1 };
}

type StoredEdge = Omit<EdgeRow, "to">;

type StoredNode = Omit<NodeRow, "data"> & { data_json: string };

function nodeRow({ data_json, ...rest }: StoredNode): NodeRow {
  return { ...rest, data: JSON.parse(data_json) as Json };
}
