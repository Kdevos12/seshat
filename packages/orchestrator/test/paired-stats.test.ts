import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcnemarExact, wilsonInterval } from "../src/paired-stats.ts";

// Expected values computed independently in Python (math.comb, math.sqrt), not with the module's code.
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

describe("wilsonInterval", () => {
  it("matches known 95% intervals", () => {
    const a = wilsonInterval(30, 100);
    near(a.low, 0.2189488529493276);
    near(a.high, 0.3958485463334666);
    const b = wilsonInterval(7, 10);
    near(b.low, 0.39677814746114537);
    near(b.high, 0.8922087325936989);
  });
  it("stays inside [0, 1] at the ends and with no problems", () => {
    const zero = wilsonInterval(0, 20);
    near(zero.low, 0);
    near(zero.high, 0.16112515805281938);
    const all = wilsonInterval(20, 20);
    near(all.low, 0.8388748419471806);
    near(all.high, 1);
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  });
});

describe("mcnemarExact", () => {
  it("matches the binomial tail on the discordant pairs", () => {
    near(mcnemarExact(2, 11), 184 / 8192);
    near(mcnemarExact(11, 2), 0.0224609375);
    near(mcnemarExact(3, 10), 0.09228515625);
    near(mcnemarExact(0, 5), 0.0625);
  });
  it("is 1 when the pairs are balanced or there are none", () => {
    assert.equal(mcnemarExact(5, 5), 1);
    assert.equal(mcnemarExact(0, 0), 1);
  });
});
