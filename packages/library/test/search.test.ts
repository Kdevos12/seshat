import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Bm25Index,
  compareChannels,
  combine,
  DEFAULT_CAPS,
  type Entry,
  HashedVectors,
  localEntries,
  meanReciprocalRank,
  normalize,
  ranked,
  searchTiers,
  Tier,
  tokenize,
  toScores,
  weightGrid,
} from "../src/index.ts";

const DOCS = [
  { id: "two_mul", fields: { name: "aux_lib_two_mul_a1", signature: "(n : ℕ) : 2 * n = n + n", gloss: "Doubling is adding." } },
  { id: "even_add", fields: { name: "aux_lib_even_add_b2", signature: "(a b : ℕ) (ha : Even a) (hb : Even b) : Even (a + b)", gloss: "The sum of two even numbers is even." } },
  { id: "dvd_trans", fields: { name: "aux_lib_dvd_trans_c3", signature: "(a b c : ℕ) (h : a ∣ b) (g : b ∣ c) : a ∣ c", gloss: "Divisibility is transitive." } },
];

describe("BM25 over name, signature and gloss", () => {
  it("tokenizes words, camelCase and symbols, and drops one-letter variable names", () => {
    assert.deepEqual(tokenize("Nat.add_comm (a b : ℕ) : a + b = b + a"), ["nat", "add", "comm", "+", "=", "+"]);
    assert.deepEqual(tokenize("sumOfTwoSquares 2 ∣ n"), ["sum", "of", "two", "squares", "2", "∣"]);
  });

  it("ranks by the words of the name, the symbols of the signature and the gloss", () => {
    const index = new Bm25Index(DOCS);
    assert.equal(index.search("sum of two even numbers")[0]?.id, "even_add");
    assert.equal(index.search("dvd transitive")[0]?.id, "dvd_trans");
    assert.equal(index.search("a ∣ c")[0]?.id, "dvd_trans");
    assert.equal(index.search("2 * n")[0]?.id, "two_mul");
    assert.deepEqual(index.search("nothing matches this xyzzy"), []);
  });

  it("weighs a rare term above a common one, and a name above a gloss", () => {
    const index = new Bm25Index([
      { id: "a", fields: { name: "alpha", signature: "", gloss: "common common" } },
      { id: "b", fields: { name: "beta", signature: "", gloss: "common rare" } },
      { id: "c", fields: { name: "common", signature: "", gloss: "" } },
    ]);
    assert.equal(index.search("rare")[0]?.id, "b");
    assert.equal(index.search("common")[0]?.id, "c", "the name has three times the weight");
    assert.equal(new Bm25Index([]).search("anything").length, 0);
  });
});

describe("the hybrid ranking", () => {
  it("normalizes to the best score, and combines with weights that sum to one", () => {
    assert.deepEqual([...normalize(new Map([["a", 4], ["b", 2], ["c", 0], ["d", -1]]))], [["a", 1], ["b", 0.5]]);
    const mixed = combine([
      { scores: new Map([["a", 10], ["b", 5]]), weight: 3 },
      { scores: new Map([["b", 1]]), weight: 1 },
    ]);
    assert.deepEqual([...mixed].map(([id, v]) => [id, Number(v.toFixed(4))]), [["a", 0.75], ["b", 0.625]]);
    assert.equal(combine([{ scores: new Map([["a", 1]]), weight: 0 }]).size, 0);
  });

  it("lists the weight vectors of a grid", () => {
    assert.equal(weightGrid(2).length, 11);
    assert.equal(weightGrid(3).length, 66);
    assert.ok(weightGrid(3).every((w) => Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9));
  });

  it("gives a vector channel that finds a near spelling the words do not", () => {
    const vectors = new HashedVectors(DOCS);
    assert.equal(vectors.search("divisibility transitivity")[0]?.id, "dvd_trans");
    assert.equal(vectors.search("even")[0]?.id, "even_add");
  });

  const judged = (n: number) => Array.from({ length: n }, (_, i) => ({ query: `q${i}`, relevant: new Set([`d${i}`]) }));

  it("keeps the hybrid only when it beats the best single channel on the held-out queries", () => {
    // Two channels, each right about half of the queries and wrong about the others: a mix does better than either.
    const queries = judged(8);
    const channel = (right: (i: number) => boolean) => (q: string) => {
      const i = Number(q.slice(1));
      return new Map<string, number>(right(i) ? [[`d${i}`, 1], ["x", 0.9]] : [["x", 1], [`d${i}`, 0.9]]);
    };
    // The channels disagree about a query's answer in turn; the mixed score puts the answer first when either is sure.
    const a = channel((i) => i % 4 < 2);
    const b = channel((i) => i % 4 >= 2);
    const both = compareChannels(queries, { a, b });
    assert.equal(both.heldOut, true);
    assert.ok((both.singles.a as number) < 1 && (both.singles.b as number) < 1);
    assert.equal(both.keepHybrid, both.hybrid.mrr > both.best.mrr);

    // One channel is perfect: no mix beats it, so the hybrid is not kept.
    const perfect = (q: string) => new Map<string, number>([[`d${Number(q.slice(1))}`, 1]]);
    const noise = (q: string) => new Map<string, number>([["x", 1], [`d${Number(q.slice(1))}`, 0.5]]);
    const solo = compareChannels(queries, { perfect, noise });
    assert.deepEqual([solo.best.channel, solo.best.mrr], ["perfect", 1]);
    assert.equal(solo.keepHybrid, false);
  });

  it("says when too few queries were judged to hold any out", () => {
    const one = compareChannels(judged(2), { only: (q) => new Map([[`d${q.slice(1)}`, 1]]) });
    assert.equal(one.heldOut, false);
    assert.equal(one.keepHybrid, false, "a single channel has nothing to mix");
  });

  it("scores a ranking by the reciprocal rank of the first relevant id", () => {
    const rank = (q: string) => (q === "q0" ? ["d0"] : q === "q1" ? ["x", "d1"] : ["x"]);
    assert.equal(meanReciprocalRank(rank, judged(3)), (1 + 0.5 + 0) / 3);
    assert.equal(meanReciprocalRank(rank, []), 0);
    assert.deepEqual(ranked(new Map([["b", 1], ["a", 1], ["c", 2]])), ["c", "a", "b"]);
    assert.deepEqual([...toScores([{ id: "a", score: 2 }])], [["a", 2]]);
  });
});

describe("the tiers of a search", () => {
  const entry = (source: Entry["source"], name: string, signature: string, label = source as string): Entry => ({ id: `${source}:${name}`, name, source, label, signature, gloss: "" });

  it("reads the declarations of a problem's file before its target", () => {
    const prefix = "import Mathlib\n\nnamespace Demo\n\n/-- The shape. -/\ndef Shape (n : ℕ) : Prop := n > 0\n\ntheorem shape_pos (n : ℕ) (h : Shape n) : 0 < n := by\n  exact h\n\nopen Nat\n";
    const local = localEntries(prefix);
    assert.deepEqual(local.map((e) => [e.name, e.signature, e.gloss]), [["Shape", "(n : ℕ) : Prop", "The shape."], ["shape_pos", "(n : ℕ) (h : Shape n) : 0 < n", ""]]);
  });

  it("returns the local file first, then the library, then the extra packages, then Mathlib, with the caps", () => {
    const tiers = {
      mathlib: new Tier([entry("mathlib", "Nat.add_comm", "(n m : ℕ) : n + m = m + n", "Mathlib"), entry("mathlib", "Nat.mul_comm", "(n m : ℕ) : n * m = m * n", "Mathlib")]),
      extra: new Tier([entry("extra", "PFR.add_comm_like", "add comm for groups", "PFR")]),
      library: new Tier([entry("library", "aux_lib_add_comm_x", "(a b : ℕ) : a + b = b + a")]),
      local: new Tier([entry("local", "shape_comm", "add comm shape")]),
    };
    const hits = searchTiers(tiers, "add comm");
    assert.deepEqual([...new Set(hits.map((h) => h.entry.source))], ["local", "library", "extra", "mathlib"]);
    assert.deepEqual([...new Set(hits.map((h) => h.entry.label))], ["local", "library", "PFR", "Mathlib"]);
    assert.deepEqual(hits.map((h) => h.entry.name), ["shape_comm", "aux_lib_add_comm_x", "PFR.add_comm_like", "Nat.add_comm", "Nat.mul_comm"]);
    const capped = searchTiers(tiers, "comm", { ...DEFAULT_CAPS, mathlib: 1 });
    assert.equal(capped.filter((h) => h.entry.source === "mathlib").length, 1);
    assert.deepEqual(searchTiers({}, "anything"), []);
  });

  it("ranks a tier by the hybrid of BM25 and the vectors when asked", () => {
    const tier = new Tier([entry("library", "aux_lib_dvd_trans_c3", "(a b c : ℕ) : a ∣ b → b ∣ c → a ∣ c"), entry("library", "aux_lib_two_mul_a1", "(n : ℕ) : 2 * n = n + n")]);
    const hits = tier.search("transitive dvd", { mode: "hybrid", bm25Weight: 0.5 });
    assert.equal(hits[0]?.entry.name, "aux_lib_dvd_trans_c3");
    assert.ok(hits.every((h) => h.score > 0 && h.score <= 1));
  });
});
