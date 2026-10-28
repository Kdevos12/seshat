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
  epochChanges,
  type EpochChange,
  type EpochRow,
  type Journal,
  type Json,
  type LessonRow,
  newId,
  type NodeRow,
  type Provenance,
  type ProvenanceContext,
  type RandomSource,
  stampProvenance,
  type ValidationRow,
} from "@seshat/core";
import { type Draw, type DrawItem, type DrawOptions, drawItems } from "./draw.ts";
import { armOf, effectOf, type ItemEffect } from "./effect.ts";
import { DEFAULT_PROBATION, describeEpochChanges, probationWeight } from "./epochs.ts";
import { type StatementContext, type StatementIdentity, TextIdentity } from "./identity.ts";
import { type ClaimReference, claimReference, claimTheoremName, negationReference } from "./reference.ts";
import { signatureMessage } from "./signature.ts";
import { type TriedStrategy, triedStrategies } from "./tried.ts";

export interface MemoryStoreOptions {
  journal: Journal;
  /** The run's blob store, for contents too large for an event (a node's data can name a blob by its hash). */
  blobs: BlobStore;
  /** Default: `TextIdentity`. */
  identity?: StatementIdentity;
  /** Who the events are from. Default: `memory`. */
  actor?: string;
  /**
   * What the run knows of its provenance (documentation/memory.md, "Provenance and epochs"): the
   * stamp of every learned artifact the store writes, and the epoch it opens. Without it `stamp`,
   * `openEpoch` and a learned node refuse.
   */
  provenance?: ProvenanceContext;
  /** The share of an older epoch's counters that probation keeps. Default 0.25. */
  probation?: number;
  /** The clock of the stamps. Default: the system's. */
  now?: () => Date;
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
  /**
   * The status an earlier run recorded in another Lean environment. It counts for nothing: `status`
   * is what this run established (`open` until a stored proof passes `validate` again).
   */
  earlierStatus?: ClaimStatus;
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
  /** The status an earlier run recorded in another Lean environment; it counts for nothing. */
  earlierStatus?: EdgeStatus;
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
  /**
   * True for a node a mechanism learned from outcomes rather than from Lean (a lesson, a schema, a
   * channel statistic, a posterior): it is stamped with the run's provenance (Global Constraint 16).
   */
  learned?: boolean;
}

export interface MemoryNode {
  nodeId: string;
  kind: string;
  claimId?: string;
  /** The recorded data with every update's patch applied, in order. */
  data: Json;
  createdSeq: number;
  updatedSeq: number;
  /** Set on a node that was recorded `learned`. */
  provenance?: Provenance;
  /** The memory's epoch when it was recorded. */
  epoch: number;
}

/** A model's own notes of a session, kept as a lesson record (`lesson.recorded`). */
export interface Lesson {
  attemptId: string;
  claimId: string;
  text: string;
  provenance?: Provenance;
  epoch: number;
  seq: number;
}

/** An epoch the memory entered. */
export interface Epoch {
  epoch: number;
  reason: string;
  changes: EpochChange[];
  provenance: Provenance;
  seq: number;
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
  /** The stamp of the record. Absent in a journal older than the stamps. */
  provenance?: Provenance;
  /** The memory's epoch when the attempt started; absent counts as 0. */
  epoch?: number;
  /** The unverified items a draw showed the session, and the ones it withheld (absent: no draw). */
  included?: string[];
  withheld?: string[];
}

/**
 * A proof an earlier run stored under another Lean environment: its text is in the earlier run's blobs, and
 * it is a candidate for `validate` here, nothing more. Its validation counts for nothing.
 */
export interface StoredProof {
  validationId: string;
  claimId: string;
  /** True for a proof of the claim's negation. */
  negation: boolean;
  /** What the earlier run's check was. */
  method: "repl" | "kernel_replay";
  verdict: "valid" | "invalid";
  submissionHash: string;
  /** The submission's text; undefined when the blob is gone. */
  text?: string;
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
  /** The share of an older epoch's counters that probation keeps. */
  readonly probation: number;
  readonly #journal: Journal;
  readonly #provenance: ProvenanceContext | undefined;
  readonly #now: (() => Date) | undefined;
  /** Shared by the views `withActor` makes. Only the root store writes to it. */
  #references: Map<string, ClaimReference>;
  /** True for a store made by `withActor`: what a line is given. */
  #view = false;

  constructor(options: MemoryStoreOptions) {
    this.#journal = options.journal;
    this.blobs = options.blobs;
    this.identity = options.identity ?? new TextIdentity();
    this.actor = options.actor ?? "memory";
    this.probation = options.probation ?? DEFAULT_PROBATION;
    if (!(this.probation >= 0 && this.probation <= 1)) throw new RangeError(`the probation k must be between 0 and 1, got ${this.probation}`);
    this.#provenance = options.provenance;
    this.#now = options.now;
    this.#references = new Map();
  }

  /**
   * The same store, writing as another actor (`line:M1`...). A view reads the reference files of the
   * root store but cannot set one (`setReference`), nor make a view that writes as `orchestrator` or `human:*`.
   */
  withActor(actor: string): MemoryStore {
    // What a line holds is a view: it may not speak as the orchestrator or as a person, whose records the journal accepts
    // on the strength of the actor string alone (a hint, a steer, a signature, a status change).
    if (this.#view && (actor === "orchestrator" || actor.startsWith("human:"))) {
      throw new Error(`withActor: a view given to a line cannot write as "${actor}"`);
    }
    const view = new MemoryStore({
      journal: this.#journal,
      blobs: this.blobs,
      identity: this.identity,
      actor,
      probation: this.probation,
      ...(this.#provenance !== undefined ? { provenance: this.#provenance } : {}),
      ...(this.#now !== undefined ? { now: this.#now } : {}),
    });
    view.#references = this.#references;
    view.#view = true;
    return view;
  }

  /**
   * The claim of a statement: the existing claim with the same statement id, or a new one ("same
   * hash, same claim", plan §3.1). The first claim of a statement keeps its fields. A formal
   * statement must be in signature form (`signatureProblem`): a bare proposition is refused here,
   * with a message that says what to write, and not later as a reference file that does not check.
   */
  async ensureClaim(input: ClaimInput): Promise<EnsuredClaim> {
    if (input.statement.trim() === "") throw new Error("ensureClaim: the statement is empty");
    if (input.kind !== "informal") {
      const problem = signatureMessage(input.statement);
      if (problem !== undefined) throw new Error(`ensureClaim: ${problem}`);
    }
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
      {
        nodeId,
        kind: input.kind,
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
        data: input.data,
        ...(input.learned === true ? { provenance: this.stamp() } : {}),
      },
      this.actor,
    );
    return this.node(nodeId) as MemoryNode;
  }

  /**
   * The provenance stamp of an artifact made now (documentation/memory.md, "Provenance and epochs"):
   * the run's model, prompt version, Mathlib revision, harness version and budget class, and the
   * time. `modelId` names another model when the session that made the artifact ran one. A mechanism
   * that learns something from outcomes stamps it with this, whatever it stores it as.
   */
  stamp(options: { modelId?: string } = {}): Provenance {
    if (this.#provenance === undefined) throw new Error("this store has no provenance context: the run gives it one (MemoryStoreOptions.provenance)");
    return stampProvenance(this.#provenance, { ...(options.modelId !== undefined ? { modelId: options.modelId } : {}), ...(this.#now !== undefined ? { now: this.#now() } : {}) });
  }

  /** The run's provenance context, if the store was given one. */
  get provenanceContext(): ProvenanceContext | undefined {
    return this.#provenance;
  }

  /** The memory's current epoch: 0 until the first `memory.epoch_opened`. */
  epoch(): number {
    return this.#journal.projection.currentEpoch();
  }

  /** The epochs the memory entered, in order; epoch 0 is not among them. */
  epochs(): Epoch[] {
    return this.#journal.projection.epochs().map(toEpoch);
  }

  /**
   * Opens a new epoch: the unverified artifacts recorded in older epochs are in probation from now on
   * (their outcomes weigh `probation` per epoch since, `weightOf`), and nothing is deleted. The
   * journal lets only the orchestrator write the event, so a store of another actor is refused there.
   */
  openEpoch(input: { changes: readonly EpochChange[]; reason?: string }): Epoch {
    const epoch = this.epoch() + 1;
    this.#journal.emit(
      "memory.epoch_opened",
      { epoch, reason: input.reason ?? describeEpochChanges(input.changes), changes: [...input.changes], provenance: this.stamp() },
      this.actor,
    );
    return this.epochs().at(-1) as Epoch;
  }

  /**
   * Opens a new epoch when the run's provenance context differs from `previous`, the context of the
   * memory's previous run, in the prover model family, the prompts' major version or the Mathlib
   * revision (plan change PE1 item 2). Returns the epoch it opened, or undefined when none changed.
   */
  openEpochIfChanged(previous: ProvenanceContext): Epoch | undefined {
    if (this.#provenance === undefined) throw new Error("this store has no provenance context: the run gives it one (MemoryStoreOptions.provenance)");
    const changes = epochChanges(previous, this.#provenance);
    return changes.length === 0 ? undefined : this.openEpoch({ changes });
  }

  /**
   * How much an outcome recorded in epoch `epoch` weighs now: 1 in the current epoch, `probation` for
   * each epoch opened since. The counters of an unverified item are sums of these weights, so an item
   * of an older epoch is in probation and earns its standing again only through new outcomes.
   */
  weightOf(epoch: number): number {
    return probationWeight(this.epoch(), epoch, this.probation);
  }

  /**
   * Randomized inclusion (plan change PE2; documentation/memory.md, "Randomized inclusion"). Takes the
   * unverified items a line selected for a session and draws each with probability `pNew` (0.5) while it
   * has been included fewer than `nNew` (20) times in the current epoch, then `p` (0.9), from `random`,
   * the run's seeded source. Returns what to show and what to withhold; the orchestrator records the two
   * lists on `attempt.started` (`SessionContext.draw` does both). Writes nothing itself.
   *
   * A claim, whether the goal or a verified fact, and an item flagged `verified` are never drawn: they
   * come back in `fixed`, to be shown, and are in neither list.
   */
  draw(items: readonly (string | DrawItem)[], random: RandomSource, options: Partial<DrawOptions> = {}): Draw {
    const projection = this.#journal.projection;
    const epoch = projection.currentEpoch();
    return drawItems(items, random, { isFact: (id) => projection.claim(id) !== undefined, uses: (id) => projection.itemUses(id, epoch) }, options);
  }

  /** How many sessions were shown the item (it was included) since the current epoch began. */
  itemUses(itemId: string): number {
    const projection = this.#journal.projection;
    return projection.itemUses(itemId, projection.currentEpoch());
  }

  /**
   * An item's effect on the success of an attempt, as two Beta posteriors (plan change PE2 item 2):
   * the attempts whose draw included it against those whose draw withheld it, among the attempts on the
   * claims of `claimIds` (the claim group: for one claim, `equivalents(claimId)`; absent: any claim) with
   * the strategy label `strategy` (the label classified when the attempt finished, else the one declared;
   * absent: any). A proof the fast check accepted is a success and a failed check a failure; a session
   * that was cut says nothing. Each outcome counts with the probation weight of its epoch
   * (`weightOf`), so an item of an older epoch is in probation and earns its standing again only through
   * new outcomes. `P(effect < 0)` is `pNegative`; `shouldDeactivate` applies M5's rule to it.
   */
  itemEffect(itemId: string, scope: { claimIds?: readonly string[]; strategy?: string } = {}): ItemEffect {
    return this.#effects(itemId, scope).get(scope.strategy) ?? effectOf(itemId, scope, armOf(0, 0, 0), armOf(0, 0, 0));
  }

  /**
   * The same effect for each strategy label the item's attempts carry in the group, in the order of the
   * labels; attempts with no label come last under no `strategy`. Only labels with an attempt appear.
   */
  itemEffects(itemId: string, scope: { claimIds?: readonly string[] } = {}): ItemEffect[] {
    const by = this.#effects(itemId, scope, true);
    return [...by.entries()].sort(([a], [b]) => (a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : a > b ? 1 : 0)).map(([, effect]) => effect);
  }

  #effects(itemId: string, scope: { claimIds?: readonly string[]; strategy?: string }, split = false): Map<string | undefined, ItemEffect> {
    const group = scope.claimIds === undefined ? undefined : new Set(scope.claimIds);
    type Tally = { with: [number, number, number]; without: [number, number, number] };
    const tallies = new Map<string | undefined, Tally>();
    for (const { attempt, included } of this.#journal.projection.itemAttempts(itemId)) {
      if (group !== undefined && !group.has(attempt.claim_id)) continue;
      const label = attempt.strategy ?? attempt.declared_strategy ?? undefined;
      if (scope.strategy !== undefined && label !== scope.strategy) continue;
      if (attempt.outcome !== "valid" && attempt.outcome !== "invalid") continue;
      const key = split ? label : scope.strategy;
      const tally = tallies.get(key) ?? { with: [0, 0, 0], without: [0, 0, 0] };
      tallies.set(key, tally);
      const arm = included ? tally.with : tally.without;
      const weight = this.weightOf(attempt.epoch);
      if (attempt.outcome === "valid") arm[0] += weight;
      else arm[1] += weight;
      arm[2] += 1;
    }
    return new Map(
      [...tallies].map(([label, t]) => [
        label,
        effectOf(itemId, { ...(scope.claimIds !== undefined ? { claimIds: scope.claimIds } : {}), ...(label !== undefined ? { strategy: label } : {}) }, armOf(...t.with), armOf(...t.without)),
      ]),
    );
  }

  /** The lessons recorded about a claim (the models' own notes, `lesson.recorded`), in order. */
  lessons(claimId: string): Lesson[] {
    return this.#journal.projection.lessons(claimId).map(toLesson);
  }

  /** Applies a JSON merge patch (RFC 7386) to a node's data. */
  updateNode(nodeId: string, patch: Json, reason: string): MemoryNode {
    this.#journal.emit("node.updated", { nodeId, patch, reason }, this.actor);
    return this.node(nodeId) as MemoryNode;
  }

  /**
   * Withdraws a claim whose status rested on something that was retracted: a `proved`, `refuted` or
   * `proved_informal` claim becomes `retracted`, and a `computed` candidate goes back to `open`. An
   * `open` or `retracted` claim stays as it is. These are the revocation transitions of the status
   * table (`packages/core/src/status.ts`), and the method picks the lower status itself, so it
   * cannot raise a claim: a status goes up only through a validation (trust.md). It is the one
   * change of status a line may make besides `validate`, and the line M2's revocation of a claim it
   * composed (plan §3.2) is its only caller. It needs a reason, and the journal records the change
   * under the store's actor.
   */
  retractClaim(claimId: string, options: { reason: string }): Claim {
    if (options.reason.trim() === "") throw new Error(`claim ${claimId} can be retracted only with a reason`);
    const claim = this.claim(claimId);
    if (claim === undefined) throw new Error(`unknown claim ${claimId}`);
    const to: ClaimStatus | undefined =
      claim.status === "computed" ? "open" : claim.status === "open" || claim.status === "retracted" ? undefined : "retracted";
    if (to !== undefined) {
      this.#journal.emit("claim.status_changed", { claimId, from: claim.status, to, reason: options.reason }, this.actor);
    }
    return this.claim(claimId) as Claim;
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

  /**
   * What was already tried on a claim and its equivalents, by strategy: counts, failure classes and
   * the last failure's typed detail (plan §3.3). The attempts' text is not in it.
   */
  alreadyTried(claimId: string): TriedStrategy[] {
    return triedStrategies(this.attempts(claimId, { includeEquivalents: true }));
  }

  /** The validations of a claim (proofs of it and of its negation), in order. */
  validations(claimId: string): Validation[] {
    return this.#journal.projection.validations(claimId).map(toValidation);
  }

  /**
   * The proofs of a claim that an earlier run stored under another Lean environment, to submit again
   * through `validate`; none for a run that started on nothing, or whose environment is the earlier one's
   * (their validations count, `validations`). A proof is as good as its validation here, not before.
   */
  storedProofs(claimId: string): StoredProof[] {
    return this.#journal.projection
      .earlierValidations(claimId)
      .filter((row) => row.verdict === "valid")
      .map((row) => {
        const text = this.blobs.get(row.submission_hash);
        return present<StoredProof>({
          validationId: row.validation_id,
          claimId: row.claim_id,
          negation: row.negation,
          method: row.method,
          verdict: row.verdict,
          submissionHash: row.submission_hash,
          text,
        });
      });
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
   *
   * Only the root store can do it, and a view made by `withActor` (what a line is given) throws. The
   * reference is what a proof is compared with, by the validator and by the certifier, so a line that
   * could replace it could make a proof of another statement pass (trust.md). A claim that is not a
   * problem's is therefore always compared with the file rebuilt from its journaled statement and
   * header.
   */
  setReference(claimId: string, reference: ClaimReference): void {
    if (this.#view) {
      throw new Error(`setReference: the store of actor ${this.actor} is a view; only the orchestrator's root store sets a reference file`);
    }
    if (this.#journal.projection.claim(claimId) === undefined) throw new Error(`unknown claim ${claimId}`);
    this.#references.set(claimId, { source: reference.source, theorem: reference.theorem });
  }

  /**
   * The reference file of a claim, or of its negation: the file the root store set with
   * `setReference`, or else `theorem <claim id> <statement> := by sorry` after the claim's header.
   * An informal claim has none.
   */
  referenceFor(claimId: string, options: { negation?: boolean } = {}): ClaimReference {
    const claim = this.claim(claimId);
    if (claim === undefined) throw new Error(`unknown claim ${claimId}`);
    if (claim.kind === "informal") throw new Error(`claim ${claimId} is informal: it has no Lean reference`);
    // A copy: a line that changes what it was given does not change the file the store keeps.
    const stored = this.#references.get(claimId);
    const own = stored !== undefined ? { ...stored } : claimReference(claim.header ?? "", claimTheoremName(claimId), claim.statement);
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
    earlierStatus: row.earlier_status,
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
    earlierStatus: row.earlier_status,
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
      provenance: row.provenance,
      epoch: row.epoch,
    }),
    data: row.data,
  };
}

function toLesson(row: LessonRow): Lesson {
  return present<Lesson>({
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    text: row.text,
    provenance: row.provenance,
    epoch: row.epoch,
    seq: row.seq,
  });
}

function toEpoch(row: EpochRow): Epoch {
  return { epoch: row.epoch, reason: row.reason, changes: row.changes, provenance: row.provenance, seq: row.seq };
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
    provenance: row.provenance,
    epoch: row.epoch,
    included: row.included,
    withheld: row.withheld,
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
