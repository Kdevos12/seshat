import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatement, parseTerm, show, Unreadable } from "../src/index.ts";
import { lower, Outside, routeStatement } from "../src/index.ts";

describe("the statement reader", () => {
  it("reads arithmetic with Lean's precedence", () => {
    assert.equal(show(parseTerm("a + b * c ^ 2 = d")), "((a + (b * (c ^ 2))) = d)");
    assert.equal(show(parseTerm("-x ^ 2 ≤ 0")), "((-(x ^ 2)) ≤ 0)");
    assert.equal(show(parseTerm("a - b - c")), "((a - b) - c)");
    assert.equal(show(parseTerm("a ∧ b ∨ c → d ↔ e")), "((((a ∧ b) ∨ c) → d) ↔ e)");
  });

  it("reads negation, quantifiers and applications", () => {
    assert.equal(show(parseTerm("¬ a = b")), "(¬(a = b))");
    assert.equal(show(parseTerm("∀ x y : ℕ, f x y = f y x")), "(∀ (x : ℕ) (y : ℕ), ((f x y) = (f y x)))");
    assert.equal(show(parseTerm("∃ n, n * 2 = 4")), "(∃ n, ((n * 2) = 4))");
    assert.equal(show(parseTerm("a <= b /\\ b >= c")), "((a ≤ b) ∧ (b ≥ c))");
  });

  it("reads binders, hypotheses, instances and type variables", () => {
    const s = parseStatement("(M : Type*) [Mul M] (n m : ℕ) (h : n < m) : n + 1 ≤ m");
    assert.deepEqual(
      s.binders.map((b) => b.kind),
      ["var", "inst", "var", "var", "hyp"],
    );
    assert.equal(show(s.conclusion), "((n + 1) ≤ m)");
    const inst = s.binders[1];
    assert.ok(inst?.kind === "inst" && inst.cls === "Mul" && inst.arg === "M");
  });

  it("refuses what it does not read, with a reason", () => {
    for (const text of ["(n : ℕ) : ∑ i in Finset.range n, i = n", "(n : ℕ) : ↑n = n", "(f : ℕ → ℕ) : f = fun x => x", "(x : ℝ) : ∀ y ∈ S, y = x", "no colon"]) {
      assert.throws(() => parseStatement(text), Unreadable, text);
    }
  });
});

describe("the domain router", () => {
  const route = (s: string) => routeStatement(s);

  it("sends Presburger goals to omega", () => {
    const r = route("(n m : ℕ) (h : n < m) : n + 1 ≤ m");
    assert.equal(r.domains[0], "presburger");
    assert.equal(r.tactics[0], "omega");
    assert.equal(route("(a b : ℤ) : (a + b) % 2 = (a - b) % 2").domains[0], "presburger");
  });

  it("sends linear real arithmetic to linarith", () => {
    const r = route("(x y : ℝ) (h : x ≤ y) : 2 * x ≤ x + y");
    assert.equal(r.domains[0], "linear_real");
    assert.equal(r.tactics[0], "linarith");
  });

  it("sends polynomial identities to ring and nonlinear inequalities to nlinarith", () => {
    assert.equal(route("(x y : ℤ) : (x + y) ^ 2 = x ^ 2 + 2 * x * y + y ^ 2").tactics[0], "ring");
    assert.equal(route("(x y : ℝ) : 2 * x * y ≤ x ^ 2 + y ^ 2").tactics[0], "nlinarith");
    const withHypothesis = route("(x y : ℚ) (h : x = y ^ 2) : x * y = y ^ 3");
    assert.deepEqual(withHypothesis.domains.slice(0, 2), ["polynomial_identity", "nonlinear_arith"]);
    assert.ok(withHypothesis.tactics.includes("grind"), "grind carries a commutative-ring module that uses equation hypotheses");
  });

  it("sends closed and finite goals to decide", () => {
    assert.deepEqual(route(": 2 + 2 = 4").domains, ["closed"]);
    assert.equal(route(": 2 + 2 = 4").tactics[0], "decide");
    const finite = route("(x : Fin 5) : x + 0 = x");
    assert.equal(finite.domains[0], "finite");
    assert.equal(finite.tactics[0], "decide");
  });

  it("sends first-order goals over an abstract type to the search tactics", () => {
    const r = route("(M : Type*) [Mul M] : ∀ x y : M, x * y = y * x");
    assert.equal(r.domains[0], "first_order");
    assert.equal(r.tactics[0], "aesop");
  });

  it("gives the whole battery to a goal it cannot read", () => {
    const r = route("(n : ℕ) : ∑ i in Finset.range n, i = n");
    assert.deepEqual(r.domains, ["general"]);
    assert.match(r.unreadable ?? "", /big operator/);
    assert.ok(r.tactics.includes("simp") && r.tactics.includes("hammer"));
  });
});

describe("hostile goals (review I6)", () => {
  const hostile = [`(x : ℕ) : ${"(".repeat(15000)}x = x${")".repeat(15000)}`, `(x : ℕ) : ${"¬".repeat(15000)}x = x`, `(x : ℕ) : ${"x + ".repeat(900)}x = x`, `(x : ℕ) : ${"x + ".repeat(5000)}x = x`];
  it("are unreadable, not a stack overflow", () => {
    for (const g of hostile) {
      const r = routeStatement(g);
      assert.deepEqual(r.domains.length > 0, true);
      if (g.length > 4000 || g.includes("(((") || g.includes("¬¬¬")) assert.ok(r.unreadable !== undefined, "too deep or too long");
    }
  });
  it("are outside the fragment of the translation", () => {
    for (const g of hostile) assert.doesNotThrow(() => { try { lower(g); } catch (e) { if (!(e instanceof Outside)) throw e; } });
  });
});
