import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { betaDraw, gamma, hash32, seeded } from "../src/index.ts";

function mean(draw: () => number, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += draw();
  return sum / n;
}

describe("the seeded random source", () => {
  it("repeats for a seed, differs between seeds and stays in [0, 1)", () => {
    const a = seeded(42);
    const b = seeded(42);
    const first = Array.from({ length: 5 }, () => a());
    assert.deepEqual(first, Array.from({ length: 5 }, () => b()));
    assert.notDeepEqual(first, Array.from({ length: 5 }, seeded(43)));
    const draws = Array.from({ length: 2000 }, seeded(7));
    assert.ok(draws.every((x) => x >= 0 && x < 1));
    assert.ok(Math.abs(mean(seeded(7), 20000) - 0.5) < 0.01);
  });

  it("hashes a key to a seed the same way each time", () => {
    assert.equal(hash32("a"), 0xe40c292c);
    assert.equal(hash32("run_1:problem_1:p1:3"), hash32("run_1:problem_1:p1:3"));
    assert.notEqual(hash32("run_1:problem_1:p1:3"), hash32("run_1:problem_1:p1:4"));
  });
});

describe("gamma and beta draws", () => {
  it("have the mean of their distribution", () => {
    for (const shape of [0.5, 1, 3, 12]) {
      const random = seeded(1000 + shape * 10);
      assert.ok(Math.abs(mean(() => gamma(random, shape), 30000) / shape - 1) < 0.04, `gamma(${shape})`);
    }
    for (const [alpha, beta] of [[2, 5], [1, 1], [0.5, 0.5], [30, 3]] as const) {
      const random = seeded(alpha * 100 + beta);
      assert.ok(Math.abs(mean(() => betaDraw(random, alpha, beta), 30000) - alpha / (alpha + beta)) < 0.01, `beta(${alpha}, ${beta})`);
    }
  });

  it("have the variance of a beta distribution", () => {
    const random = seeded(5);
    const draws = Array.from({ length: 30000 }, () => betaDraw(random, 2, 5));
    const m = draws.reduce((s, x) => s + x, 0) / draws.length;
    const variance = draws.reduce((s, x) => s + (x - m) ** 2, 0) / draws.length;
    assert.ok(Math.abs(variance - (2 * 5) / (7 ** 2 * 8)) < 0.003);
    assert.ok(draws.every((x) => x > 0 && x < 1));
  });

  it("refuse a shape that is not above 0", () => {
    assert.throws(() => gamma(seeded(1), 0), /shape of a gamma draw must be above 0/);
    assert.throws(() => gamma(seeded(1), -1), RangeError);
  });
});
