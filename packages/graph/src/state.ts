import { LINK_KINDS } from "@seshat/core";
import type { Edge, MemoryStore } from "@seshat/memory";
import { Engine, type Explanation } from "./engine.ts";
import { type EdgeAtom, type Fact, factKey, LOGIC_KINDS } from "./rules.ts";

/**
 * How far a fact is trusted. `certified` follows from `proved` claims only; `candidate` also counts
 * the claims whose proof passed the fast check (`computed`). A derived fact has the weaker level of
 * its premises, and never makes a claim `proved`: a composed proof still has to pass `validate`.
 */
export type Level = "candidate" | "certified";

/** The node kind in which the graph records the composed proofs it submitted. */
export const DERIVATION_KIND = "derivation";

/** The shape of the data of a `derivation` node (documentation/graph.md). */
export interface DerivationRecord {
  goal: "proved" | "refuted";
  claimId: string;
  rule: string;
  /** The edges the derivation used, in the order of its tree. */
  edges: string[];
  premises: Array<{ goal: "proved" | "refuted"; claimId: string }>;
  level: Level;
  /** `valid` or `invalid`: what `validate` said; `skipped`: nothing was submitted. */
  verdict: "valid" | "invalid" | "skipped";
  validationId?: string;
  reasons?: string[];
  /** The problem whose line submitted it: its composition budget and the derivations it has tried are counted from these. */
  problemId?: string;
  /** What identifies the derivation (the fact and the shape of its tree): a resumed run does not submit the same one again. */
  signature?: string;
}

/**
 * The node kind in which the graph says it is about to submit a composed proof, before it does:
 * `DerivationIntent`. The `derivation` node follows once `validate` answers; a run that ended in
 * between is completed from this node and the validation (`completeDerivations`).
 */
export const DERIVATION_INTENT_KIND = "derivation_intent";

/** The shape of the data of a `derivation_intent` node: a derivation record that has no verdict yet. */
export type DerivationIntent = Omit<DerivationRecord, "verdict" | "validationId" | "reasons">;

/** The validations of composed proofs the graph submitted, which are not independent proofs. */
export function composedValidations(memory: MemoryStore): Set<string> {
  const ids = new Set<string>();
  for (const node of memory.nodes(DERIVATION_KIND)) {
    const data = node.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.validationId === "string") ids.add(data.validationId);
  }
  return ids;
}

/** What a sync changed: the base facts and edges the engines gained or lost. */
export interface SyncReport {
  claims: number;
  edges: number;
  gained: string[];
  lost: string[];
}

interface Known {
  candidate: Set<string>;
  certified: Set<string>;
  edges: Map<string, string>;
}

/**
 * The propagation engines (candidate and certified level) kept in step with the memory. `sync`
 * reads the part of the graph around the seeds (every claim reachable through edges of any status)
 * and brings the engines up to date by the difference only: new `lean_checked` edges and statuses
 * fire rules, withdrawn ones revoke what depended on them. Reading the memory is all it does.
 *
 * A claim whose only valid proofs are composed ones (recorded as `derivation` nodes) is not a base
 * fact: it holds only as long as the graph still derives it, so that retracting a premise revokes it.
 */
export class GraphState {
  readonly memory: MemoryStore;
  readonly candidate = new Engine();
  readonly certified = new Engine();
  private readonly seeds = new Set<string>();
  private known: Known = { candidate: new Set(), certified: new Set(), edges: new Map() };

  constructor(memory: MemoryStore, seeds: Iterable<string> = []) {
    this.memory = memory;
    for (const seed of seeds) this.seeds.add(seed);
  }

  /** Adds claims whose surroundings the state follows. */
  watch(...claimIds: string[]): void {
    for (const id of claimIds) this.seeds.add(id);
  }

  /** The claims the state follows: the seeds, and everything reachable from them through edges. */
  claims(): string[] {
    return [...this.reach().claims].filter((id) => this.memory.claim(id) !== undefined);
  }

  /** The most that is known of a fact: `certified`, `candidate`, or undefined when it does not hold. */
  levelOf(fact: Fact): Level | undefined {
    return this.certified.holds(fact) ? "certified" : this.candidate.holds(fact) ? "candidate" : undefined;
  }

  engine(level: Level): Engine {
    return level === "certified" ? this.certified : this.candidate;
  }

  /** Why a fact holds, at the highest level it holds at. */
  explain(fact: Fact): { level: Level; tree: Explanation } | undefined {
    const level = this.levelOf(fact);
    const tree = level === undefined ? undefined : this.engine(level).explain(fact);
    return level === undefined || tree === undefined ? undefined : { level, tree };
  }

  /** Brings the engines up to date with the memory. */
  sync(): SyncReport {
    const { claims, edges } = this.reach();
    const composed = composedValidations(this.memory);
    const desired: Known = { candidate: new Set(), certified: new Set(), edges: new Map() };
    const atoms = new Map<string, EdgeAtom>();
    for (const edge of edges) {
      if (edge.status !== "lean_checked" || !LOGIC_KINDS.has(edge.kind) || !LINK_KINDS.includes(edge.kind)) continue;
      if (![edge.from, ...edge.to].every((id) => this.memory.claim(id)?.kind === "formal")) continue;
      atoms.set(edge.edgeId, { id: edge.edgeId, kind: edge.kind, from: edge.from, to: edge.to });
      desired.edges.set(edge.edgeId, JSON.stringify([edge.kind, edge.from, edge.to]));
    }
    for (const id of claims) {
      const claim = this.memory.claim(id);
      if (claim === undefined || claim.kind !== "formal") continue;
      const validations = this.memory.validations(id).filter((v) => v.verdict === "valid");
      const own = (negation: boolean) => validations.filter((v) => v.negation === negation && !composed.has(v.validationId));
      const hasComposed = (negation: boolean) => validations.some((v) => v.negation === negation && composed.has(v.validationId));
      const proofIsBase = own(false).length > 0 || !hasComposed(false);
      const refutationIsBase = own(true).length > 0 || !hasComposed(true);
      const proved: Fact = { goal: "proved", claim: id };
      const refuted: Fact = { goal: "refuted", claim: id };
      if (proofIsBase && (claim.status === "proved" || claim.status === "computed")) desired.candidate.add(factKey(proved));
      if (proofIsBase && claim.status === "proved") desired.certified.add(factKey(proved));
      if (refutationIsBase && claim.status === "refuted") {
        desired.candidate.add(factKey(refuted));
        desired.certified.add(factKey(refuted));
      }
      // A valid proof of the negation is a refutation candidate; the certifier alone settles it.
      if (own(true).length > 0 && claim.status !== "refuted") desired.candidate.add(factKey(refuted));
      if (own(true).some((v) => v.method === "kernel_replay")) desired.certified.add(factKey(refuted));
    }

    const report: SyncReport = { claims: claims.size, edges: desired.edges.size, gained: [], lost: [] };
    const apply = (level: Level, engine: Engine, want: Set<string>, had: Set<string>) => {
      for (const key of had) {
        if (want.has(key)) continue;
        engine.removeBase(factFromKey(key));
        report.lost.push(`${level}:${key}`);
      }
      for (const key of want) {
        if (had.has(key)) continue;
        engine.addBase(factFromKey(key));
        report.gained.push(`${level}:${key}`);
      }
    };
    // Edges first when they go, last when they come: a retraction sees the final set of edges.
    for (const [id, shape] of this.known.edges) {
      if (desired.edges.get(id) === shape) continue;
      this.candidate.removeEdge(id);
      this.certified.removeEdge(id);
      report.lost.push(`edge:${id}`);
    }
    apply("candidate", this.candidate, desired.candidate, this.known.candidate);
    apply("certified", this.certified, desired.certified, this.known.certified);
    for (const [id, atom] of atoms) {
      if (this.known.edges.get(id) === desired.edges.get(id)) continue;
      this.candidate.addEdge(atom);
      this.certified.addEdge(atom);
      report.gained.push(`edge:${id}`);
    }
    this.known = desired;
    return report;
  }

  /**
   * The claims reachable from the seeds through edges of any status, and those edges. Only the kinds
   * the rules read can carry a result, so a `cites` edge to a source many claims share does not
   * pull their surroundings in.
   */
  private reach(): { claims: Set<string>; edges: Edge[] } {
    const kinds = [...LOGIC_KINDS];
    const seen = new Set<string>(this.seeds);
    const queue = [...seen];
    const edges = new Map<string, Edge>();
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const edge of [...this.memory.edges({ from: id, kinds }), ...this.memory.edges({ to: id, kinds })]) {
        edges.set(edge.edgeId, edge);
        for (const end of [edge.from, ...edge.to]) {
          if (seen.has(end)) continue;
          seen.add(end);
          queue.push(end);
        }
      }
    }
    return { claims: seen, edges: [...edges.values()] };
  }
}

function factFromKey(key: string): Fact {
  return { goal: key.startsWith("P:") ? "proved" : "refuted", claim: key.slice(2) };
}
