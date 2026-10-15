import { instancesOf, type EdgeAtom, type Goal, type Instance } from "./rules.ts";
import type { GraphState, Level } from "./state.ts";

/**
 * "Proved modulo" labels (plan §3.2): the assumption-based truth
 * maintenance of de Kleer, over the same rules as the propagation.
 *
 * The assumptions are the claims that are still open: `+c` stands for "c gets proved" and `-c` for
 * "c gets refuted". The label of a fact (`P:c`, c is proved; `R:c`, c is refuted) is the set of
 * minimal environments, sets of assumptions, under which the rules give it; the empty environment
 * means it holds with no assumption. A nogood is an environment that cannot hold: it proves and
 * refutes one claim, or contains two claims that exclude each other. A label is bounded: at most
 * `maxEnvironments` environments of at most `maxSize` assumptions, the smallest first, and
 * `truncated` says when some were dropped.
 */
type Env = readonly string[];

export interface AtmsOptions {
  /** `candidate` (default) counts a `computed` claim as settled, `certified` only a `proved` one. */
  level?: Level;
  /** Environments kept per label. Default 32. */
  maxEnvironments?: number;
  /** The most assumptions in an environment. Default 8. */
  maxSize?: number;
}

/** An environment in the terms of claims: the ones to prove and the ones to refute. */
export interface Environment {
  prove: string[];
  refute: string[];
}

export interface Label {
  /** Minimal, smallest first. Empty: the fact cannot be reached from the open claims. */
  environments: Environment[];
  /** True when environments were dropped to keep the label small. */
  truncated: boolean;
}

/** The labels of the claims of a graph, and its nogoods. */
export class AtmsResult {
  private readonly labels: Map<string, Env[]>;
  private readonly cut: Set<string>;
  readonly nogoods: Environment[];
  /** Claims that are proved and refuted with no assumption at all: the graph contradicts itself. */
  readonly contradictions: string[];

  constructor(labels: Map<string, Env[]>, cut: Set<string>, nogoods: Env[], contradictions: string[]) {
    this.labels = labels;
    this.cut = cut;
    this.nogoods = nogoods.map(toEnvironment);
    this.contradictions = contradictions;
  }

  /** The label of a claim: the minimal sets of open claims it is proved (or refuted) modulo. */
  label(claimId: string, goal: Goal = "proved"): Label {
    const key = keyOf(goal, claimId);
    return { environments: (this.labels.get(key) ?? []).map(toEnvironment), truncated: this.cut.has(key) };
  }

  /** True when the claim is proved (or refuted) with no assumption. */
  settled(claimId: string, goal: Goal = "proved"): boolean {
    return (this.labels.get(keyOf(goal, claimId)) ?? []).some((env) => env.length === 0);
  }

  /** The claims that have a label, and the facts' raw environments, for the value of a lemma. */
  claims(): string[] {
    return [...new Set([...this.labels.keys()].map((key) => key.slice(2)))].sort();
  }

  raw(claimId: string, goal: Goal = "proved"): readonly Env[] {
    return this.labels.get(keyOf(goal, claimId)) ?? [];
  }
}

/** What settling an open lemma would do (the scheduler's question: which open lemma unlocks the most). */
export interface LemmaValue {
  lemma: string;
  /** Claims that its proof alone would prove. */
  settles: string[];
  /** Claims with an environment that contains it. */
  appears: string[];
  /** The sum, over those claims, of 1 / the size of their smallest such environment: 1 for each claim it settles alone. */
  weight: number;
  /** The targets that every way of proving them needs it for: a bottleneck. */
  bottleneckFor: string[];
}

export function lemmaValue(result: AtmsResult, lemmaId: string, options: { targets?: readonly string[] } = {}): LemmaValue {
  const token = `+${lemmaId}`;
  const settles: string[] = [];
  const appears: string[] = [];
  let weight = 0;
  for (const claim of result.claims()) {
    if (claim === lemmaId) continue;
    const envs = result.raw(claim);
    if (envs.some((env) => env.length === 0)) continue;
    const containing = envs.filter((env) => env.includes(token));
    if (containing.length === 0) continue;
    appears.push(claim);
    const smallest = Math.min(...containing.map((env) => env.length));
    weight += 1 / smallest;
    if (smallest === 1) settles.push(claim);
  }
  // A target's own assumption (`+target`: "if it is proved, it is proved") is no way to prove it.
  const bottleneckFor = (options.targets ?? []).filter((target) => {
    const ways = result.raw(target).filter((env) => !env.includes(`+${target}`));
    return ways.length > 0 && ways.every((env) => env.includes(token));
  });
  return { lemma: lemmaId, settles, appears, weight, bottleneckFor };
}

/**
 * The open claims that appear in the label of another claim, the most valuable first (bottlenecks, then
 * weight, then id). With `candidates`, exactly those, whether they appear or not.
 */
export function rankLemmas(result: AtmsResult, options: { targets?: readonly string[]; candidates?: readonly string[] } = {}): LemmaValue[] {
  const found = new Set<string>(options.candidates ?? []);
  if (options.candidates === undefined) {
    for (const claim of result.claims()) for (const env of result.raw(claim)) for (const token of env) if (token.startsWith("+")) found.add(token.slice(1));
  }
  return [...found]
    .map((lemma) => lemmaValue(result, lemma, options.targets === undefined ? {} : { targets: options.targets }))
    .filter((value) => options.candidates !== undefined || value.appears.length > 0)
    .sort((a, b) => b.bottleneckFor.length - a.bottleneckFor.length || b.weight - a.weight || (a.lemma < b.lemma ? -1 : 1));
}

/** One connected group of claims, as the labels are computed over it. */
export interface LabelInput {
  claims: string[];
  open: Set<string>;
  provedBase: Set<string>;
  refutedBase: Set<string>;
  edges: EdgeAtom[];
}

/** The labels of a graph, from scratch. */
export function computeLabels(input: LabelInput, options: AtmsOptions = {}): AtmsResult {
  const maxEnvironments = options.maxEnvironments ?? 32;
  const maxSize = options.maxSize ?? 8;
  const instances = input.edges.flatMap(instancesOf);
  const byPremise = new Map<string, Instance[]>();
  for (const instance of instances) {
    for (const premise of new Set(instance.premises)) byPremise.set(premise, [...(byPremise.get(premise) ?? []), instance]);
  }
  const contradictions = new Set<string>();
  let nogoods: Env[] = [];
  let result: { labels: Map<string, Env[]>; cut: Set<string> } = { labels: new Map(), cut: new Set() };
  for (let round = 0; round < 8; round++) {
    result = propagate(input, byPremise, nogoods, maxEnvironments, maxSize);
    const found: Env[] = [];
    for (const claim of input.claims) {
      for (const p of result.labels.get(keyOf("proved", claim)) ?? []) {
        for (const r of result.labels.get(keyOf("refuted", claim)) ?? []) {
          const both = union(p, r);
          if (!consistent(both)) continue;
          if (both.length === 0) contradictions.add(claim);
          else found.push(both);
        }
      }
    }
    const next = minimize([...nogoods, ...found]);
    if (next.length === nogoods.length && next.every((env, k) => key(env) === key(nogoods[k] as Env))) break;
    nogoods = next;
  }
  return new AtmsResult(result.labels, result.cut, nogoods, [...contradictions].sort());
}

function propagate(
  input: LabelInput,
  byPremise: ReadonlyMap<string, Instance[]>,
  nogoods: readonly Env[],
  maxEnvironments: number,
  maxSize: number,
): { labels: Map<string, Env[]>; cut: Set<string> } {
  const labels = new Map<string, Env[]>();
  const cut = new Set<string>();
  const queue: string[] = [];
  const hit = (env: Env) => nogoods.some((nogood) => subset(nogood, env));
  const set = (node: string, envs: Env[]) => {
    labels.set(node, envs);
    queue.push(node);
  };
  for (const claim of input.claims) {
    const p = keyOf("proved", claim);
    const r = keyOf("refuted", claim);
    if (input.provedBase.has(claim)) set(p, [[]]);
    else if (input.open.has(claim) && !hit([`+${claim}`])) set(p, [[`+${claim}`]]);
    if (input.refutedBase.has(claim)) set(r, [[]]);
    else if (input.open.has(claim) && !hit([`-${claim}`])) set(r, [[`-${claim}`]]);
  }
  for (let i = 0; i < queue.length; i++) {
    for (const instance of byPremise.get(queue[i] as string) ?? []) {
      let acc: Env[] = [[]];
      for (const premise of instance.premises) {
        const label = labels.get(premise) ?? [];
        const next: Env[] = [];
        for (const a of acc) {
          for (const b of label) {
            const both = union(a, b);
            if (both.length <= maxSize && consistent(both) && !hit(both)) next.push(both);
          }
        }
        acc = minimize(next);
        if (acc.length === 0) break;
      }
      if (acc.length === 0) continue;
      const merged = minimize([...(labels.get(instance.conclusion) ?? []), ...acc]);
      const kept = merged.slice(0, maxEnvironments);
      if (kept.length < merged.length) cut.add(instance.conclusion);
      const before = labels.get(instance.conclusion) ?? [];
      if (before.length === kept.length && before.every((env, k) => key(env) === key(kept[k] as Env))) continue;
      labels.set(instance.conclusion, kept);
      queue.push(instance.conclusion);
    }
  }
  return { labels, cut };
}

/**
 * The labels of the part of the graph a state follows. They are kept per connected group of claims
 * (the groups the `lean_checked` edges make): after a change, only the groups whose claims, statuses
 * or edges changed are computed again.
 */
export class Atms {
  readonly state: GraphState;
  readonly options: AtmsOptions;
  private readonly cache = new Map<string, AtmsResult>();
  private computed = 0;

  constructor(state: GraphState, options: AtmsOptions = {}) {
    this.state = state;
    this.options = options;
  }

  /** Groups computed (not read from the cache) so far: what incremental means in the tests. */
  get recomputed(): number {
    return this.computed;
  }

  /** Syncs the state and returns the labels of every claim it follows. */
  refresh(): AtmsResult {
    this.state.sync();
    const level = this.options.level ?? "candidate";
    const engine = this.state.engine(level);
    const memory = this.state.memory;
    const edges = engine.edgeList();
    const claims = this.state.claims().filter((id) => memory.claim(id)?.kind === "formal");
    const parent = new Map<string, string>(claims.map((id) => [id, id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      parent.set(id, root);
      return root;
    };
    for (const edge of edges) {
      const ends = [edge.from, ...edge.to].filter((id) => parent.has(id));
      for (const end of ends.slice(1)) parent.set(find(end), find(ends[0] as string));
    }
    const groups = new Map<string, LabelInput>();
    for (const id of claims) {
      const root = find(id);
      const group = groups.get(root) ?? { claims: [], open: new Set(), provedBase: new Set(), refutedBase: new Set(), edges: [] };
      groups.set(root, group);
      group.claims.push(id);
      const status = memory.claim(id)?.status;
      if (engine.isBase({ goal: "proved", claim: id })) group.provedBase.add(id);
      if (engine.isBase({ goal: "refuted", claim: id })) group.refutedBase.add(id);
      if (status === "open" || (level === "certified" && status === "computed")) group.open.add(id);
    }
    for (const edge of edges) groups.get(find(edge.from))?.edges.push(edge);

    const labels = new Map<string, Env[]>();
    const cut = new Set<string>();
    const nogoods: Env[] = [];
    const contradictions: string[] = [];
    const fresh = new Map<string, AtmsResult>();
    for (const group of groups.values()) {
      group.claims.sort();
      const fingerprint = JSON.stringify([
        group.claims,
        [...group.open].sort(),
        [...group.provedBase].sort(),
        [...group.refutedBase].sort(),
        group.edges.map((e) => [e.id, e.kind, e.from, e.to]).sort(),
      ]);
      let result = this.cache.get(fingerprint);
      if (result === undefined) {
        result = computeLabels(group, this.options);
        this.computed += 1;
      }
      fresh.set(fingerprint, result);
      for (const claim of result.claims()) {
        for (const goal of ["proved", "refuted"] as const) {
          const envs = result.raw(claim, goal);
          if (envs.length > 0) labels.set(keyOf(goal, claim), [...envs]);
          if (result.label(claim, goal).truncated) cut.add(keyOf(goal, claim));
        }
      }
      nogoods.push(...result.nogoods.map(toEnv));
      contradictions.push(...result.contradictions);
    }
    this.cache.clear();
    for (const [fingerprint, result] of fresh) this.cache.set(fingerprint, result);
    return new AtmsResult(labels, cut, minimize(nogoods), contradictions.sort());
  }
}

function keyOf(goal: Goal, claim: string): string {
  return `${goal === "proved" ? "P" : "R"}:${claim}`;
}

function key(env: Env): string {
  return env.join("\u0000");
}

function union(a: Env, b: Env): Env {
  return [...new Set([...a, ...b])].sort();
}

function subset(small: Env, large: Env): boolean {
  return small.every((token) => large.includes(token));
}

/** No claim is both proved and refuted in the environment. */
function consistent(env: Env): boolean {
  return env.every((token) => !env.includes(`${token.startsWith("+") ? "-" : "+"}${token.slice(1)}`));
}

/** Drops the environments that contain another one, and orders the rest smallest first. */
function minimize(envs: readonly Env[]): Env[] {
  const sorted = [...new Map(envs.map((env) => [key(env), env])).values()].sort((a, b) => a.length - b.length || (key(a) < key(b) ? -1 : 1));
  const kept: Env[] = [];
  for (const env of sorted) if (!kept.some((other) => subset(other, env))) kept.push(env);
  return kept;
}

function toEnvironment(env: Env): Environment {
  return { prove: env.filter((t) => t.startsWith("+")).map((t) => t.slice(1)), refute: env.filter((t) => t.startsWith("-")).map((t) => t.slice(1)) };
}

function toEnv(environment: Environment): Env {
  return [...environment.prove.map((id) => `+${id}`), ...environment.refute.map((id) => `-${id}`)].sort();
}
