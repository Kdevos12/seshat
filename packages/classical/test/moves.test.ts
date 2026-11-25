import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type Move, MOVE_NAMES, MOVES, movesOf, routeStatement } from "../src/index.ts";

const moves = (statement: string): Move[] => routeStatement(statement).moves;

describe("the router's exploration moves (plan change CX1)", () => {
  it("names twelve moves", () => {
    assert.equal(MOVES.length, 12);
    assert.deepEqual(Object.keys(MOVE_NAMES), [...MOVES]);
  });

  it("tags a polynomial inequality with a certificate and a numeric counterexample search", () => {
    assert.deepEqual(moves("(x y : ℝ) : 2 * x * y ≤ x ^ 2 + y ^ 2"), ["E3", "E6"]);
  });

  it("tags an integer equation with a certificate (a modulus)", () => {
    const catalan = "(a b x y : ℕ) (ha : 1 < a) (hb : 1 < b) (hx : 0 < x) (hy : 0 < y) (heq : x ^ a - y ^ b = 1) : a = 2 ∧ b = 3 ∧ x = 3 ∧ y = 2";
    assert.ok(moves(catalan).includes("E6"));
    // Unreadable to the reader (a factorial), but an impossibility over arithmetic all the same.
    assert.ok(moves("(n x : ℕ) : n ! + 1 ≠ x ^ 4").includes("E6"));
    assert.ok(!moves("(x y : ℤ) : (x + y) ^ 2 = x ^ 2 + 2 * x * y + y ^ 2").includes("E6"), "an identity is ring's, not a modulus's");
  });

  it("tags an existential with a witness search, and a small Fin with cases", () => {
    assert.deepEqual(moves(": ∃ x : Fin 5, x * x = 4"), ["E2", "E8"]);
    assert.deepEqual(moves("(n : ℕ) (hn : Odd n) (h : n < 2^50) : ∃ k l : ℕ , Squarefree k ∧ n = k + 2^l"), ["E2", "E3", "E8"]);
  });

  it("tags a sequence with guessing", () => {
    assert.ok(moves("(f : ℕ → ℤ) (h : ∀ n, f (n + 2) = f (n + 1) + f n) : f 10 = 55 * f 1 + 34 * f 0").includes("E4"));
    assert.ok(moves("{n : ℕ} (hn : n ≥ 1) : a n = 3 ^ n + 3 * 2 ^ n + 6").includes("E4"));
  });

  it("tags extremal values, asymptotics and iterations", () => {
    assert.deepEqual(moves(": W 3 6 = 32"), ["E2", "E9"]);
    assert.deepEqual(moves(": F 4 ≤ 19"), ["E9"], "an upper bound asks for a certificate, not a construction");
    assert.deepEqual(moves(": 190 ≤ LongestSnakeInTheBox 9"), ["E2", "E9"]);
    assert.deepEqual(moves(": (fun n ↦ (cofactorThreshold n : ℝ)) =O[atTop] fun n ↦ (n : ℝ) ^ ((2 : ℝ) / 3)"), ["E12"]);
    assert.ok(moves("(f : ℕ → ℕ) (x : ℕ) : f^[3] x = f (f (f x))").includes("E5"));
  });

  it("does not offer a counterexample search for an eventual statement", () => {
    assert.ok(!moves(": ∀ᶠ n in atTop, Real.sqrt ((n+1).nth Nat.Prime) - Real.sqrt (n.nth Nat.Prime) < 1").includes("E3"));
  });

  it("reads only the code: a move named in a comment is not a move", () => {
    assert.deepEqual(movesOf(": 2 + 2 = 4 -- ∃ atTop"), []);
  });

  it("is journaled for a goal the reader cannot read, and gives nothing for a text too long to read", () => {
    const r = routeStatement("(n : ℕ) : ∑ i in Finset.range n, i = n");
    assert.ok(r.unreadable !== undefined);
    assert.ok(r.moves.includes("E3"));
    assert.deepEqual(routeStatement(`(x : ℕ) : ${"(".repeat(15000)}x = x${")".repeat(15000)}`).moves, []);
  });

  it("finds at least 80% of the hand-labelled moves of 40 bench and Putnam statements", (t) => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/labelled-moves.json", import.meta.url), "utf8")) as { statements: Array<{ id: string; statement: string; moves: Move[] }> };
    assert.equal(fixture.statements.length, 40);
    let labelled = 0;
    let found = 0;
    const missed: string[] = [];
    for (const s of fixture.statements) {
      const got = moves(s.statement);
      for (const m of s.moves) {
        labelled++;
        if (got.includes(m)) found++;
        else missed.push(`${s.id} ${m}`);
      }
    }
    const recall = found / labelled;
    t.diagnostic(`CX1 recall: ${found}/${labelled} labelled moves found (${(100 * recall).toFixed(1)}%); missed: ${missed.join("; ") || "none"}`);
    assert.ok(recall >= 0.8, `recall ${recall.toFixed(3)} is below the plan's 80%`);
  });
});
