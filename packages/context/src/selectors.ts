import type { Scores } from "@seshat/library";
import { symbolsOf } from "./symbols.ts";

/** A fact the selectors work on: an id and the text its symbols are read from (name, signature, gloss). */
export interface SymbolFact {
  id: string;
  text: string;
}

/** The symbols of every fact, and how many facts each symbol occurs in. */
export class SymbolIndex {
  readonly facts: readonly SymbolFact[];
  readonly symbols: ReadonlyMap<string, ReadonlySet<string>>;
  readonly frequency: ReadonlyMap<string, number>;

  constructor(facts: readonly SymbolFact[]) {
    this.facts = facts;
    const symbols = new Map<string, Set<string>>();
    const frequency = new Map<string, number>();
    for (const fact of facts) {
      const set = new Set(symbolsOf(fact.text));
      symbols.set(fact.id, set);
      for (const s of set) frequency.set(s, (frequency.get(s) ?? 0) + 1);
    }
    this.symbols = symbols;
    this.frequency = frequency;
  }
}

export interface MepoOptions {
  /** The score a fact needs in the first pass. Default 0.5 (the original 0.7 is tuned for large problems of whole formulas). */
  passMark?: number;
  /** How fast the pass mark rises to 1 as the passes go on: `mark += (1 - mark) / convergence`. Default 3.2. */
  convergence?: number;
  /** The most facts selected. Default 32. */
  limit?: number;
  /** The most passes. Default 6. */
  passes?: number;
}

/**
 * MePo (Meng and Paulson, "Lightweight relevance filtering for machine-generated resolution problems"): iterative filtering
 * by shared symbols. A symbol weighs `1 + 2 / ln(f + 1)` when `f` facts contain it, so rare symbols count more. A fact's
 * relevance is the weight of its symbols that are already relevant over the weight of all of them. Each pass takes the facts
 * above the pass mark, adds their symbols to the relevant ones, and raises the mark. Returns a score for each selected fact:
 * its relevance in the pass that took it, divided by the pass number (1 for the first), so that earlier passes rank higher.
 */
export function mepo(index: SymbolIndex, goal: string, options: MepoOptions = {}): Map<string, number> {
  const convergence = options.convergence ?? 3.2;
  const limit = options.limit ?? 32;
  let mark = options.passMark ?? 0.5;
  const relevant = new Set(symbolsOf(goal));
  const weight = (s: string) => 1 + 2 / Math.log((index.frequency.get(s) ?? 0) + 1 + 1e-9 + 1);
  const out = new Map<string, number>();
  for (let pass = 1; pass <= (options.passes ?? 6) && out.size < limit; pass++) {
    const taken: Array<{ id: string; score: number }> = [];
    for (const fact of index.facts) {
      if (out.has(fact.id)) continue;
      const symbols = index.symbols.get(fact.id) as ReadonlySet<string>;
      if (symbols.size === 0) continue;
      let shared = 0;
      let all = 0;
      for (const s of symbols) {
        all += weight(s);
        if (relevant.has(s)) shared += weight(s);
      }
      const score = shared / all;
      if (score >= mark && shared > 0) taken.push({ id: fact.id, score });
    }
    taken.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    for (const t of taken) {
      if (out.size >= limit) break;
      out.set(t.id, t.score / pass);
      for (const s of index.symbols.get(t.id) as ReadonlySet<string>) relevant.add(s);
    }
    if (taken.length === 0 && pass > 1) break;
    mark += (1 - mark) / convergence;
  }
  return out;
}

export interface SineOptions {
  /** A symbol triggers a fact when its frequency is at most this times the least frequency among the fact's symbols. Default 1.2. */
  tolerance?: number;
  /** The depth of the closure: levels of symbols and facts. Default 3. */
  depth?: number;
  limit?: number;
}

/**
 * SInE (Hoder and Voronkov, "Sine qua non for large theory reasoning"): a symbol triggers a fact when it is among the rarest
 * symbols of the fact, within `tolerance`. From the goal's symbols, the facts they trigger are selected, the symbols of those
 * facts become the next level's, to the depth. The score of a fact is 1 over its level (1 for the first), so a fact triggered
 * by the goal itself ranks first; within a level the fact whose triggering symbol is rarer ranks higher.
 */
export function sine(index: SymbolIndex, goal: string, options: SineOptions = {}): Map<string, number> {
  const tolerance = options.tolerance ?? 1.2;
  const depth = options.depth ?? 3;
  const limit = options.limit ?? 32;
  const triggers = new Map<string, Array<{ id: string; rarity: number }>>();
  for (const fact of index.facts) {
    const symbols = [...(index.symbols.get(fact.id) as ReadonlySet<string>)];
    if (symbols.length === 0) continue;
    const least = Math.min(...symbols.map((s) => index.frequency.get(s) as number));
    for (const s of symbols) {
      const f = index.frequency.get(s) as number;
      if (f <= tolerance * least) triggers.set(s, [...(triggers.get(s) ?? []), { id: fact.id, rarity: 1 / f }]);
    }
  }
  const out = new Map<string, number>();
  let level = new Set(symbolsOf(goal));
  const seen = new Set(level);
  for (let k = 1; k <= depth && out.size < limit; k++) {
    const hits = new Map<string, number>();
    for (const s of level) for (const t of triggers.get(s) ?? []) if (!out.has(t.id)) hits.set(t.id, Math.max(hits.get(t.id) ?? 0, t.rarity));
    const next = new Set<string>();
    for (const [id, rarity] of [...hits].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))) {
      if (out.size >= limit) break;
      out.set(id, (1 / k) * (0.5 + 0.5 * rarity));
      for (const s of index.symbols.get(id) as ReadonlySet<string>) if (!seen.has(s)) next.add(s);
    }
    for (const s of next) seen.add(s);
    level = next;
  }
  return out;
}

/** What the online k-NN learns from: a proved statement and the declarations its accepted proof used. */
export interface ProofExample {
  statement: string;
  premises: readonly string[];
}

export interface KnnOptions {
  /** Neighbours that vote. Default 5. */
  k?: number;
  /** The least similarity a neighbour needs to vote, 0 to 1. Default 0.2. */
  minSimilarity?: number;
}

/**
 * An online k-NN over our own proofs (Tactician's idea, without a gradient or a GPU): each proved statement is a bag of symbols
 * weighted by inverse document frequency; the `k` examples most similar to the goal (cosine) vote for the declarations their
 * proofs used, each with its similarity. It learns as proofs arrive because it is rebuilt from the examples every time it is
 * asked, and the examples are the memory's accepted attempts. Returns a score for each voted declaration, scaled to 1.
 */
export function knn(examples: readonly ProofExample[], goal: string, options: KnnOptions = {}): Map<string, number> {
  const k = options.k ?? 5;
  const minimum = options.minSimilarity ?? 0.2;
  const bags = examples.map((e) => new Set(symbolsOf(e.statement)));
  const df = new Map<string, number>();
  for (const bag of bags) for (const s of bag) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s: string) => Math.log(1 + (examples.length + 1) / ((df.get(s) ?? 0) + 1));
  const norm = (bag: ReadonlySet<string>) => Math.sqrt([...bag].reduce((sum, s) => sum + idf(s) ** 2, 0));
  const query = new Set(symbolsOf(goal));
  const qn = norm(query);
  if (qn === 0) return new Map();
  const neighbours = bags
    .map((bag, i) => {
      const n = norm(bag);
      const dot = [...bag].reduce((sum, s) => sum + (query.has(s) ? idf(s) ** 2 : 0), 0);
      return { i, similarity: n === 0 ? 0 : dot / (n * qn) };
    })
    .filter((x) => x.similarity >= minimum)
    .sort((a, b) => b.similarity - a.similarity || a.i - b.i)
    .slice(0, k);
  const votes = new Map<string, number>();
  for (const { i, similarity } of neighbours) for (const p of examples[i]?.premises ?? []) votes.set(p, (votes.get(p) ?? 0) + similarity);
  const top = Math.max(0, ...votes.values());
  return new Map(top === 0 ? [] : [...votes].map(([p, v]) => [p, v / top]));
}

/** The named channels a premise ranking can combine or be measured with (`compareChannels` of `@seshat/library` takes them as they are). */
export type Channels = Record<string, (query: string) => Scores>;
