import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { berlekampMassey, describeRecurrence, guessHolonomic, guessLinearRecurrence, predictTerms, recurrenceHolds, recurrenceStatement } from "../src/index.ts";
import { show } from "../src/rational.ts";

const fibonacci = (count: number): bigint[] => {
  const out = [0n, 1n];
  while (out.length < count) out.push((out.at(-1) as bigint) + (out.at(-2) as bigint));
  return out.slice(0, count);
};
const catalan = (count: number): bigint[] => {
  const out = [1n];
  for (let n = 0; out.length < count; n++) out.push(((out[n] as bigint) * BigInt(4 * n + 2)) / BigInt(n + 2));
  return out;
};
const centralBinomial = (count: number): bigint[] => {
  const out = [1n];
  for (let n = 0; out.length < count; n++) out.push(((out[n] as bigint) * BigInt(2 * (2 * n + 1))) / BigInt(n + 1));
  return out;
};
const motzkin = (count: number): bigint[] => {
  const out = [1n, 1n];
  for (let n = 1; out.length < count; n++) out.push(((BigInt(2 * n + 3) * (out[n] as bigint)) + BigInt(3 * n) * (out[n - 1] as bigint)) / BigInt(n + 3));
  return out.slice(0, count);
};
const derangements = (count: number): bigint[] => {
  const out = [1n, 0n];
  for (let n = 0; out.length < count; n++) out.push(BigInt(n + 1) * ((out[n + 1] as bigint) + (out[n] as bigint)));
  return out.slice(0, count);
};
const primes = (count: number): bigint[] => {
  const out: bigint[] = [];
  for (let n = 2n; out.length < count; n++) {
    let prime = true;
    for (let d = 2n; d * d <= n; d++) if (n % d === 0n) prime = false;
    if (prime) out.push(n);
  }
  return out;
};

describe("Berlekamp-Massey", () => {
  it("finds the recurrence of the Fibonacci numbers over the rationals", () => {
    assert.deepEqual(berlekampMassey(fibonacci(20)).map(show), ["1", "1"]);
  });

  it("finds rational coefficients, a recurrence of order 3, and the empty one for zeros", () => {
    // 2^n + 3^n + (-1)^n has the roots 2, 3 and -1: x^3 - 4 x^2 + x + 6.
    const terms = Array.from({ length: 14 }, (_, n) => 2n ** BigInt(n) + 3n ** BigInt(n) + (n % 2 === 0 ? 1n : -1n));
    assert.deepEqual(berlekampMassey(terms).map(show), ["4", "-1", "-6"]);
    assert.deepEqual(berlekampMassey([0, 0, 0, 0, 0]), []);
    // Over the rationals the coefficients need not be integers: 16, 8, 4, 2, 1 has s(n) = s(n-1) / 2.
    assert.deepEqual(berlekampMassey([16, 8, 4, 2, 1]).map(show), ["1/2"]);
  });
});

describe("guessing a recurrence with constant coefficients", () => {
  it("reads Fibonacci and a sum of powers, and the guess holds beyond the terms it used", () => {
    const fib = guessLinearRecurrence(fibonacci(12));
    assert.ok(fib !== undefined);
    assert.equal(fib.kind, "linear");
    assert.deepEqual([fib.order, fib.degree, fib.surplus], [2, 0, 8]);
    assert.deepEqual(fib.coefficients, [[1n], [1n], [-1n]]);
    assert.ok(recurrenceHolds(fib, fibonacci(40)));
    assert.deepEqual(predictTerms(fib, fibonacci(12), 3), fibonacci(15).slice(12));
  });

  it("refuses a guess that is not overdetermined: too few terms for the order, or no recurrence at all", () => {
    assert.equal(guessLinearRecurrence(fibonacci(5)), undefined, "2L = 4 leaves one equation beyond the unknowns, and 2 are asked");
    assert.equal(guessLinearRecurrence(primes(14)), undefined, "the primes satisfy no short recurrence");
    assert.equal(guessLinearRecurrence(primes(30), { maxOrder: 6 }), undefined);
  });

  it("states the recurrence as a conjecture in Lean's signature form", () => {
    const fib = guessLinearRecurrence(fibonacci(12));
    assert.ok(fib !== undefined);
    assert.equal(recurrenceStatement(fib, { fn: "fib" }), "(n : ℕ) : 1 * (fib (n) : ℤ) + 1 * (fib (n + 1) : ℤ) + (-1) * (fib (n + 2) : ℤ) = 0");
  });
});

describe("guessing a recurrence with polynomial coefficients (gfun's guess)", () => {
  it("finds the Catalan numbers' recurrence, as (n + 2) f(n+1) = (4 n + 2) f(n)", () => {
    const rec = guessHolonomic(catalan(12));
    assert.ok(rec !== undefined);
    assert.deepEqual([rec.kind, rec.order, rec.degree], ["holonomic", 1, 1]);
    assert.deepEqual(rec.coefficients, [[2n, 4n], [-2n, -1n]]);
    assert.ok(recurrenceHolds(rec, catalan(40)));
    assert.deepEqual(predictTerms(rec, catalan(12), 4), catalan(16).slice(12));
    assert.match(describeRecurrence(rec), /holonomic, order 1, degree 1, 12 terms/);
  });

  it("finds the central binomial coefficients, the Motzkin numbers and the derangements", () => {
    const central = guessHolonomic(centralBinomial(12));
    assert.deepEqual(central?.coefficients, [[2n, 4n], [-1n, -1n]]);
    const motz = guessHolonomic(motzkin(14));
    assert.ok(motz !== undefined);
    assert.deepEqual([motz.order, motz.degree], [2, 1]);
    assert.ok(recurrenceHolds(motz, motzkin(40)));
    const der = guessHolonomic(derangements(14));
    assert.ok(der !== undefined);
    assert.equal(der.order, 2);
    assert.ok(recurrenceHolds(der, derangements(40)));
  });

  it("insists on equations beyond the unknowns: Catalan from 6 terms is not a guess at the default surplus, and is with a surplus of 1", () => {
    assert.equal(guessHolonomic(catalan(6)), undefined);
    const rec = guessHolonomic(catalan(6), { minSurplus: 1 });
    assert.ok(rec !== undefined);
    assert.deepEqual(rec.coefficients, [[2n, 4n], [-2n, -1n]]);
    assert.equal(rec.surplus, 1);
  });

  it("does not invent a recurrence for the primes", () => {
    assert.equal(guessHolonomic(primes(20)), undefined);
  });

  it("writes the Catalan recurrence in signature form", () => {
    const rec = guessHolonomic(catalan(12));
    assert.ok(rec !== undefined);
    assert.equal(recurrenceStatement(rec, { fn: "catalan" }), "(n : ℕ) : (2 + 4 * (n : ℤ)) * (catalan (n) : ℤ) + ((-2) + (-1) * (n : ℤ)) * (catalan (n + 1) : ℤ) = 0");
  });
});
