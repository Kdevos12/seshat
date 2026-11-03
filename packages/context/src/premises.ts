import { combine, type Entry, normalize, type Scores, SOURCES, type Source, Tier, toScores, type Ranking } from "@seshat/library";
import { accessible, type Use, useOf } from "./access.ts";
import { type DependencyNeighbours, SEED_TABLE, type SeedRule, seedNames } from "./seeds.ts";
import { knn, mepo, type ProofExample, sine, SymbolIndex } from "./selectors.ts";

/** The channel that ranks a source's entries: one symbolic selector, BM25 alone, or their convex combination (PC5 item 2). */
export type Selector = "mepo" | "sine" | "bm25" | "hybrid";

export const SELECTORS: readonly Selector[] = ["mepo", "sine", "bm25", "hybrid"];

/** What the export may say about a declaration beyond `ExportedDeclaration`: its kind and whether it is a `simp` lemma. */
export interface DeclarationFlags {
  kind?: string;
  simp?: boolean;
}

export interface PremiseSettings {
  selector: Selector;
  /** The most premises in all (the per-session option of PC6 item 1). */
  count: number;
  /** The most from each source, before `count` cuts. */
  caps: Readonly<Record<Source, number>>;
  /** The least score (0 to 1) a premise needs: nothing under it goes in, even with room left. */
  threshold: number;
  /** For `hybrid`: the weights of BM25, MePo and SInE. */
  weights: readonly [number, number, number];
  /** The accessibility filter: the problem's header and the roots the base environment always has; undefined: off. */
  access?: { header: string; assumed: readonly string[] };
  /** The pattern-seed channel; undefined: off. */
  seeds?: { table?: readonly SeedRule[]; neighbours?: DependencyNeighbours };
  /** The online k-NN over our own proofs; undefined: off. Its suggestions are learned, so they are drawn (`context:knn`). */
  knn?: { examples: readonly ProofExample[]; k: number };
}

/** A premise the compiler selected, with where it came from. */
export interface Premise {
  entry: Entry;
  score: number;
  /** The channels that found it: the selector, `name` (a name the model's extraction gave), `seed`, `neighbour`, `knn`. */
  via: string[];
  use: Use;
}

/** What retrieval is asked: the goal's statement, the concept queries and Lean names extracted from it (PC5 item 1a). */
export interface PremiseInput {
  statement: string;
  /** Concept queries. Empty: the statement alone is the query (the raw-statement arm, which hurt in LemmaHead). */
  queries: readonly string[];
  /** Likely Lean names; only the ones the index has are used. */
  names: readonly string[];
}

const textOf = (e: Entry) => e.signature;

/** The channels of one source, by name: functions from a query to scores in [0, 1], for `compareChannels` and for the ranking. */
const built = new WeakMap<readonly Entry[], { tier: Tier; index: SymbolIndex }>();

export function tierChannels(entries: readonly Entry[], ranking: Ranking = { mode: "bm25", bm25Weight: 0.7 }): Record<"bm25" | "mepo" | "sine", (query: string) => Scores> {
  // The indexes of a source are built once for the array that holds it (the export of an environment is one array): a session reuses them.
  let b = built.get(entries);
  if (b === undefined) {
    b = { tier: new Tier(entries), index: new SymbolIndex(entries.map((e) => ({ id: e.id, text: textOf(e) }))) };
    built.set(entries, b);
  }
  const { tier, index } = b;
  return {
    bm25: (q) => normalize(toScores(tier.search(q, ranking, entries.length).map((h) => ({ id: h.entry.id, score: h.score })))),
    mepo: (q) => mepo(index, q, { limit: entries.length }),
    sine: (q) => sine(index, q, { limit: entries.length }),
  };
}

function scoresFor(selector: Selector, channels: ReturnType<typeof tierChannels>, query: string, weights: readonly [number, number, number]): Scores {
  if (selector !== "hybrid") return channels[selector](query);
  return combine([
    { scores: channels.bm25(query), weight: weights[0] },
    { scores: channels.mepo(query), weight: weights[1] },
    { scores: channels.sine(query), weight: weights[2] },
  ]);
}

/**
 * The candidate premises (plan §4): for each source in the order of LC2 (this file, the harness library, extra packages,
 * Mathlib), the entries the problem can see (the accessibility filter), scored by the selector against each query and the
 * statement, the best score kept, nothing under the threshold; then the entries the model's extraction named, the pattern
 * seeds and their dependency neighbours, and the k-NN's votes. Deterministic. The cap of a source and the total count cut last,
 * in the source order, so that a nearer source is never crowded out by Mathlib.
 */
export async function retrievePremises(tiers: Readonly<Partial<Record<Source, readonly Entry[]>>>, input: PremiseInput, s: PremiseSettings, flags: ReadonlyMap<string, DeclarationFlags> = new Map()): Promise<Premise[]> {
  const queries = input.queries.length > 0 ? [...input.queries, input.statement] : [input.statement];
  const visible = (e: Entry) => s.access === undefined || accessible(e, s.access.header, s.access.assumed);
  const found = new Map<string, Premise>();
  const add = (entry: Entry, score: number, via: string) => {
    const known = found.get(entry.id);
    const use = useOf(entry, flags.get(entry.id));
    if (known === undefined) found.set(entry.id, { entry, score, via: [via], use });
    else {
      known.score = Math.max(known.score, score);
      if (!known.via.includes(via)) known.via.push(via);
    }
  };
  const all = SOURCES.flatMap((source) => (tiers[source] ?? []).filter(visible));
  const byName = new Map<string, Entry>();
  for (const e of all) if (!byName.has(e.name)) byName.set(e.name, e);

  for (const source of SOURCES) {
    const entries = (tiers[source] ?? []).filter(visible);
    if (entries.length === 0) continue;
    const channels = tierChannels(entries);
    const best = new Map<string, number>();
    for (const q of queries) for (const [id, v] of scoresFor(s.selector, channels, q, s.weights)) best.set(id, Math.max(best.get(id) ?? 0, v));
    const byId = new Map(entries.map((e) => [e.id, e]));
    const taken = [...best].filter(([, v]) => v >= s.threshold).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, s.caps[source]);
    for (const [id, v] of taken) add(byId.get(id) as Entry, v, s.selector);
  }
  // A name the extraction gave counts only when the index has it: a name is never invented.
  for (const name of input.names) {
    const entry = byName.get(name) ?? all.find((e) => e.name.endsWith(`.${name}`));
    if (entry !== undefined) add(entry, 0.9, "name");
  }
  if (s.seeds !== undefined) {
    for (const name of seedNames(input.statement, s.seeds.table ?? SEED_TABLE)) {
      const entry = byName.get(name);
      if (entry === undefined) continue;
      add(entry, 0.6, "seed");
      for (const n of (await s.seeds.neighbours?.(name)) ?? []) {
        const neighbour = byName.get(n);
        if (neighbour !== undefined) add(neighbour, 0.4, "neighbour");
      }
    }
  }
  if (s.knn !== undefined) {
    for (const [name, v] of knn(s.knn.examples, input.statement, { k: s.knn.k })) {
      const entry = byName.get(name);
      if (entry !== undefined) add(entry, v, "knn");
    }
  }
  // Source order first, then score, then name; the caps already cut each source, the count cuts the whole.
  const order = (p: Premise) => SOURCES.indexOf(p.entry.source);
  return [...found.values()]
    .sort((a, b) => order(a) - order(b) || b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))
    .slice(0, Math.max(0, Math.floor(s.count)));
}
