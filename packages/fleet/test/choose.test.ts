import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Beta, seeded, thompson, UNIFORM } from "../src/index.ts";

function tally<T extends string>(trials: number, seed: number, candidates: ReadonlyArray<readonly [T, Beta]>): Record<string, number> {
  const random = seeded(seed);
  const counts: Record<string, number> = {};
  for (let i = 0; i < trials; i++) {
    const picked = thompson(random, candidates)?.choice as string;
    counts[picked] = (counts[picked] ?? 0) + 1;
  }
  return counts;
}

describe("Thompson sampling", () => {
  it("plays the arm with the better posterior almost always, and the others now and then", () => {
    const counts = tally(2000, 1, [["good", { alpha: 20, beta: 4 }], ["bad", { alpha: 4, beta: 20 }]]);
    assert.ok((counts.good ?? 0) > 1980, JSON.stringify(counts));
    const close = tally(2000, 2, [["a", { alpha: 6, beta: 4 }], ["b", { alpha: 5, beta: 5 }]]);
    assert.ok((close.a ?? 0) > 1000 && (close.b ?? 0) > 300, JSON.stringify(close));
  });

  it("tries an arm nothing is known of before one that keeps failing", () => {
    const counts = tally(1000, 3, [["tried", { alpha: 1, beta: 9 }], ["new", UNIFORM]]);
    assert.ok((counts.new ?? 0) > 900, JSON.stringify(counts));
  });

  it("spreads equal arms evenly", () => {
    const counts = tally(3000, 4, [["a", UNIFORM], ["b", UNIFORM], ["c", UNIFORM]]);
    for (const label of ["a", "b", "c"]) assert.ok((counts[label] ?? 0) > 850 && (counts[label] ?? 0) < 1150, JSON.stringify(counts));
  });

  it("repeats for a seed, and reports the draws in the order of the candidates", () => {
    const candidates = [["a", UNIFORM], ["b", { alpha: 3, beta: 1 }], ["c", { alpha: 1, beta: 3 }]] as const;
    const first = thompson(seeded(11), candidates);
    assert.deepEqual(first, thompson(seeded(11), candidates));
    assert.deepEqual(first?.draws.map(([label]) => label), ["a", "b", "c"]);
    assert.equal(first?.choice, first?.draws.reduce((best, d) => (d[1] > best[1] ? d : best))[0]);
    assert.equal(thompson(seeded(1), []), undefined);
  });

  it("takes the first of equal draws", () => {
    assert.equal(thompson(() => 0.5, [["x", UNIFORM], ["y", UNIFORM]])?.choice, "x");
  });
});
