import type { PremiseInput } from "./translate.ts";

/**
 * Premise selection for the first-order tools (plan change PC6 item 2). The index is the library's
 * or `lean.meta`'s export of declarations with their statements; Task 11's MePo and SInE plug in as
 * selectors. The two here need no training: BM25 over the words of names and statements, and a
 * symbol-overlap selector in the spirit of MePo.
 */
export type Premise = PremiseInput;

export type PremiseSelector = (goal: string, index: readonly Premise[], k: number) => Premise[];

/** Words of a Lean text: identifiers split at `.`, `_` and camel case, symbols kept as words. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[\p{L}][\p{L}\p{N}_'.]*|\d+|[^\s\p{L}\p{N}()\[\]{},:]/gu) ?? []) {
    for (const part of raw.split(/[._']+|(?<=[a-z])(?=[A-Z])/u)) if (part !== "") out.push(part.toLowerCase());
  }
  return out;
}

const textOf = (p: Premise): string => `${p.name} ${p.statement}`;

/** BM25 (k1 = 1.2, b = 0.75) over the premises as documents, the goal as the query. Ties keep the index order. */
export const bm25Selector: PremiseSelector = (goal, index, k) => {
  const docs = index.map((p) => words(textOf(p)));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const query = [...new Set(words(goal))];
  const scored = index.map((p, i) => {
    const d = docs[i] as string[];
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of query) {
      const f = tf.get(w);
      if (f === undefined) continue;
      const n = df.get(w) as number;
      const idf = Math.log(1 + (index.length - n + 0.5) / (n + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / Math.max(avg, 1))));
    }
    return { p, i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map((s) => s.p);
};

/**
 * Symbol overlap weighted by rarity: a premise scores the sum of 1/log(2 + frequency) of the symbols
 * it shares with the goal, over the size of its own symbol set (MePo's relevance, without iteration).
 */
export const symbolSelector: PremiseSelector = (goal, index, k) => {
  const symbols = (text: string): Set<string> => new Set(words(text));
  const freq = new Map<string, number>();
  const sets = index.map((p) => symbols(p.statement));
  for (const s of sets) for (const w of s) freq.set(w, (freq.get(w) ?? 0) + 1);
  const g = symbols(goal);
  const scored = index.map((p, i) => {
    const s = sets[i] as Set<string>;
    let shared = 0;
    for (const w of s) if (g.has(w)) shared += 1 / Math.log(2 + (freq.get(w) as number));
    return { p, i, score: s.size === 0 ? 0 : shared / Math.sqrt(s.size) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map((s) => s.p);
};

/**
 * Interleaves selectors: the first selector's choice and a BM25 stream take turns, so that a cutoff
 * mixes both (PC6 item 2). Duplicates are dropped; at most `k` premises.
 */
export function mixSelectors(primary: PremiseSelector, secondary: PremiseSelector = bm25Selector): PremiseSelector {
  return (goal, index, k) => {
    const a = primary(goal, index, k);
    const b = secondary(goal, index, k);
    const seen = new Set<string>();
    const out: Premise[] = [];
    for (let i = 0; out.length < k && (i < a.length || i < b.length); i++) {
      for (const p of [a[i], b[i]]) {
        if (p !== undefined && !seen.has(p.name) && out.length < k) {
          seen.add(p.name);
          out.push(p);
        }
      }
    }
    return out;
  };
}

/** The cutoffs of an option text: `16,64,256` (whole numbers from 1, no repeats, ascending). */
export function parseCutoffs(text: string): number[] {
  const values = text.split(",").map((t) => t.trim()).filter((t) => t !== "");
  const out: number[] = [];
  for (const v of values) {
    if (!/^\d+$/u.test(v) || Number(v) < 1) throw new RangeError(`a premise cutoff is a whole number from 1, not ${JSON.stringify(v)}`);
    if (!out.includes(Number(v))) out.push(Number(v));
  }
  return out.sort((a, b) => a - b);
}
