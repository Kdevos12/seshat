import {
  type AttemptOutcome,
  type AttemptRole,
  type AttemptRow,
  type BlobStore,
  type ClaimKind,
  type ClaimRow,
  type ClaimStatus,
  EDGE_STATUSES,
  type EdgeKind,
  type EdgeLink,
  type EdgeRow,
  type EdgeStatus,
  edgeStatusRank,
  type Journal,
  type Json,
  newId,
  type NodeRow,
  type ValidationRow,
} from "@seshat/core";
import { type StatementContext, type StatementIdentity, TextIdentity } from "./identity.ts";
import { type ClaimReference, claimReference, claimTheoremName, negationReference } from "./reference.ts";

export interface MemoryStoreOptions {
  journal: Journal;
  /** The run's blob store, for contents too large for an event (a node's data can name a blob by its hash). */
  blobs: BlobStore;
  /** Default: `TextIdentity`. */
  identity?: StatementIdentity;
  /** Who the events are from. Default: `memory`. */
  actor?: string;
}

export interface ClaimInput {
  /** Signature form for a formal claim (`(n : ℕ) : n + 0 = n`), prose for an informal one. */
  statement: string;
  /** The imports, `open`s and definitions the statement needs. */
  header?: string;
  /** Where the claim comes from: `bench:<id>`, `line:M1`, a capability... */
  origin: string;
  gloss?: string;
  domain?: string[];
  /** Default `formal`. */
  kind?: ClaimKind;
  parentId?: string;
}

export interface EnsuredClaim {
  claimId: string;
  statementId: string;
  /** False when a claim with this statement id existed: its id is returned, and its fields stand. */
  created: boolean;
}

export interface Claim {
  claimId: string;
  statementId: string;
  statement: string;
  origin: string;
  status: ClaimStatus;
  kind: ClaimKind;
  domain: string[];
  gloss?: string;
  parentId?: string;
  header?: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface EdgeInput {
  kind: EdgeKind;
  from: string;
  /** One id, or the parts of a `decomposes_into`. */
  to: string | readonly string[];
  /** Default `proposed`. */
  status?: EdgeStatus;
  attemptId?: string;
  toolRunId?: string;
  validationId?: string;
  note?: string;
  link?: EdgeLink;
}

export interface Edge {
  edgeId: string;
  kind: EdgeKind;
  from: string;
  to: string[];
  status: EdgeStatus;
  attemptId?: string;
  toolRunId?: string;
  /** The validation behind the current status. */
  validationId?: string;
  note?: string;
  link?: EdgeLink;
  createdSeq: number;
  updatedSeq: number;
}

/** Which edges `edges` returns; every given criterion must hold. */
export interface EdgeQuery {
  from?: string;
  /** Edges one of whose targets is this id. */
  to?: string;
  kinds?: readonly EdgeKind[];
  /** At least this status, in the order of `edgeStatusRank` (`lean_checked` is the highest). */
  minStatus?: EdgeStatus;
}

export interface NodeInput {
  /** A short lowercase word; the package that owns the kind owns the shape of `data`. */
  kind: string;
  claimId?: string;
  data: Json;
}

export interface MemoryNode {
  nodeId: string;
  kind: string;
  claimId?: string;
  /** The recorded data with every update's patch applied, in order. */
  data: Json;
  createdSeq: number;
  updatedSeq: number;
}

export interface Attempt {
  attemptId: string;
  claimId: string;
  prover: string;
  iteration: number;
  model: string;
  role: AttemptRole;
  /** The strategy given or declared when it started. */
  declaredStrategy?: string;
  subgoal?: string;
  /** Absent while the attempt runs. */
  outcome?: AttemptOutcome;
  failureClass?: string;
  stoppedBy?: string;
  error?: string;
  /** The strategy classified when it finished. */
  strategy?: string;
  premises?: string[];
  failureDetail?: string;
  usd?: number;
  turns?: number;
  durationMs?: number;
  startedSeq: number;
  finishedSeq?: number;
}

export interface Validation {
  validationId: string;
  claimId: string;
  attemptId?: string;
  method: "repl" | "kernel_replay";
  verdict: "valid" | "invalid";
  reasons: string[];
  axioms: string[];
  submissionHash: string;
  /** True for a proof of the claim's negation. */
  negation: boolean;
  seq: number;
}

/**
 * The memory of a run (plan §2): claims, the edges between them and the other records (nodes), over
 * the run's journal, blob store and projection. Every write is one journal event, checked by the
 * journal's invariants; every read comes from the projection. It is the one way mechanisms read and
 * write the memory.
 *
 * The journal is a private field, in the store and in every view `withActor` makes: a line that is
 * given a store cannot emit an event of its own, so the trust rules (which statuses an event may
 * set, and on what evidence) hold by construction and not by convention. A write that a task needs
 * gets a narrow method here, never a raw `emit`.
 */
export class MemoryStore {
  readonly blobs: BlobStore;
  readonly identity: StatementIdentity;
  readonly actor: string;
  readonly #journal: Journal;
  /** Shared by the views `withActor` makes. */
  #references: Map<string, ClaimReference>;

  constructor(options: MemoryStoreOptions) {
    this.#journal = options.journal;
    this.blobs = options.blobs;
    this.identity = options.identity ?? new TextIdentity();
    this.actor = options.actor ?? "memory";
    this.#references = new Map();
  }

  /** The same store, writing as another actor (`line:M1`...). */
  withActor(actor: string): MemoryStore {
    const view = new MemoryStore({ journal: this.#journal, blobs: this.blobs, identity: this.identity, actor });
    view.#references = this.#references;
    return view;
  }

  /**
   * The claim of a statement: the existing claim with the same statement id, or a new one ("same
   * hash, same claim", plan §3.1). The first claim of a statement keeps its fields.
   */
  async ensureClaim(input: ClaimInput): Promise<EnsuredClaim> {
    if (input.statement.trim() === "") throw new Error("ensureClaim: the statement is empty");
    const context: StatementContext = {
      ...(input.header !== undefined ? { header: input.header } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    };
    const statementId = await this.identity.id(input.statement, context);
    // Looked up and written with no await in between, so two calls cannot both create the claim.
    const existing = this.#journal.projection.claimsByStatement(statementId)[0];
    if (existing !== undefined) return { claimId: existing.claim_id, statementId, created: false };
    const claimId = newId("clm");
    this.#journal.emit(
      "claim.created",
      {
        claimId,
        statementId,
        statement: input.statement,
        origin: input.origin,
        status: "open",
        ...(input.gloss !== undefined ? { gloss: input.gloss } : {}),
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.header !== undefined ? { header: input.header } : {}),
      },
      this.actor,
    );
    return { claimId, statementId, created: true };
  }

  addEdge(input: EdgeInput): Edge {
    const edgeId = newId("edg");
    this.#journal.emit(
      "edge.added",
      {
        edgeId,
        kind: input.kind,
        from: input.from,
        to: typeof input.to === "string" ? [input.to] : [...input.to],
        status: input.status ?? "proposed",
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.toolRunId !== undefined ? { toolRunId: input.toolRunId } : {}),
        ...(input.validationId !== undefined ? { validationId: input.validationId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.link !== undefined ? { link: input.link } : {}),
      },
      this.actor,
    );
    return this.edge(edgeId) as Edge;
  }

  /** Moves an edge to another status. `lean_checked` needs a valid validation of its link lemma. */
  setEdgeStatus(edgeId: string, to: EdgeStatus, options: { reason: string; validationId?: string }): Edge {
    const edge = this.edge(edgeId);
    if (edge === undefined) throw new Error(`unknown edge ${edgeId}`);
    this.#journal.emit(
      "edge.status_changed",
      {
        edgeId,
        from: edge.status,
        to,
        reason: options.reason,
        ...(options.validationId !== undefined ? { validationId: options.validationId } : {}),
      },
      this.actor,
    );
    return this.edge(edgeId) as Edge;
  }

  recordNode(input: NodeInput): MemoryNode {
    const nodeId = newId("nod");
    this.#journal.emit(
      "node.recorded",
      { nodeId, kind: input.kind, ...(input.claimId !== undefined ? { claimId: input.claimId } : {}), data: input.data },
      this.actor,
    );
    return this.node(nodeId) as MemoryNode;
  }

  /** Applies a JSON merge patch (RFC 7386) to a node's data. */
  updateNode(nodeId: string, patch: Json, reason: string): MemoryNode {
    this.#journal.emit("node.updated", { nodeId, patch, reason }, this.actor);
    return this.node(nodeId) as MemoryNode;
  }

  claim(claimId: string): Claim | undefined {
    const row = this.#journal.projection.claim(claimId);
    return row === undefined ? undefined : toClaim(row);
  }

  /** The first claim with this statement id. */
  claimByStatement(statementId: string): Claim | undefined {
    const row = this.#journal.projection.claimsByStatement(statementId)[0];
    return row === undefined ? undefined : toClaim(row);
  }

  edge(edgeId: string): Edge | undefined {
    const row = this.#journal.projection.edge(edgeId);
    return row === undefined ? undefined : toEdge(row);
  }

  /** The edges that meet every criterion, in the order they were added. */
  edges(query: EdgeQuery = {}): Edge[] {
    const minimum = query.minStatus;
    const statuses = minimum === undefined ? undefined : EDGE_STATUSES.filter((s) => edgeStatusRank(s) >= edgeStatusRank(minimum));
    return this.#journal.projection
      .edges({
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
        ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
        ...(statuses !== undefined ? { statuses } : {}),
      })
      .map(toEdge);
  }

  /**
   * The claim and every claim equivalent to it through `lean_checked` `equiv` edges, followed both
   * ways: the claim first, then the others as they are reached.
   */
  equivalents(claimId: string): string[] {
    const seen = new Set([claimId]);
    const queue = [claimId];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const around = [
        ...this.edges({ from: id, kinds: ["equiv"], minStatus: "lean_checked" }).flatMap((e) => e.to),
        ...this.edges({ to: id, kinds: ["equiv"], minStatus: "lean_checked" }).map((e) => e.from),
      ];
      for (const next of around) {
        if (seen.has(next) || this.#journal.projection.claim(next) === undefined) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return [...seen];
  }

  /** The attempts on a claim (and, if asked, on its equivalents), in the order they started. */
  attempts(claimId: string, options: { includeEquivalents?: boolean } = {}): Attempt[] {
    const claims = options.includeEquivalents === true ? this.equivalents(claimId) : [claimId];
    return claims
      .flatMap((id) => this.#journal.projection.attempts(id))
      .sort((a, b) => a.started_seq - b.started_seq)
      .map(toAttempt);
  }

  /** The validations of a claim (proofs of it and of its negation), in order. */
  validations(claimId: string): Validation[] {
    return this.#journal.projection.validations(claimId).map(toValidation);
  }

  node(nodeId: string): MemoryNode | undefined {
    const row = this.#journal.projection.node(nodeId);
    return row === undefined ? undefined : toNode(row);
  }

  /** The nodes of a kind (of one claim, if given), in the order they were recorded. */
  nodes(kind: string, options: { claimId?: string } = {}): MemoryNode[] {
    return this.#journal.projection.nodes(kind, options.claimId).map(toNode);
  }

  /**
   * Gives a claim the file its validations compare against, instead of the one made from its header
   * and statement. The orchestrator gives each problem's claim its bench file. Not journaled: the
   * file comes from the problem's source, which `problem.registered` records.
   */
  setReference(claimId: string, reference: ClaimReference): void {
    if (this.#journal.projection.claim(claimId) === undefined) throw new Error(`unknown claim ${claimId}`);
    this.#references.set(claimId, reference);
  }

  /**
   * The reference file of a claim, or of its negation: the file set with `setReference`, or else
   * `theorem <claim id> <statement> := by sorry` after the claim's header. An informal claim has none.
   */
  referenceFor(claimId: string, options: { negation?: boolean } = {}): ClaimReference {
    const claim = this.claim(claimId);
    if (claim === undefined) throw new Error(`unknown claim ${claimId}`);
    if (claim.kind === "informal") throw new Error(`claim ${claimId} is informal: it has no Lean reference`);
    const own = this.#references.get(claimId) ?? claimReference(claim.header ?? "", claimTheoremName(claimId), claim.statement);
    return options.negation === true ? negationReference(own) : own;
  }
}

/** Drops the fields that are null or undefined: rows have nulls where records have absent fields. */
function present<T extends object>(value: { [K in keyof T]: T[K] | null | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as T;
}

function toClaim(row: ClaimRow): Claim {
  return present<Claim>({
    claimId: row.claim_id,
    statementId: row.statement_id,
    statement: row.statement,
    origin: row.origin,
    status: row.status,
    kind: row.kind,
    domain: row.domain,
    gloss: row.gloss,
    parentId: row.parent_id,
    header: row.header,
    createdSeq: row.created_seq,
    updatedSeq: row.updated_seq,
  });
}

function toEdge(row: EdgeRow): Edge {
  return present<Edge>({
    edgeId: row.edge_id,
    kind: row.kind,
    from: row.from_id,
    to: row.to,
    status: row.status,
    attemptId: row.attempt_id,
    toolRunId: row.tool_run_id,
    validationId: row.validation_id,
    note: row.note,
    link: row.link_name === null || row.link_statement === null ? undefined : { name: row.link_name, statement: row.link_statement },
    createdSeq: row.created_seq,
    updatedSeq: row.updated_seq,
  });
}

function toNode(row: NodeRow): MemoryNode {
  // `data` may be null, which is a value here, not an absent field.
  return {
    ...present<Omit<MemoryNode, "data">>({
      nodeId: row.node_id,
      kind: row.kind,
      claimId: row.claim_id,
      createdSeq: row.created_seq,
      updatedSeq: row.updated_seq,
    }),
    data: row.data,
  };
}

function toAttempt(row: AttemptRow): Attempt {
  return present<Attempt>({
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    prover: row.prover,
    iteration: row.iteration,
    model: row.model,
    role: row.role ?? "prove",
    declaredStrategy: row.declared_strategy,
    subgoal: row.subgoal,
    outcome: row.outcome as AttemptOutcome | null,
    failureClass: row.failure_class,
    stoppedBy: row.stopped_by,
    error: row.error,
    strategy: row.strategy,
    premises: row.premises,
    failureDetail: row.failure_detail,
    usd: row.usd,
    turns: row.turns,
    durationMs: row.duration_ms,
    startedSeq: row.started_seq,
    finishedSeq: row.finished_seq,
  });
}

function toValidation(row: ValidationRow): Validation {
  return present<Validation>({
    validationId: row.validation_id,
    claimId: row.claim_id,
    attemptId: row.attempt_id,
    method: row.method,
    verdict: row.verdict,
    reasons: row.reasons,
    axioms: row.axioms,
    submissionHash: row.submission_hash,
    negation: row.negation,
    seq: row.seq,
  });
}
