import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, type Json, mergePatch } from "./canonical-json.ts";
import type { MemoryChain } from "./chain.ts";
import type { AttemptCarry, EventDataMap, HarnessEvent, ProblemOutcome, SourceRef } from "./events.ts";
import type { EpochChange, Provenance } from "./provenance.ts";
import { type AttemptRole, type ClaimKind, type EdgeKind, SITE_PROVER_SESSION } from "./records.ts";
import type { ClaimStatus, EdgeStatus } from "./status.ts";
import type { RouteAction, RouteSignalType, TaskAcceptance, TaskBudget, TaskKind, TaskStatus } from "./tasks.ts";

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
  /**
   * The status an earlier run's journal recorded for the claim when that run was in another Lean
   * environment: it counts for nothing (`status` stays what this run established, `open` until a
   * stored proof passes `validate` again). Null: nothing earlier, or the earlier status carried.
   */
  earlier_status: ClaimStatus | null;
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
  /** The task the attempt worked for. */
  task_id: string | null;
  /** Where its model calls were made; null: `prover.session`. */
  site: string | null;
  /** What its model responses cost so far, from `attempt.charged`: what a session that never finished spent. */
  charged_usd: number;
  charged_input_tokens: number;
  charged_output_tokens: number;
  charged_requests: number;
  /** What the prover carried to its next session. */
  carry: AttemptCarry | null;
  /** The stamp of the record (documentation/memory.md, "Provenance and epochs"); null before the stamps. */
  provenance: Provenance | null;
  /** The unverified items the session was shown, and the ones the draw withheld; null when no draw was made. */
  included: string[] | null;
  withheld: string[] | null;
  /** The memory's epoch when the attempt started. */
  epoch: number;
  /** The settings a line sampled for the session (`attempt.started`); null when none were. */
  settings: { [key: string]: Json } | null;
  /** True when the exploration floor drew the session's strategy; false when it did not; null for a session that recorded neither. */
  exploration: boolean | null;
  /** How many runs before the current one the attempt was made in: 0 for this run, 1 for the last run of the chain, and so on. */
  runs_ago: number;
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
  provenance: Provenance | null;
  /** The memory's epoch when the lesson was recorded. */
  epoch: number;
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
  /** The problem whose workbench made the check. */
  problem_id: string | null;
  /**
   * False for a validation of an earlier run in another Lean environment (`Projection.earlierValidation`):
   * it is not found by `validation` and `validations`, and no status can cite it.
   */
  carried: boolean;
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
  /** The status an earlier run in another Lean environment recorded; it counts for nothing (as `ClaimRow.earlier_status`). */
  earlier_status: EdgeStatus | null;
}

export interface NodeRow {
  node_id: string;
  kind: string;
  claim_id: string | null;
  /** The recorded data with every update's patch applied, in order. */
  data: Json;
  created_seq: number;
  updated_seq: number;
  /** The stamp of a node a mechanism learned from outcomes; null for any other. */
  provenance: Provenance | null;
  /** The memory's epoch when the node was recorded. */
  epoch: number;
}

/** An epoch the memory entered (`memory.epoch_opened`); epoch 0 is the first and has no row. */
export interface EpochRow {
  epoch: number;
  seq: number;
  reason: string;
  changes: EpochChange[];
  provenance: Provenance;
}

/** An attempt that a memory item was offered to in a draw, and whether the draw included it. */
export interface ItemAttemptRow {
  attempt: AttemptRow;
  included: boolean;
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
  /** Where the call was made; null in journals older than the tags. */
  site: string | null;
}

export interface TaskRow {
  task_id: string;
  kind: TaskKind;
  problem_id: string | null;
  claim_id: string | null;
  edge_id: string | null;
  owner: string | null;
  acceptance: TaskAcceptance;
  budget: TaskBudget;
  depends_on: string[];
  parent_task_id: string | null;
  proposed_by: string | null;
  title: string | null;
  status: TaskStatus;
  /** Why it has its status: the last transition's reason. */
  reason: string | null;
  /** While `blocked`: what it waits for. */
  blocked_by: string[] | null;
  created_seq: number;
  updated_seq: number;
  /** The seq of its last move to `running`. */
  running_seq: number | null;
}

/** Which tasks `tasks` returns; every given criterion must hold. */
export interface TaskFilter {
  problemId?: string;
  claimId?: string;
  owner?: string;
  statuses?: readonly TaskStatus[];
  kinds?: readonly TaskKind[];
}

export interface TaskRouteRow {
  seq: number;
  task_id: string;
  action: RouteAction;
  signal_type: RouteSignalType;
  signal_value: string;
  reason: string;
  attempt_id: string | null;
  node_id: string | null;
}

export interface ResumptionRow {
  seq: number;
  resumption: number;
  data: EventDataMap["run.resumed"];
}

/** What a set of attempts and model calls cost. */
export interface Spend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/** What one site of the harness spent. */
export interface SiteSpend extends Spend {
  site: string;
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
  /**
   * The three counts are the claims': a problem is counted when its claim has the status, whichever
   * problem settled it, so two problems that share a claim are counted twice. The problems'
   * outcomes (`problem.finished`) are another count.
   *
   * Problems whose claim is `proved` (certified).
   */
  solved: number;
  /** Problems whose claim is `refuted` (a certified proof of the negation). */
  refuted: number;
  /** Problems whose claim is `computed`: a proof passed the fast check and is not certified (no answer from the certifier, or the kernel rejected it). */
  candidates: number;
  attempts: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

/** What a run took from the journals it started on (`Projection.memorySummary`), for its report. */
export interface MemorySummary {
  /** Claims that came from the earlier journals. */
  claims: number;
  /** Of those, the ones whose status carried (same Lean environment), by status; `open` is not listed. */
  carried: Record<string, number>;
  /** Claims whose earlier status counts for nothing: another Lean environment, so they are open until a stored proof validates again. */
  reset: number;
  attempts: number;
  toolRuns: number;
  lessons: number;
  nodes: number;
  /** Edges that came from the earlier journals, and the ones among them whose status was reset to `proposed`. */
  edges: number;
  edgesReset: number;
  /** Validations of the earlier journals: the ones that count and the ones that do not. */
  validations: { carried: number; notCarried: number };
  /** Epochs the earlier journals opened. */
  epochs: number;
}

/** The projection is not a prefix of the journal (it is ahead, from another journal, or older code). */
export class StaleProjectionError extends Error {}

/** Version of the tables below, kept in SQLite's `user_version`. A projection of another version is rebuilt. */
export const PROJECTION_VERSION = 7;

/** Events of an earlier journal that the projection leaves out: what that run did on its own account. */
const INHERITED_SKIPPED: readonly string[] = [
  "run.resumed",
  // The turns of an earlier consortium run are not this run's: its first turn is turn 1.
  "turn.started",
  "turn.ended",
  "problem.registered",
  "problem.finished",
  "model_call.finished",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.routed",
];

/**
 * The node kinds only a person writes: the hints and steers of the research team. Nobody edits one (a
 * person who changes their mind writes a new one), and a run that starts on earlier journals does not
 * take them: a team's answers belong to the run they were given to (documentation/human.md).
 */
export const HUMAN_NODE_KINDS: readonly string[] = ["hint", "steer"];

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists problems (
  problem_id text primary key, claim_id text not null, target text not null,
  source_json text not null, domain_json text not null, seq integer not null,
  outcome text, reason text, finished_seq integer);
create table if not exists claims (
  claim_id text primary key, statement_id text not null, statement text not null,
  origin text not null, status text not null, created_seq integer not null, updated_seq integer not null,
  gloss text, domain_json text, kind text not null, parent_id text, header text, earlier_status text);
create index if not exists claims_by_statement on claims (statement_id);
create index if not exists claims_by_parent on claims (parent_id);
create table if not exists attempts (
  attempt_id text primary key, claim_id text not null, prover text not null, iteration integer not null,
  model text not null, outcome text, failure_class text, stopped_by text, error text, usd real, input_tokens integer,
  output_tokens integer, duration_ms integer, turns integer, started_seq integer not null, finished_seq integer,
  role text, declared_strategy text, subgoal text, strategy text, premises_json text, failure_detail text,
  task_id text, site text, charged_usd real not null default 0, charged_input_tokens integer not null default 0,
  charged_output_tokens integer not null default 0, charged_requests integer not null default 0, carry_json text,
  provenance_json text, included_json text, withheld_json text, epoch integer not null default 0,
  settings_json text, exploration integer, runs_ago integer not null default 0);
create index if not exists attempts_by_claim on attempts (claim_id);
create index if not exists attempts_by_task on attempts (task_id);
create table if not exists tool_runs (
  tool_run_id text primary key, attempt_id text, capability text not null, implementation text not null,
  version text not null, input_hash text not null, outcome text, duration_ms integer,
  started_seq integer not null, finished_seq integer);
create index if not exists tool_runs_by_attempt on tool_runs (attempt_id);
create table if not exists lessons (
  seq integer primary key, attempt_id text not null, claim_id text not null, text text not null,
  provenance_json text, epoch integer not null default 0);
create index if not exists lessons_by_claim on lessons (claim_id);
create table if not exists validations (
  validation_id text primary key, claim_id text not null, attempt_id text, method text not null, verdict text not null,
  reasons_json text not null, axioms_json text not null, submission_hash text not null, seq integer not null,
  negation integer not null, problem_id text, carried integer not null default 1);
create table if not exists edges (
  edge_id text primary key, kind text not null, from_id text not null, status text not null, attempt_id text,
  tool_run_id text, validation_id text, note text, link_name text, link_statement text,
  created_seq integer not null, updated_seq integer not null, earlier_status text);
create index if not exists edges_by_from on edges (from_id);
create table if not exists edge_targets (
  edge_id text not null, position integer not null, to_id text not null, primary key (edge_id, position));
create index if not exists edge_targets_by_to on edge_targets (to_id);
create table if not exists nodes (
  node_id text primary key, kind text not null, claim_id text, data_json text not null,
  created_seq integer not null, updated_seq integer not null, provenance_json text, epoch integer not null default 0);
create index if not exists nodes_by_kind on nodes (kind, claim_id);
create table if not exists model_calls (
  model_call_id text primary key, line text not null, problem_id text, attempt_id text, model text not null,
  outcome text not null, usd real not null, input_tokens integer not null, output_tokens integer not null,
  duration_ms integer not null, seq integer not null, site text);
create index if not exists model_calls_by_problem on model_calls (problem_id);
create table if not exists tasks (
  task_id text primary key, kind text not null, problem_id text, claim_id text, edge_id text, owner text,
  acceptance_json text not null, budget_json text not null, depends_on_json text not null, parent_task_id text,
  proposed_by text, title text, status text not null, reason text, blocked_by_json text,
  created_seq integer not null, updated_seq integer not null, running_seq integer);
create index if not exists tasks_by_problem on tasks (problem_id);
create table if not exists task_routes (
  seq integer primary key, task_id text not null, action text not null, signal_type text not null,
  signal_value text not null, reason text not null, attempt_id text, node_id text);
create index if not exists task_routes_by_task on task_routes (task_id);
create table if not exists resumptions (seq integer primary key, resumption integer not null, data_json text not null);
create table if not exists epochs (
  epoch integer primary key, seq integer not null, reason text not null, changes_json text not null, provenance_json text not null);
create table if not exists attempt_items (
  attempt_id text not null, item_id text not null, included integer not null, epoch integer not null, primary key (attempt_id, item_id));
create index if not exists attempt_items_by_item on attempt_items (item_id);
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
  /** Set while the events of an earlier journal are applied: whether that journal's statuses carry. */
  private inherit: { carried: boolean; ago: number } | undefined;

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

  /** The hash of the chain of earlier journals this projection was built on; undefined: none. */
  chainHash(): string | undefined {
    return this.meta("chain_hash");
  }

  /**
   * Replays the journals a run starts on, oldest first, before the run's own events (documentation/memory.md,
   * "Memory across runs"). Their events get negative numbers (the last is -1), so the run's own seqs, and
   * everything that compares them, are what they would be without a chain. Only for a projection that is
   * empty. Of an earlier journal, the claims, attempts, tool runs, lessons, validations, edges, nodes and
   * epochs are kept; its problems, tasks, resumptions and model calls are not (they are that run's
   * own); a journal recorded in another Lean environment keeps no claim or edge status and no validation
   * that counts (`ChainSegment.carried`).
   */
  attachChain(chain: MemoryChain): void {
    if (this.lastSeq() >= 0 || this.chainHash() !== undefined) throw new Error("a chain of journals attaches to an empty projection only");
    let seq = -chain.segments.reduce((n, segment) => n + segment.events.length, 0);
    this.db.exec("begin");
    try {
      for (const [index, segment] of chain.segments.entries()) {
        // How many runs before the one being written this journal is: the last of the chain is 1.
        this.inherit = { carried: segment.carried, ago: chain.segments.length - index };
        for (const event of segment.events) this.applyUnchecked({ ...event, seq: seq++ } as HarnessEvent);
      }
      this.setMeta("chain_hash", chain.hash);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    } finally {
      this.inherit = undefined;
    }
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
    const inherit = this.inherit;
    // What an earlier run did on its own account is not this run's: its problems, tasks, resumptions and spend.
    if (inherit !== undefined && INHERITED_SKIPPED.includes(event.type)) return;
    const kept = inherit !== undefined && !inherit.carried;
    const insert = inherit !== undefined ? "insert or ignore" : "insert";
    switch (event.type) {
      case "run.started":
      case "run.finished":
        return;
      case "turn.started":
        this.setMeta("turn_started", String(event.data.turn));
        return;
      case "turn.ended":
        this.setMeta("turn_ended", String(event.data.turn));
        return;
      case "run.resumed": {
        db.prepare("insert into resumptions (seq, resumption, data_json) values (?, ?, ?)").run(
          event.seq, event.data.resumption, canonicalJson(event.data));
        return;
      }
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
          `${insert} into claims (claim_id, statement_id, statement, origin, status, created_seq, updated_seq, gloss, domain_json,
           kind, parent_id, header) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.claimId, d.statementId, d.statement, d.origin, d.status, event.seq, event.seq, d.gloss ?? null,
          d.domain === undefined ? null : canonicalJson(d.domain), d.kind ?? "formal", d.parentId ?? null, d.header ?? null);
        return;
      }
      case "claim.status_changed": {
        const d = event.data;
        // Another Lean environment: the status the earlier run reached is remembered, and counts for nothing.
        if (kept) db.prepare("update claims set earlier_status = ? where claim_id = ?").run(d.to, d.claimId);
        else db.prepare("update claims set status = ?, updated_seq = ? where claim_id = ?").run(d.to, event.seq, d.claimId);
        return;
      }
      case "attempt.started": {
        const d = event.data;
        const epoch = this.currentEpoch();
        db.prepare(
          `insert into attempts (attempt_id, claim_id, prover, iteration, model, started_seq, role, declared_strategy, subgoal,
           task_id, site, provenance_json, included_json, withheld_json, epoch, settings_json, exploration, runs_ago)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.attemptId, d.claimId, d.prover, d.iteration, d.model, event.seq, d.role ?? null, d.strategy ?? null, d.subgoal ?? null,
          // The tasks of an earlier run are not in this ledger: its attempts belong to none of this run's.
          inherit !== undefined ? null : (d.taskId ?? null), d.site ?? null, d.provenance === undefined ? null : canonicalJson(d.provenance),
          d.included === undefined ? null : canonicalJson(d.included), d.withheld === undefined ? null : canonicalJson(d.withheld), epoch,
          d.settings === undefined ? null : canonicalJson(d.settings), d.exploration === undefined ? null : d.exploration ? 1 : 0, inherit?.ago ?? 0);
        const item = db.prepare("insert into attempt_items (attempt_id, item_id, included, epoch) values (?, ?, ?, ?)");
        for (const id of d.included ?? []) item.run(d.attemptId, id, 1, epoch);
        for (const id of d.withheld ?? []) item.run(d.attemptId, id, 0, epoch);
        return;
      }
      case "attempt.charged": {
        const d = event.data;
        db.prepare(
          `update attempts set charged_usd = charged_usd + ?, charged_input_tokens = charged_input_tokens + ?,
           charged_output_tokens = charged_output_tokens + ?, charged_requests = charged_requests + 1 where attempt_id = ?`,
        ).run(d.usd, d.inputTokens, d.outputTokens, d.attemptId);
        return;
      }
      case "attempt.finished": {
        const d = event.data;
        db.prepare(
          `update attempts set outcome = ?, failure_class = ?, stopped_by = ?, error = ?, usd = ?, input_tokens = ?,
           output_tokens = ?, duration_ms = ?, turns = ?, finished_seq = ?, strategy = ?, premises_json = ?, failure_detail = ?,
           declared_strategy = coalesce(?, declared_strategy), carry_json = ?
           where attempt_id = ?`,
        ).run(
          d.outcome, d.failureClass ?? null, d.stoppedBy ?? null, d.error ?? null, d.usd, d.inputTokens, d.outputTokens,
          d.durationMs, d.turns, event.seq, d.strategy ?? null, d.premises === undefined ? null : canonicalJson(d.premises),
          d.failureDetail ?? null, d.declaredStrategy ?? null, d.carry === undefined ? null : canonicalJson(d.carry), d.attemptId);
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
        db.prepare("insert into lessons (seq, attempt_id, claim_id, text, provenance_json, epoch) values (?, ?, ?, ?, ?, ?)").run(
          event.seq, d.attemptId, d.claimId, d.text, d.provenance === undefined ? null : canonicalJson(d.provenance), this.currentEpoch());
        return;
      }
      case "validation.finished": {
        const d = event.data;
        db.prepare(
          `insert into validations (validation_id, claim_id, attempt_id, method, verdict, reasons_json, axioms_json,
           submission_hash, seq, negation, problem_id, carried) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.validationId, d.claimId, d.attemptId ?? null, d.method, d.verdict, canonicalJson(d.reasons),
          canonicalJson(d.axioms), d.submissionHash, event.seq, d.negation === true ? 1 : 0,
          // The problems of an earlier run are not this run's: a problem's checks are its own run's.
          inherit !== undefined ? null : (d.problemId ?? null), kept ? 0 : 1);
        return;
      }
      case "edge.added": {
        const d = event.data;
        db.prepare(
          `${insert} into edges (edge_id, kind, from_id, status, attempt_id, tool_run_id, validation_id, note, link_name,
           link_statement, created_seq, updated_seq, earlier_status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.edgeId, d.kind, d.from, kept ? "proposed" : d.status, d.attemptId ?? null, d.toolRunId ?? null, d.validationId ?? null, d.note ?? null,
          d.link?.name ?? null, d.link?.statement ?? null, event.seq, event.seq, kept && d.status !== "proposed" ? d.status : null);
        const target = db.prepare(`${insert} into edge_targets (edge_id, position, to_id) values (?, ?, ?)`);
        d.to.forEach((to, position) => target.run(d.edgeId, position, to));
        return;
      }
      case "edge.status_changed": {
        const d = event.data;
        if (kept) db.prepare("update edges set earlier_status = ? where edge_id = ?").run(d.to === "proposed" ? null : d.to, d.edgeId);
        else db.prepare("update edges set status = ?, validation_id = ?, updated_seq = ? where edge_id = ?").run(d.to, d.validationId ?? null, event.seq, d.edgeId);
        return;
      }
      case "node.recorded": {
        const d = event.data;
        if (inherit !== undefined && HUMAN_NODE_KINDS.includes(d.kind)) return;
        db.prepare(
          `${insert} into nodes (node_id, kind, claim_id, data_json, created_seq, updated_seq, provenance_json, epoch) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.nodeId, d.kind, d.claimId ?? null, canonicalJson(d.data), event.seq, event.seq,
          d.provenance === undefined ? null : canonicalJson(d.provenance), this.currentEpoch());
        return;
      }
      case "node.updated": {
        const d = event.data;
        const row = db.prepare("select data_json from nodes where node_id = ?").get(d.nodeId) as { data_json: string } | undefined;
        if (row === undefined && inherit !== undefined) return;
        if (row === undefined) throw new Error(`unknown node ${d.nodeId}`);
        const data = mergePatch(JSON.parse(row.data_json) as Json, d.patch);
        db.prepare("update nodes set data_json = ?, updated_seq = ? where node_id = ?").run(canonicalJson(data), event.seq, d.nodeId);
        return;
      }
      case "model_call.finished": {
        const d = event.data;
        db.prepare(
          `insert into model_calls (model_call_id, line, problem_id, attempt_id, model, outcome, usd, input_tokens,
           output_tokens, duration_ms, seq, site) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.modelCallId, d.line, d.problemId ?? null, d.attemptId ?? null, d.model, d.outcome, d.usd, d.inputTokens,
          d.outputTokens, d.durationMs, event.seq, d.site ?? null);
        return;
      }
      case "task.created": {
        const d = event.data;
        db.prepare(
          `insert into tasks (task_id, kind, problem_id, claim_id, edge_id, owner, acceptance_json, budget_json, depends_on_json,
           parent_task_id, proposed_by, title, status, created_seq, updated_seq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          d.taskId, d.kind, d.problemId ?? null, d.claimId ?? null, d.edgeId ?? null, d.owner ?? null, canonicalJson(d.acceptance),
          canonicalJson(d.budget), canonicalJson(d.dependsOn), d.parentTaskId ?? null, d.proposedBy ?? null, d.title ?? null,
          event.seq, event.seq);
        return;
      }
      case "task.assigned": {
        const d = event.data;
        db.prepare("update tasks set owner = ?, updated_seq = ? where task_id = ?").run(d.owner, event.seq, d.taskId);
        return;
      }
      case "task.status_changed": {
        const d = event.data;
        db.prepare(
          `update tasks set status = ?, reason = ?, blocked_by_json = ?, updated_seq = ?,
           running_seq = case when ? = 'running' then ? else running_seq end where task_id = ?`,
        ).run(
          d.to, d.reason, d.to === "blocked" && d.blockedBy !== undefined ? canonicalJson(d.blockedBy) : null, event.seq, d.to,
          event.seq, d.taskId);
        return;
      }
      case "memory.epoch_opened": {
        const d = event.data;
        db.prepare("insert into epochs (epoch, seq, reason, changes_json, provenance_json) values (?, ?, ?, ?, ?)").run(
          d.epoch, event.seq, d.reason, canonicalJson(d.changes), canonicalJson(d.provenance));
        return;
      }
      case "task.routed": {
        const d = event.data;
        db.prepare(
          `insert into task_routes (seq, task_id, action, signal_type, signal_value, reason, attempt_id, node_id)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(event.seq, d.taskId, d.action, d.signal.type, d.signal.value, d.reason, d.attemptId ?? null, d.nodeId ?? null);
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
    const rows = this.db.prepare("select * from lessons where claim_id = ? order by seq").all(claimId) as unknown as StoredLesson[];
    return rows.map(lessonRow);
  }

  /** The memory's current epoch: 0 until a `memory.epoch_opened`, then the last one's number. */
  currentEpoch(): number {
    const row = this.db.prepare("select max(epoch) as epoch from epochs").get() as { epoch: number | null };
    return row.epoch ?? 0;
  }

  /** The epochs the memory entered, in order (epoch 0 is not among them). */
  epochs(): EpochRow[] {
    const rows = this.db.prepare("select * from epochs order by epoch").all() as unknown as Array<{
      epoch: number; seq: number; reason: string; changes_json: string; provenance_json: string;
    }>;
    return rows.map((r) => ({
      epoch: r.epoch, seq: r.seq, reason: r.reason,
      changes: JSON.parse(r.changes_json) as EpochChange[], provenance: JSON.parse(r.provenance_json) as Provenance,
    }));
  }

  /**
   * The attempts a memory item was offered to by a draw, with whether the draw included it, in the
   * order they started.
   */
  itemAttempts(itemId: string): ItemAttemptRow[] {
    const rows = this.db.prepare(
      `select attempts.*, attempt_items.included as item_included from attempt_items join attempts using (attempt_id)
       where attempt_items.item_id = ? order by attempts.started_seq`,
    ).all(itemId) as unknown as Array<StoredAttempt & { item_included: number }>;
    return rows.map(({ item_included, ...row }) => ({ attempt: attemptRow(row), included: item_included === 1 }));
  }

  /** The attempts that included a memory item since the epoch `since` (default: all of them): its uses. */
  itemUses(itemId: string, since = 0): number {
    const row = this.db.prepare("select count(*) as n from attempt_items where item_id = ? and included = 1 and epoch >= ?").get(itemId, since) as { n: number };
    return row.n;
  }

  /** A validation that counts: this run's, or an earlier run's in the same Lean environment. */
  validation(validationId: string): ValidationRow | undefined {
    const row = this.db.prepare("select * from validations where validation_id = ? and carried = 1").get(validationId) as StoredValidation | undefined;
    return row === undefined ? undefined : validationRow(row);
  }

  /** The validations of a claim that count, in order. */
  validations(claimId: string): ValidationRow[] {
    const rows = this.db.prepare("select * from validations where claim_id = ? and carried = 1 order by seq").all(claimId) as unknown as StoredValidation[];
    return rows.map(validationRow);
  }

  /** A validation of an earlier run in another Lean environment: it counts for nothing, and a stored proof of it has to pass `validate` again. */
  earlierValidation(validationId: string): ValidationRow | undefined {
    const row = this.db.prepare("select * from validations where validation_id = ? and carried = 0").get(validationId) as StoredValidation | undefined;
    return row === undefined ? undefined : validationRow(row);
  }

  /** The claim's validations that do not count (`earlierValidation`), in order. */
  earlierValidations(claimId: string): ValidationRow[] {
    const rows = this.db.prepare("select * from validations where claim_id = ? and carried = 0 order by seq").all(claimId) as unknown as StoredValidation[];
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

  task(taskId: string): TaskRow | undefined {
    const row = this.db.prepare("select * from tasks where task_id = ?").get(taskId) as StoredTask | undefined;
    return row === undefined ? undefined : taskRow(row);
  }

  /** The tasks that meet every criterion of the filter, in the order they were made. */
  tasks(filter: TaskFilter = {}): TaskRow[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [column, value] of [["problem_id", filter.problemId], ["claim_id", filter.claimId], ["owner", filter.owner]] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      values.push(value);
    }
    for (const [column, list] of [["status", filter.statuses], ["kind", filter.kinds]] as const) {
      if (list === undefined) continue;
      where.push(`${column} in (${list.map(() => "?").join(", ") || "null"})`);
      values.push(...list);
    }
    const sql = `select * from tasks${where.length > 0 ? ` where ${where.join(" and ")}` : ""} order by created_seq`;
    return (this.db.prepare(sql).all(...values) as unknown as StoredTask[]).map(taskRow);
  }

  /** The routing decisions about a task (every task, without an id), in order. */
  taskRoutes(taskId?: string): TaskRouteRow[] {
    return (
      taskId === undefined
        ? this.db.prepare("select * from task_routes order by seq").all()
        : this.db.prepare("select * from task_routes where task_id = ? order by seq").all(taskId)
    ) as unknown as TaskRouteRow[];
  }

  /** The times the run was resumed, in order. */
  resumptions(): ResumptionRow[] {
    const rows = this.db.prepare("select * from resumptions order by seq").all() as unknown as Array<{ seq: number; resumption: number; data_json: string }>;
    return rows.map((r) => ({ seq: r.seq, resumption: r.resumption, data: JSON.parse(r.data_json) as EventDataMap["run.resumed"] }));
  }

  /** The turns of a consortium run: how many began and how many ended (0 and 0 for a run that has none). */
  turns(): { started: number; ended: number } {
    return { started: Number(this.meta("turn_started") ?? 0), ended: Number(this.meta("turn_ended") ?? 0) };
  }

  /** The seq of the last `run.resumed`, or -1 if the run was never resumed. */
  lastResumedSeq(): number {
    const row = this.db.prepare("select max(seq) as seq from resumptions").get() as { seq: number | null };
    return row.seq ?? -1;
  }

  /** The attempts that worked for a task, in order. */
  attemptsOfTask(taskId: string): AttemptRow[] {
    const rows = this.db.prepare("select * from attempts where task_id = ? order by started_seq").all(taskId) as unknown as StoredAttempt[];
    return rows.map(attemptRow);
  }

  /** The attempts that started and have no end: the ones a crash cut. */
  openAttempts(): AttemptRow[] {
    const rows = this.db.prepare("select * from attempts where finished_seq is null and started_seq >= 0 order by started_seq").all() as unknown as StoredAttempt[];
    return rows.map(attemptRow);
  }

  /** The tool runs that started and have no end. */
  openToolRuns(): ToolRunRow[] {
    return this.db.prepare("select * from tool_runs where finished_seq is null and started_seq >= 0 order by started_seq").all() as unknown as ToolRunRow[];
  }

  /** The model calls the lines made for a problem, in order. */
  modelCallsOfProblem(problemId: string): ModelCallRow[] {
    return this.db.prepare("select * from model_calls where problem_id = ? order by seq").all(problemId) as unknown as ModelCallRow[];
  }

  /** The claims that any attempt of the run worked for, in the order the first one started. */
  claimsWithAttempts(): string[] {
    const rows = this.db.prepare("select claim_id from attempts where started_seq >= 0 group by claim_id order by min(started_seq)").all() as unknown as Array<{ claim_id: string }>;
    return rows.map((row) => row.claim_id);
  }

  /** The problem's checks that were made by its workbench, in order. */
  validationsOfProblem(problemId: string): ValidationRow[] {
    const rows = this.db.prepare("select * from validations where problem_id = ? order by seq").all(problemId) as unknown as StoredValidation[];
    return rows.map(validationRow);
  }

  /**
   * What the attempts and the model calls for a problem cost: the attempts of its tasks, whether or
   * not they finished (a session that never ended costs what its responses did), and the model
   * calls its lines made.
   */
  problemSpend(problemId: string): Spend {
    return this.spend(
      { from: "attempts join tasks using (task_id) where tasks.problem_id = ?", params: [problemId] },
      { from: "model_calls where problem_id = ?", params: [problemId] },
    );
  }

  /** What one task's attempts cost. */
  taskSpend(taskId: string): Spend {
    return this.spend({ from: "attempts where task_id = ?", params: [taskId] });
  }

  /** What the whole run cost so far: every attempt and every model call. */
  totalSpend(): Spend {
    return this.spend({ from: "attempts where started_seq >= 0", params: [] }, { from: "model_calls", params: [] });
  }

  private spend(attempts: { from: string; params: SQLInputValue[] }, calls?: { from: string; params: SQLInputValue[] }): Spend {
    const a = this.db.prepare(
      `select coalesce(sum(coalesce(attempts.usd, attempts.charged_usd)), 0) as usd,
       coalesce(sum(coalesce(attempts.input_tokens, attempts.charged_input_tokens)), 0) as input_tokens,
       coalesce(sum(coalesce(attempts.output_tokens, attempts.charged_output_tokens)), 0) as output_tokens,
       coalesce(sum(coalesce(attempts.turns, attempts.charged_requests)), 0) as requests from ${attempts.from}`,
    ).get(...attempts.params) as { usd: number; input_tokens: number; output_tokens: number; requests: number };
    const m =
      calls === undefined
        ? { usd: 0, input_tokens: 0, output_tokens: 0, requests: 0 }
        : (this.db.prepare(
            `select coalesce(sum(usd), 0) as usd, coalesce(sum(input_tokens), 0) as input_tokens,
             coalesce(sum(output_tokens), 0) as output_tokens, count(*) as requests from ${calls.from}`,
          ).get(...calls.params) as { usd: number; input_tokens: number; output_tokens: number; requests: number });
    return {
      usd: a.usd + m.usd,
      inputTokens: a.input_tokens + m.input_tokens,
      outputTokens: a.output_tokens + m.output_tokens,
      requests: a.requests + m.requests,
    };
  }

  /**
   * What each site of the harness spent (documentation/ledger.md, "Sites"): the sessions of the
   * provers under their attempts' site (`prover.session`), the lines' one-shot calls under theirs;
   * a call from a journal older than the tags is `unknown`. The biggest spender first.
   */
  spendBySite(): SiteSpend[] {
    const sites = new Map<string, SiteSpend>();
    const add = (site: string, usd: number, inputTokens: number, outputTokens: number, requests: number) => {
      const entry = sites.get(site) ?? { site, usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      entry.usd += usd;
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.requests += requests;
      sites.set(site, entry);
    };
    const attempts = this.db.prepare(
      `select coalesce(site, ?) as site, coalesce(sum(coalesce(usd, charged_usd)), 0) as usd,
       coalesce(sum(coalesce(input_tokens, charged_input_tokens)), 0) as input_tokens,
       coalesce(sum(coalesce(output_tokens, charged_output_tokens)), 0) as output_tokens,
       coalesce(sum(coalesce(turns, charged_requests)), 0) as requests from attempts where started_seq >= 0 group by 1`,
    ).all(SITE_PROVER_SESSION) as unknown as Array<{ site: string; usd: number; input_tokens: number; output_tokens: number; requests: number }>;
    for (const r of attempts) add(r.site, r.usd, r.input_tokens, r.output_tokens, r.requests);
    const calls = this.db.prepare(
      `select coalesce(site, 'unknown') as site, coalesce(sum(usd), 0) as usd, coalesce(sum(input_tokens), 0) as input_tokens,
       coalesce(sum(output_tokens), 0) as output_tokens, count(*) as requests from model_calls group by 1`,
    ).all() as unknown as Array<{ site: string; usd: number; input_tokens: number; output_tokens: number; requests: number }>;
    for (const r of calls) add(r.site, r.usd, r.input_tokens, r.output_tokens, r.requests);
    return [...sites.values()].sort((x, y) => y.usd - x.usd || x.site.localeCompare(y.site));
  }

  /**
   * Counts and costs of the run: the attempts' and the lines' model calls. Of the earlier journals a run
   * started on, nothing is counted: a claim whose status carried from one is counted for a problem only
   * when that problem's own certification (`kernel_replay`, valid) of it is in this journal, so a problem's
   * outcome comes from its own run (Ruling 23).
   */
  runSummary(): RunSummary {
    const p = this.db.prepare("select count(*) as n from problems").get() as { n: number };
    const byStatus = (status: string, own: string) =>
      (this.db.prepare(
        `select count(*) as n from problems join claims using (claim_id) where claims.status = ? and (claims.updated_seq >= 0 or exists (
           select 1 from validations v where v.problem_id = problems.problem_id and v.claim_id = claims.claim_id and v.verdict = 'valid' and ${own}))`,
      ).get(status) as { n: number }).n;
    const attempts = (this.db.prepare("select count(*) as n from attempts where started_seq >= 0").get() as { n: number }).n;
    const total = this.totalSpend();
    return {
      problems: p.n,
      solved: byStatus("proved", "v.method = 'kernel_replay' and v.negation = 0"),
      refuted: byStatus("refuted", "v.method = 'kernel_replay' and v.negation = 1"),
      candidates: byStatus("computed", "v.negation = 0"),
      attempts,
      usd: total.usd,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
    };
  }

  /** What the run took from the journals it started on (all zeros for a run that started on none). */
  memorySummary(): MemorySummary {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const carried: Record<string, number> = {};
    const byStatus = this.db.prepare(
      "select status, count(*) as n from claims where created_seq < 0 and updated_seq < 0 and status != 'open' group by status order by status",
    ).all() as unknown as Array<{ status: string; n: number }>;
    for (const row of byStatus) carried[row.status] = row.n;
    return {
      claims: count("select count(*) as n from claims where created_seq < 0"),
      carried,
      reset: count("select count(*) as n from claims where created_seq < 0 and earlier_status is not null and earlier_status != 'open'"),
      attempts: count("select count(*) as n from attempts where started_seq < 0"),
      toolRuns: count("select count(*) as n from tool_runs where started_seq < 0"),
      lessons: count("select count(*) as n from lessons where seq < 0"),
      nodes: count("select count(*) as n from nodes where created_seq < 0"),
      edges: count("select count(*) as n from edges where created_seq < 0"),
      edgesReset: count("select count(*) as n from edges where created_seq < 0 and earlier_status is not null"),
      validations: {
        carried: count("select count(*) as n from validations where seq < 0 and carried = 1"),
        notCarried: count("select count(*) as n from validations where seq < 0 and carried = 0"),
      },
      epochs: count("select count(*) as n from epochs where seq < 0"),
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

type StoredAttempt = Omit<AttemptRow, "premises" | "carry" | "provenance" | "included" | "withheld" | "settings" | "exploration"> & {
  premises_json: string | null;
  carry_json: string | null;
  provenance_json: string | null;
  included_json: string | null;
  withheld_json: string | null;
  settings_json: string | null;
  exploration: number | null;
};

function attemptRow({ premises_json, carry_json, provenance_json, included_json, withheld_json, settings_json, exploration, ...rest }: StoredAttempt): AttemptRow {
  return {
    ...rest,
    settings: settings_json === null ? null : (JSON.parse(settings_json) as { [key: string]: Json }),
    exploration: exploration === null ? null : exploration === 1,
    premises: premises_json === null ? null : (JSON.parse(premises_json) as string[]),
    carry: carry_json === null ? null : (JSON.parse(carry_json) as AttemptCarry),
    provenance: provenance_json === null ? null : (JSON.parse(provenance_json) as Provenance),
    included: included_json === null ? null : (JSON.parse(included_json) as string[]),
    withheld: withheld_json === null ? null : (JSON.parse(withheld_json) as string[]),
  };
}

type StoredLesson = Omit<LessonRow, "provenance"> & { provenance_json: string | null };

function lessonRow({ provenance_json, ...rest }: StoredLesson): LessonRow {
  return { ...rest, provenance: provenance_json === null ? null : (JSON.parse(provenance_json) as Provenance) };
}

type StoredTask = Omit<TaskRow, "acceptance" | "budget" | "depends_on" | "blocked_by"> & {
  acceptance_json: string;
  budget_json: string;
  depends_on_json: string;
  blocked_by_json: string | null;
};

function taskRow({ acceptance_json, budget_json, depends_on_json, blocked_by_json, ...rest }: StoredTask): TaskRow {
  return {
    ...rest,
    acceptance: JSON.parse(acceptance_json) as TaskAcceptance,
    budget: JSON.parse(budget_json) as TaskBudget,
    depends_on: JSON.parse(depends_on_json) as string[],
    blocked_by: blocked_by_json === null ? null : (JSON.parse(blocked_by_json) as string[]),
  };
}

type StoredValidation = Omit<ValidationRow, "reasons" | "axioms" | "negation" | "carried"> & {
  reasons_json: string;
  axioms_json: string;
  negation: number;
  carried: number;
};

function validationRow({ reasons_json, axioms_json, negation, carried, ...rest }: StoredValidation): ValidationRow {
  return { ...rest, reasons: JSON.parse(reasons_json) as string[], axioms: JSON.parse(axioms_json) as string[], negation: negation === 1, carried: carried === 1 };
}

type StoredEdge = Omit<EdgeRow, "to">;

type StoredNode = Omit<NodeRow, "data" | "provenance"> & { data_json: string; provenance_json: string | null };

function nodeRow({ data_json, provenance_json, ...rest }: StoredNode): NodeRow {
  return { ...rest, data: JSON.parse(data_json) as Json, provenance: provenance_json === null ? null : (JSON.parse(provenance_json) as Provenance) };
}
