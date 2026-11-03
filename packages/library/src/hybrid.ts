import { type Bm25Document, tokenize, type Scored } from "./bm25.ts";

/**
 * Hybrid ranking of library candidates (plan change PC5 item 2): a convex combination of the normalized
 * scores of several channels (BM25, a vector channel, personalized PageRank), kept only if it beats the
 * best single channel on judged queries. Without such a measure the single BM25 channel ranks.
 */

export type Scores = ReadonlyMap<string, number>;

/** Scores scaled to (0, 1] by the best one; scores at or under 0 are dropped. */
export function normalize(scores: Scores): Map<string, number> {
  const out = new Map<string, number>();
  let top = 0;
  for (const v of scores.values()) if (v > top) top = v;
  if (top <= 0) return out;
  for (const [id, v] of scores) if (v > 0) out.set(id, v / top);
  return out;
}

export function toScores(list: readonly Scored[]): Map<string, number> {
  return new Map(list.map((s) => [s.id, s.score]));
}

export interface WeightedChannel {
  scores: Scores;
  weight: number;
}

/** The convex combination of the channels' normalized scores; the weights are scaled to sum to 1. */
export function combine(channels: readonly WeightedChannel[]): Map<string, number> {
  const total = channels.reduce((sum, c) => sum + c.weight, 0);
  const out = new Map<string, number>();
  if (!(total > 0)) return out;
  for (const channel of channels) {
    for (const [id, v] of normalize(channel.scores)) out.set(id, (out.get(id) ?? 0) + (channel.weight / total) * v);
  }
  return out;
}

export function ranked(scores: Scores): string[] {
  return [...scores].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([id]) => id);
}

/** A hashed bag of character trigrams over the tokens of a text: a small deterministic vector channel (no model). */
export class HashedVectors {
  readonly #dim: number;
  readonly #ids: string[];
  readonly #vectors: Float64Array[];

  constructor(documents: readonly Bm25Document[], dim = 512) {
    this.#dim = dim;
    this.#ids = documents.map((d) => d.id);
    this.#vectors = documents.map((d) => this.embed(Object.values(d.fields).join(" ")));
  }

  embed(text: string): Float64Array {
    const v = new Float64Array(this.#dim);
    for (const token of tokenize(text)) {
      const padded = `^${token}$`;
      for (let i = 0; i + 3 <= padded.length; i++) {
        let h = 2166136261;
        for (const ch of padded.slice(i, i + 3)) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
        v[h % this.#dim] = (v[h % this.#dim] ?? 0) + 1;
      }
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    return v;
  }

  /** Cosine similarity of each document with the query, best first; documents with none are left out. */
  search(query: string): Scored[] {
    const q = this.embed(query);
    const scored: Scored[] = [];
    this.#vectors.forEach((d, i) => {
      let dot = 0;
      for (let k = 0; k < q.length; k++) dot += (q[k] ?? 0) * (d[k] ?? 0);
      if (dot > 0) scored.push({ id: this.#ids[i] as string, score: dot });
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}

/** A judged query: the ids that answer it. */
export interface JudgedQuery {
  query: string;
  relevant: ReadonlySet<string>;
}

/** Mean reciprocal rank: for each query, 1 over the rank of its first relevant id (0 when none is ranked). */
export function meanReciprocalRank(rank: (query: string) => readonly string[], judged: readonly JudgedQuery[]): number {
  if (judged.length === 0) return 0;
  let sum = 0;
  for (const j of judged) {
    const at = rank(j.query).findIndex((id) => j.relevant.has(id));
    if (at >= 0) sum += 1 / (at + 1);
  }
  return sum / judged.length;
}

/** The weight vectors of `n` channels in steps of 1/`steps`, each summing to 1. */
export function weightGrid(n: number, steps = 10): number[][] {
  const out: number[][] = [];
  const go = (left: number, parts: number[]): void => {
    if (parts.length === n - 1) {
      out.push([...parts, left].map((p) => p / steps));
      return;
    }
    for (let p = 0; p <= left; p++) go(left - p, [...parts, p]);
  };
  if (n >= 1) go(steps, []);
  return out;
}

export interface ChannelComparison {
  /** The mean reciprocal rank of each channel alone, on the queries that were held out. */
  singles: Record<string, number>;
  best: { channel: string; mrr: number };
  /** The convex combination tuned on the other queries, scored on the held-out ones. */
  hybrid: { weights: Record<string, number>; mrr: number };
  /** True when the hybrid's rank beats the best single channel's on the held-out queries: the only case it is used. */
  keepHybrid: boolean;
  /** False when there were too few judged queries to hold any out: all of them tune and score, and the result is optimistic. */
  heldOut: boolean;
}

/**
 * Measures the hybrid against its channels (PC5 item 2). The judged queries are split in turn: the
 * even ones tune the weights on a grid, the odd ones score every channel and the hybrid; with fewer
 * than 4 queries all of them do both, and `heldOut` says so. The hybrid is kept only if it is strictly
 * better than the best single channel.
 */
export function compareChannels(judged: readonly JudgedQuery[], channels: Readonly<Record<string, (query: string) => Scores>>): ChannelComparison {
  const names = Object.keys(channels);
  const held = judged.length >= 4;
  const tune = held ? judged.filter((_, i) => i % 2 === 0) : judged;
  const test = held ? judged.filter((_, i) => i % 2 === 1) : judged;
  const rankBy = (weights: readonly number[]) => (query: string) => ranked(combine(names.map((name, i) => ({ scores: (channels[name] as (q: string) => Scores)(query), weight: weights[i] ?? 0 }))));
  const singles = Object.fromEntries(names.map((name) => [name, meanReciprocalRank((q) => ranked(normalize((channels[name] as (q: string) => Scores)(q))), test)]));
  const best = names.reduce((b, name) => ((singles[name] as number) > b.mrr ? { channel: name, mrr: singles[name] as number } : b), { channel: names[0] ?? "", mrr: -1 });
  let chosen: number[] = names.map(() => 1 / Math.max(names.length, 1));
  let chosenMrr = -1;
  for (const weights of weightGrid(names.length)) {
    const mrr = meanReciprocalRank(rankBy(weights), tune);
    if (mrr > chosenMrr + 1e-12) {
      chosen = weights;
      chosenMrr = mrr;
    }
  }
  const hybridMrr = names.length === 0 ? 0 : meanReciprocalRank(rankBy(chosen), test);
  return {
    singles,
    best,
    hybrid: { weights: Object.fromEntries(names.map((n, i) => [n, chosen[i] ?? 0])), mrr: hybridMrr },
    keepHybrid: names.length > 1 && hybridMrr > best.mrr + 1e-12,
    heldOut: held,
  };
}
