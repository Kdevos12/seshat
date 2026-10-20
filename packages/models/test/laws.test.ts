import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allMagmas,
  compileLaw,
  evaluateLaw,
  type Law,
  LawSyntaxError,
  lawKey,
  lawWitness,
  parseLaw,
  printLaw,
  printTerm,
} from "../src/index.ts";

const leftZero = { size: 2, table: [0, 0, 1, 1] };
const xor = { size: 2, table: [0, 1, 1, 0] };
const minus = { size: 3, table: [0, 2, 1, 1, 0, 2, 2, 1, 0] };

describe("equational laws of magmas", () => {
  it("reads a law with or without its quantifiers, and prints it as Lean does", () => {
    const law = parseLaw("∀ x y z : M, (x * y) * z = x * (y * z)");
    assert.deepEqual(law.variables, ["x", "y", "z"]);
    assert.equal(law.type, "M");
    assert.equal(printLaw(law), "∀ x y z : M, x * y * z = x * (y * z)");
    assert.equal(printLaw(parseLaw("x * y = y * x"), { type: "G" }), "∀ x y : G, x * y = y * x");
    assert.equal(printLaw(parseLaw("x * y = y * x")), "x * y = y * x");
    assert.equal(printTerm(parseLaw("x * (y * z) = (x * y) * z").left), "x * (y * z)");
    // Forms of binders that Lean accepts.
    assert.deepEqual(parseLaw("∀ (x y : M) (z : M), x * y = z").variables, ["x", "y", "z"]);
    assert.deepEqual(parseLaw("forall x y, x * y = y * x").variables, ["x", "y"]);
    assert.equal(printLaw(parseLaw("x ◇ y = y ◇ x"), { symbol: "◇" }), "x ◇ y = y ◇ x");
  });

  it("takes * as associating to the left", () => {
    const left = parseLaw("x * y * z = x");
    assert.equal(printTerm(left.left), "x * y * z");
    assert.deepEqual(left.left.kind === "op" ? left.left.left.kind : "", "op");
  });

  it("refuses what is not a law of magmas, and says why", () => {
    const refused = (text: string, reason: RegExp, options?: { implicit?: boolean }) =>
      assert.throws(() => parseLaw(text, options), (error) => error instanceof LawSyntaxError && reason.test(error.message), text);
    refused("x * y", /expected '='/);
    refused("x * 1 = x", /number/);
    refused("x + y = y + x", /'\+' is not part/);
    refused("x * y = y * x = x", /unexpected '='/);
    refused("∀ x : M, x * y = x", /y is not bound/);
    refused("∀ (x : M) (y : N), x * y = x", /two types, M and N/);
    refused("x * y = y * x", /not bound/, { implicit: false });
    refused("∀ x y z a b c d e f : M, x * y = z * (a * (b * (c * (d * (e * f)))))", /9 variables/);
    refused("(x * y = y", /expected '\)'/);
  });

  it("evaluates a law on a magma, and gives the first assignment that breaks it", () => {
    const associative = parseLaw("∀ x y z : M, x * y * z = x * (y * z)");
    const commutative = parseLaw("x * y = y * x");
    const idempotent = parseLaw("x * x = x");
    assert.deepEqual([associative, commutative, idempotent].map((l) => evaluateLaw(l, leftZero)), [true, false, true]);
    assert.deepEqual([associative, commutative, idempotent].map((l) => evaluateLaw(l, xor)), [true, true, false]);
    assert.equal(evaluateLaw(associative, minus), false);
    // x = 0, y = 1: 0 * 1 = 0 but 1 * 0 = 1.
    assert.deepEqual(lawWitness(commutative, leftZero), [0, 1]);
    assert.equal(lawWitness(commutative, xor), undefined);
    assert.equal(evaluateLaw(parseLaw("x * y = x"), { size: 1, table: [0] }), true);
  });

  it("compiles a law once for many magmas", () => {
    const check = compileLaw(parseLaw("x * y = y * x"));
    assert.deepEqual(allMagmas(2).map((m) => check(m) === undefined), allMagmas(2).map((m) => m.table[1] === m.table[2]));
  });

  it("counts the magmas of size 1, 2 and 3 that satisfy a law as the known sequences do", () => {
    const count = (law: Law, size: number) => allMagmas(size).filter((m) => evaluateLaw(law, m)).length;
    const associative = parseLaw("∀ x y z : M, x * y * z = x * (y * z)");
    const commutative = parseLaw("x * y = y * x");
    const leftZeroLaw = parseLaw("x * y = x");
    // Semigroups up to isomorphism (OEIS A027851) and commutative semigroups (A001426).
    assert.deepEqual([1, 2, 3].map((n) => count(associative, n)), [1, 5, 24]);
    assert.deepEqual([1, 2, 3].map((n) => allMagmas(n).filter((m) => evaluateLaw(associative, m) && evaluateLaw(commutative, m)).length), [1, 3, 12]);
    // x * y = x defines one magma of each size.
    assert.deepEqual([1, 2, 3].map((n) => count(leftZeroLaw, n)), [1, 1, 1]);
    // Commutative magmas, counted without the parser.
    const direct = (n: number) => allMagmas(n).filter((m) => m.table.every((v, i) => v === m.table[(i % n) * n + Math.floor(i / n)])).length;
    assert.deepEqual([1, 2, 3].map((n) => count(commutative, n)), [1, 2, 3].map(direct));
    assert.equal(count(commutative, 2), 4);
  });

  it("gives two laws the same key when they differ by names or by the order of their sides", () => {
    assert.equal(lawKey(parseLaw("x * y = y")), lawKey(parseLaw("b = a * b")));
    assert.notEqual(lawKey(parseLaw("x * y = x")), lawKey(parseLaw("x * y = y")));
    assert.notEqual(lawKey(parseLaw("x * (y * z) = x")), lawKey(parseLaw("(x * y) * z = x")));
  });
});

describe("the size of a law", () => {
  const product = (leaves: number) => Array.from({ length: leaves }, () => "x").join(" * ");
  /** A product of `leaves` copies of x whose parentheses are balanced: wide, and not deep. */
  const balanced = (leaves: number): string => (leaves === 1 ? "x" : `(${balanced(Math.floor(leaves / 2))}) * (${balanced(leaves - Math.floor(leaves / 2))})`);
  const nested = (depth: number) => `${"(".repeat(depth)}x${")".repeat(depth)}`;
  const refused = (text: string, reason: RegExp) =>
    assert.throws(() => parseLaw(text), (error) => error instanceof LawSyntaxError && reason.test(error.message), `${text.slice(0, 30)}...`);

  it("reads a side of 64 occurrences of variables, however it is bracketed, and refuses a side of 65", () => {
    const longest = parseLaw(`${product(64)} = ${product(64)}`);
    assert.deepEqual(longest.variables, ["x"]);
    assert.equal(evaluateLaw(longest, xor), true);
    assert.deepEqual(parseLaw(`${balanced(64)} = ${balanced(64)}`).variables, ["x"]);
    refused(`${product(65)} = x`, /the left side of the law has more than 64 occurrences of variables/);
    refused(`x = ${product(65)}`, /the right side of the law has more than 64 occurrences of variables/);
    refused(`${balanced(65)} = x`, /the left side of the law has more than 64 occurrences of variables/);
  });

  it("refuses a product of a million variables with a reason: it does not run out of stack over the term it built", () => {
    refused(`${product(1_000_000)} = x`, /more than 64 occurrences of variables/);
  });

  it("reads parentheses nested 32 deep and refuses 33, with a reason and not with a stack overflow", () => {
    assert.deepEqual(parseLaw(`${nested(32)} * x = x`).variables, ["x"]);
    refused(`${nested(33)} * x = x`, /parentheses nested more than 32 deep/);
    refused(`x = x * ${nested(100_000)}`, /parentheses nested more than 32 deep/);
  });
});
