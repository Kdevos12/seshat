import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attemptsByProver, CHUNK_KS, chunkCurves, chunkRun } from "../src/chunks.ts";
import { scriptedRun } from "./ablate-helpers.ts";

/** 100 attempts of a cent each; the first success is the attempt at `at` (from 1), if any. */
const hundred = (at?: number) => Array.from({ length: 100 }, (_, i) => ({ usd: 0.01, success: at !== undefined && i + 1 === at }));

describe("the chunking protocol", () => {
  it("makes K chunks of 100/K attempts, and a chunk succeeds when one of its attempts does", () => {
    const r = chunkRun(hundred(40), 10);
    assert.deepEqual(r.sizes, Array(10).fill(10));
    // The 40th attempt is in the fourth chunk (attempts 31 to 40).
    assert.deepEqual(r.chunkSucceeds, [false, false, false, true, false, false, false, false, false, false]);
    const odd = chunkRun(hundred(), 3);
    assert.deepEqual(odd.sizes, [34, 33, 33]);
    assert.equal(odd.solved, false);
    assert.ok(Math.abs(odd.usd - 1) < 1e-9, "every attempt was made");
  });

  it("stops at the first round with a success and sums the attempts of all the chunks until then", () => {
    // K = 1: the prover alone, cost to the 40th attempt.
    const alone = chunkRun(hundred(40), 1);
    assert.equal(alone.attempts, 40);
    assert.equal(alone.rounds, 40);
    // K = 10: attempt 31 is the first of the fourth chunk, so the first round succeeds.
    const attempt31 = chunkRun(hundred(31), 10);
    assert.equal(attempt31.rounds, 1);
    assert.equal(attempt31.attempts, 10, "the ten provers made their first attempt together, and the whole round is paid for");
    // Parallel provers reach a late success sooner in rounds, and at the same or a higher cost.
    const late = chunkRun(hundred(95), 10);
    assert.ok((late.rounds ?? 0) <= 10 && late.attempts > 0);
    const solo = chunkRun(hundred(95), 1);
    assert.ok(late.usd <= solo.usd + 1e-9);
  });

  it("gives the curves for K in 1, 3, 6 and 10 over several problems", () => {
    assert.deepEqual([...CHUNK_KS], [1, 3, 6, 10]);
    const curves = chunkCurves([hundred(5), hundred(60), hundred()], { budgetUsd: 2 });
    assert.deepEqual(curves.map((c) => c.k), [1, 3, 6, 10]);
    const k1 = curves[0];
    assert.equal(k1?.solved, 2);
    assert.equal(k1?.problems, 3);
    assert.deepEqual(k1?.points.map((p) => [Math.round(p.usd * 100), Math.round((p.share ?? 0) * 3)]), [[5, 1], [60, 2]]);
    assert.ok(Math.abs((k1?.meanUsdToSuccess ?? 0) - 0.325) < 1e-9);
    assert.ok(Math.abs((k1?.usdPerSolve ?? 0) - (0.05 + 0.6 + 1) / 2) < 1e-9, "the unsolved problem's attempts are paid for too");
    assert.ok((k1?.budgetShare?.median ?? 0) > 0);
    assert.equal(chunkCurves([hundred()], { ks: [3] })[0]?.meanUsdToSuccess, undefined);
  });

  it("refuses a K that is not a whole number of at least 1", () => {
    assert.throws(() => chunkRun(hundred(), 0), /K must be/);
  });

  it("reads the attempts of each prover on each problem from a journal", () => {
    const run = scriptedRun({
      problems: [
        { id: "p1", outcome: "proved", attempts: [{ outcome: "invalid", usd: 0.1 }, { outcome: "valid", usd: 0.2 }] },
        { id: "p2", outcome: "unsolved", attempts: [{ outcome: "invalid", usd: 0.3 }] },
      ],
    });
    const groups = attemptsByProver(run.events);
    assert.deepEqual(groups.map((g) => [g.problemId, g.prover, g.attempts.map((a) => a.success)]), [["p1", "p1", [false, true]], ["p2", "p1", [false]]]);
  });
});
