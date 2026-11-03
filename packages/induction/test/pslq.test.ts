import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bitsForDigits, constant, describeRelation, findIntegerRelation, fromDecimal, ln, pi, toDecimal } from "../src/index.ts";

/** The sum of 1/(16^k (8k + j)) to k = terms, at the precision of `bits`. */
function bbpSeries(j: number, bits: number): bigint {
  const one = 1n << BigInt(bits + 20);
  let sum = 0n;
  for (let k = 0n; k < BigInt(Math.ceil(bits / 4) + 8); k++) sum += one / ((16n ** k) * (8n * k + BigInt(j)));
  return sum >> 20n;
}

describe("the constants", () => {
  it("are right to the digits asked for", () => {
    const bits = bitsForDigits(60) + 24;
    assert.equal(toDecimal(pi(bits), bits, 50), "3.14159265358979323846264338327950288419716939937510");
    assert.equal(toDecimal(constant("e", bits), bits, 40), "2.7182818284590452353602874713526624977572");
    assert.equal(toDecimal(ln(2, bits), bits, 40), "0.6931471805599453094172321214581765680755");
    assert.equal(toDecimal(constant("sqrt(2)", bits), bits, 40), "1.4142135623730950488016887242096980785696");
    assert.equal(toDecimal(constant("phi", bits), bits, 40), "1.6180339887498948482045868343656381177203");
    assert.equal(toDecimal(ln(10, bits), bits, 40), "2.3025850929940456840179914546843642076011");
  });

  it("parse and print decimals", () => {
    assert.equal(toDecimal(fromDecimal("-12.5", 64), 64, 3), "-12.500");
    assert.throws(() => fromDecimal("abc", 64), /not a decimal number/);
    assert.throws(() => constant("zeta(3)", 64), /unknown constant/);
  });
});

describe("PSLQ", () => {
  it("finds the minimal polynomial of the golden ratio: phi^2 - phi - 1 = 0", () => {
    const bits = bitsForDigits(50) + 24;
    const phi = toDecimal(constant("phi", bits), bits, 50);
    const phi2 = toDecimal((constant("phi", bits) * constant("phi", bits)) >> BigInt(bits), bits, 50);
    const found = findIntegerRelation([phi2, phi, "1"], { digits: 50 });
    assert.ok(found !== undefined);
    assert.deepEqual(found.relation.map((a) => (found.relation[0] as bigint) < 0n ? -a : a), [1n, -1n, -1n]);
    assert.ok(found.significant, `agreement ${found.agreementDigits} digits against a relation of ${found.relationDigits}`);
  });

  it("finds a relation of four terms: sqrt(2) + sqrt(3) is a root of x^4 - 10 x^2 + 1", () => {
    const bits = bitsForDigits(80) + 24;
    const x = constant("sqrt(2)", bits) + constant("sqrt(3)", bits);
    const power = (k: number): string => {
      let v = 1n << BigInt(bits);
      for (let i = 0; i < k; i++) v = (v * x) >> BigInt(bits);
      return toDecimal(v, bits, 80);
    };
    const found = findIntegerRelation(["1", power(1), power(2), power(3), power(4)], { digits: 80 });
    assert.ok(found !== undefined);
    const sign = (found.relation[0] as bigint) < 0n ? -1n : 1n;
    assert.deepEqual(found.relation.map((a) => a * sign), [1n, 0n, -10n, 0n, 1n]);
  });

  it("finds Machin's formula among pi and two arctangents", () => {
    const found = findIntegerRelation(["pi", "atan(1/5)", "atan(1/239)"], { digits: 60 });
    assert.ok(found !== undefined);
    const sign = (found.relation[0] as bigint) < 0n ? -1n : 1n;
    // pi - 16 atan(1/5) + 4 atan(1/239) = 0
    assert.deepEqual(found.relation.map((a) => a * sign), [1n, -16n, 4n]);
    assert.equal(describeRelation(found.relation.map((a) => a * sign), ["pi", "atan(1/5)", "atan(1/239)"]), "1 * pi + -16 * atan(1/5) + 4 * atan(1/239) = 0");
  });

  it("finds logarithms' relations, with constants given by name", () => {
    const found = findIntegerRelation(["ln(6)", "ln(2)", "ln(3)"], { digits: 40 });
    assert.ok(found !== undefined);
    const sign = (found.relation[0] as bigint) < 0n ? -1n : 1n;
    assert.deepEqual(found.relation.map((a) => a * sign), [1n, -1n, -1n]);
  });

  it("finds the BBP formula for pi, the relation that made PSLQ known", () => {
    const digits = 100;
    const bits = bitsForDigits(digits) + 24;
    const series = (j: number) => toDecimal(bbpSeries(j, bits), bits, digits);
    const found = findIntegerRelation([toDecimal(pi(bits), bits, digits), series(1), series(4), series(5), series(6)], { digits });
    assert.ok(found !== undefined);
    const sign = (found.relation[0] as bigint) < 0n ? -1n : 1n;
    // pi = 4 S1 - 2 S4 - S5 - S6
    assert.deepEqual(found.relation.map((a) => a * sign), [1n, -4n, 2n, 1n, 1n]);
    assert.ok(found.significant);
  });

  it("reports nothing for numbers with no small relation, and does not call a short-digit coincidence significant", () => {
    assert.equal(findIntegerRelation(["pi", "e", "1"], { digits: 40, maxCoefficient: 100 }), undefined);
    // 22/7 is a rough pi: 7 pi - 22 = 0 holds to 3 digits, and the relation takes 2 digits to write.
    const rough = findIntegerRelation(["3.14285714", "1"], { digits: 8, maxCoefficient: 1000 });
    if (rough !== undefined) assert.equal(rough.significant, false);
  });

  it("refuses a single number and a zero", () => {
    assert.throws(() => findIntegerRelation(["pi"], { digits: 20 }), /at least two/);
    assert.equal(findIntegerRelation(["0", "pi"], { digits: 20 }), undefined);
  });
});
