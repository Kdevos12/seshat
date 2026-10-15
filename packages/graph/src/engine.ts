import { type EdgeAtom, type Fact, factKey, type Instance, instancesOf, parseFactKey } from "./rules.ts";

/** Why a fact holds: it is a base fact, or a rule applied to premises that hold (a derivation tree). */
export interface Explanation {
  fact: Fact;
  /** True for a fact that was given (a claim's status), not derived. */
  base: boolean;
  /** The rule and the edge of the last step, for a derived fact. */
  rule?: string;
  edge?: string;
  premises?: Explanation[];
}

/**
 * The propagation engine (plan §3.2): the rules of `rules.ts` evaluated
 * semi-naively over ground instances. Base facts are the statuses of claims, edges are the
 * `lean_checked` links; the engine derives what follows and keeps, for each derived fact, every
 * derivation that holds (the provenance). Each change is applied incrementally:
 *
 * - a new base fact or edge only fires the instances it takes part in;
 * - a retraction deletes what depended on it and re-derives what has another derivation (DRed), so
 *   cycles (an equivalence) cannot keep a fact alive on their own.
 *
 * It decides nothing about claims: a derived `proved` is a proposal that `realize` turns into a
 * composed proof for Lean to check.
 */
export class Engine {
  private readonly baseFacts = new Set<string>();
  private readonly edgeAtoms = new Map<string, EdgeAtom>();
  private readonly instances = new Map<string, Instance>();
  private readonly byPremise = new Map<string, Set<string>>();
  private readonly byConclusion = new Map<string, Set<string>>();
  private readonly byEdge = new Map<string, string[]>();
  private readonly truth = new Set<string>();
  /** The instances whose premises all hold. */
  private readonly active = new Set<string>();
  private readonly support = new Map<string, Set<string>>();

  /** Gives a fact. Returns false when it was a base fact already. */
  addBase(fact: Fact): boolean {
    const key = factKey(fact);
    if (this.baseFacts.has(key)) return false;
    this.baseFacts.add(key);
    if (!this.truth.has(key)) {
      this.truth.add(key);
      this.saturate([key]);
    }
    return true;
  }

  /** Withdraws a base fact. What it alone supported stops holding. Returns false when it was not one. */
  removeBase(fact: Fact): boolean {
    const key = factKey(fact);
    if (!this.baseFacts.delete(key)) return false;
    this.retract([key]);
    return true;
  }

  /** Adds an edge (replacing one with the same id) and fires the rules on it. */
  addEdge(edge: EdgeAtom): void {
    if (this.edgeAtoms.has(edge.id)) this.removeEdge(edge.id);
    this.edgeAtoms.set(edge.id, edge);
    const ids: string[] = [];
    const fresh: string[] = [];
    for (const instance of instancesOf(edge)) {
      this.instances.set(instance.id, instance);
      ids.push(instance.id);
      for (const premise of new Set(instance.premises)) add(this.byPremise, premise, instance.id);
      add(this.byConclusion, instance.conclusion, instance.id);
      if (instance.premises.every((premise) => this.truth.has(premise))) {
        this.activate(instance);
        if (!this.truth.has(instance.conclusion)) {
          this.truth.add(instance.conclusion);
          fresh.push(instance.conclusion);
        }
      }
    }
    this.byEdge.set(edge.id, ids);
    this.saturate(fresh);
  }

  /** Removes an edge. What only it supported stops holding. Returns false when it was not there. */
  removeEdge(edgeId: string): boolean {
    const ids = this.byEdge.get(edgeId);
    if (ids === undefined) return false;
    const suspects: string[] = [];
    for (const id of ids) {
      const instance = this.instances.get(id) as Instance;
      if (this.active.has(id)) {
        this.deactivate(instance);
        suspects.push(instance.conclusion);
      }
      for (const premise of new Set(instance.premises)) remove(this.byPremise, premise, id);
      remove(this.byConclusion, instance.conclusion, id);
      this.instances.delete(id);
    }
    this.byEdge.delete(edgeId);
    this.edgeAtoms.delete(edgeId);
    this.retract(suspects);
    return true;
  }

  holds(fact: Fact): boolean {
    return this.truth.has(factKey(fact));
  }

  isBase(fact: Fact): boolean {
    return this.baseFacts.has(factKey(fact));
  }

  hasEdge(edgeId: string): boolean {
    return this.edgeAtoms.has(edgeId);
  }

  edgeIds(): string[] {
    return [...this.edgeAtoms.keys()];
  }

  /** The edges the engine holds, in the order they were added. */
  edgeList(): EdgeAtom[] {
    return [...this.edgeAtoms.values()];
  }

  baseFactsList(): Fact[] {
    return [...this.baseFacts].sort().map(parseFactKey);
  }

  /** Every fact that holds, base and derived, in key order. */
  facts(): Fact[] {
    return [...this.truth].sort().map(parseFactKey);
  }

  /** The facts that hold only because a rule gave them (they are not base facts). */
  derivedFacts(): Fact[] {
    return [...this.truth].filter((key) => !this.baseFacts.has(key)).sort().map(parseFactKey);
  }

  /** Every derivation of a fact that holds now: its provenance. */
  derivations(fact: Fact): Instance[] {
    return [...(this.support.get(factKey(fact)) ?? [])].sort().map((id) => this.instances.get(id) as Instance);
  }

  /** Claims that are proved and refuted at once: a formalization bug, or a wrong edge. */
  contradictions(): string[] {
    return [...this.truth]
      .filter((key) => key.startsWith("P:") && this.truth.has(`R:${key.slice(2)}`))
      .map((key) => key.slice(2))
      .sort();
  }

  /**
   * Why a fact holds, as the shortest derivation tree (the one with the fewest steps), which is
   * always well founded even where facts support each other in a cycle.
   */
  explain(fact: Fact): Explanation | undefined {
    const key = factKey(fact);
    if (!this.truth.has(key)) return undefined;
    const heights = this.heights();
    const build = (k: string): Explanation => {
      const height = heights.get(k) as number;
      if (this.baseFacts.has(k)) return { fact: parseFactKey(k), base: true };
      const chosen = [...(this.support.get(k) ?? [])]
        .sort()
        .map((id) => this.instances.get(id) as Instance)
        .find((instance) => 1 + Math.max(...instance.premises.map((p) => heights.get(p) as number)) === height) as Instance;
      return { fact: parseFactKey(k), base: false, rule: chosen.rule, edge: chosen.edge, premises: chosen.premises.map(build) };
    };
    return build(key);
  }

  /** The state in a canonical form, to compare an engine updated step by step with one built at once. */
  signature(): string {
    return JSON.stringify({
      base: [...this.baseFacts].sort(),
      edges: [...this.edgeAtoms.keys()].sort(),
      truth: [...this.truth].sort(),
      active: [...this.active].sort(),
    });
  }

  private heights(): Map<string, number> {
    const heights = new Map<string, number>();
    for (const key of this.baseFacts) heights.set(key, 0);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of this.active) {
        const instance = this.instances.get(id) as Instance;
        const premises = instance.premises.map((premise) => heights.get(premise));
        if (premises.some((height) => height === undefined)) continue;
        const height = 1 + Math.max(...(premises as number[]));
        const known = heights.get(instance.conclusion);
        if (known === undefined || height < known) {
          heights.set(instance.conclusion, height);
          changed = true;
        }
      }
    }
    return heights;
  }

  private activate(instance: Instance): void {
    this.active.add(instance.id);
    add(this.support, instance.conclusion, instance.id);
  }

  private deactivate(instance: Instance): void {
    this.active.delete(instance.id);
    remove(this.support, instance.conclusion, instance.id);
  }

  /** Semi-naive step: only the instances that use a fact that just became true can fire. */
  private saturate(queue: string[]): void {
    for (let i = 0; i < queue.length; i++) {
      for (const id of this.byPremise.get(queue[i] as string) ?? []) {
        if (this.active.has(id)) continue;
        const instance = this.instances.get(id) as Instance;
        if (!instance.premises.every((premise) => this.truth.has(premise))) continue;
        this.activate(instance);
        if (!this.truth.has(instance.conclusion)) {
          this.truth.add(instance.conclusion);
          queue.push(instance.conclusion);
        }
      }
    }
  }

  /**
   * Delete and re-derive: everything that depended on a suspect fact is deleted, then the facts
   * that still follow from what remains are derived again.
   */
  private retract(suspects: string[]): void {
    const deleted = new Set<string>();
    const stack = [...suspects];
    for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
      if (deleted.has(key) || this.baseFacts.has(key) || !this.truth.has(key)) continue;
      deleted.add(key);
      for (const id of this.byPremise.get(key) ?? []) {
        if (this.active.has(id)) stack.push((this.instances.get(id) as Instance).conclusion);
      }
    }
    for (const key of deleted) this.truth.delete(key);
    for (const key of deleted) {
      for (const id of this.byPremise.get(key) ?? []) {
        if (this.active.has(id)) this.deactivate(this.instances.get(id) as Instance);
      }
    }
    // An instance with a deleted conclusion and premises that all remain is still active: it re-derives.
    const again = [...deleted].filter((key) => (this.support.get(key)?.size ?? 0) > 0);
    for (const key of again) this.truth.add(key);
    this.saturate(again);
  }
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

function remove(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}
