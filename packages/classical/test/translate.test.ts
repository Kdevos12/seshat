import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { lower, Outside, readVampire, readZ3, runProcess, toSmtLib, toTptp } from "../src/index.ts";

const smt = (goal: string, premises: Array<{ name: string; statement: string }> = []) => toSmtLib(lower(goal, premises)).text;
const tptp = (goal: string) => toTptp(lower(goal)).text;

describe("translation to SMT-LIB", () => {
  it("asserts the hypotheses and the negation of the goal, named", () => {
    const text = smt("(n m : ℕ) (h : n < m) : n + 1 ≤ m");
    assert.match(text, /\(declare-const n Int\)/);
    assert.match(text, /\(assert \(! \(>= n 0\) :named d_n\)\)/);
    assert.match(text, /\(assert \(! \(< n m\) :named h_1\)\)/);
    assert.match(text, /\(assert \(! \(not \(<= \(\+ n 1\) m\)\) :named goal\)\)/);
    assert.match(text, /\(check-sat\)\n\(get-unsat-core\)\n$/);
  });

  it("writes truncated subtraction, powers, divisibility and reals", () => {
    assert.match(smt("(a b : ℕ) : a - b ≤ a"), /\(ite \(>= a b\) \(- a b\) 0\)/);
    assert.match(smt("(x : ℤ) : x ^ 2 ≥ 0"), /\(\* x x\)/);
    assert.match(smt("(x : ℤ) (h : 3 ∣ x) : x % 3 = 0"), /\(= \(mod x 3\) 0\)/);
    assert.match(smt("(x : ℝ) : x / 2 + x / 2 = x"), /\(\/ x 2\.0\)/);
  });

  it("declares sorts, operations of instance binders and function variables", () => {
    const text = smt("(M : Type*) [Mul M] (f : M → M) : ∀ x y : M, f (x * y) = f (y * x)");
    assert.match(text, /\(declare-sort M 0\)/);
    assert.match(text, /\(declare-fun mul_M \(M M\) M\)/);
    assert.match(text, /\(declare-fun f \(M\) M\)/);
    assert.match(text, /forall \(\(x M\) \(y M\)\)/);
  });

  it("asserts premises as closed universal statements, named", () => {
    const text = smt("(a b : ℤ) : a + b = b + a", [{ name: "Int.add_comm", statement: "(x y : ℤ) : x + y = y + x" }]);
    assert.match(text, /\(assert \(! \(forall \(\(x Int\) \(y Int\)\) \(= \(\+ x y\) \(\+ y x\)\)\) :named p_1\)\)/);
  });

  it("says why a goal is outside the fragment", () => {
    for (const [goal, reason] of [
      ["(n : ℕ) : ∑ i in Finset.range n, i = n", /big operator/],
      ["(x y : ℝ) : x / y = x * y⁻¹", /⁻¹/],
      ["(x : ℤ) : x ^ 20 ≥ 0", /exponent/],
      ["(x : ℤ) (s : Set ℤ) : x ∈ s", /binder|Set|type/],
      ["(n : ℕ) : Nat.succ n > n", /Nat\.succ/],
    ] as const) {
      assert.throws(() => lower(goal), (e: unknown) => e instanceof Outside && reason.test(e.message), goal);
    }
  });
});

describe("translation to TPTP", () => {
  it("writes a typed problem with the goal as the conjecture", () => {
    const text = tptp("(n m : ℕ) (h : n < m) : n + 1 ≤ m");
    assert.match(text, /tff\(c_n_type, type, c_n: \$int\)\./);
    assert.match(text, /tff\(d_n, axiom, \$greatereq\(c_n,0\)\)\./);
    assert.match(text, /tff\(h_1, axiom, \$less\(c_n,c_m\)\)\./);
    assert.match(text, /tff\(goal, conjecture, \$lesseq\(\$sum\(c_n,1\),c_m\)\)\./);
  });

  it("writes quantifiers over sorts and the operations of instances", () => {
    const text = tptp("(M : Type*) [Mul M] : ∀ x y : M, x * y = y * x");
    assert.match(text, /tff\(s_M_type, type, s_M: \$tType\)\./);
    assert.match(text, /f_mul_M: \(s_M \* s_M\) > s_M/);
    assert.match(text, /!\[X_x:s_M,X_y:s_M\]: \(f_mul_M\(X_x,X_y\) = f_mul_M\(X_y,X_x\)\)/);
  });
});

describe("reading the solvers' answers", () => {
  it("reads z3's status from the first line", () => {
    assert.deepEqual(readZ3("unsat\n(a b)\n", 0, ""), { status: "unsat", core: ["a", "b"] });
    assert.deepEqual(readZ3("sat\n(error \"no core\")\n", 0, ""), { status: "sat" });
    assert.equal(readZ3("unknown\n", 0, "").status, "unknown");
    assert.equal(readZ3("The answer is unsat, trust me\n", 0, "").status, "error", "prose is no verdict");
    assert.equal(readZ3("(error \"line 1: unknown constant x\")\n", 1, "").status, "error");
  });

  it("reads Vampire's SZS status and exit code", () => {
    const proof = "% SZS status Theorem for p\n% SZS output start Proof for p\ntff(f1,axiom,x,file('/tmp/p.p',h_1)).\ntff(f2,plain,y,inference(a,[],[f1])).\ntff(f3,axiom,z,file('/tmp/p.p',p_2)).\n% SZS output end Proof for p\n";
    const ok = readVampire(proof, 0, "");
    assert.deepEqual([ok.result, ok.szs, ok.used], ["theorem", "Theorem", ["h_1", "p_2"]]);
    assert.equal(readVampire(proof, 1, "").result, "error", "a proof claim with a failing exit code is not trusted");
    assert.equal(readVampire("% SZS status CounterSatisfiable for p\n", 0, "").result, "countermodel");
    assert.equal(readVampire("% SZS status Timeout for p\n", 1, "").result, "timeout");
    assert.equal(readVampire("% SZS status GaveUp for p\n", 1, "").result, "unknown");
    assert.equal(readVampire("Refutation found. Thanks to Tanya!\n", 0, "").result, "error", "the prose of the output is no verdict");
  });
});

function z3Path(): string | undefined {
  try {
    return execFileSync("which", ["z3"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// Needs z3 on the PATH: pip install z3-solver (documentation/development.md, "Tests that use real data").
describe("z3 on translated goals", { skip: z3Path() === undefined ? "z3 is not installed (pip install z3-solver)" : false }, () => {
  const run = async (text: string) => {
    const r = await runProcess({ command: "z3", args: ["-in", "-smt2"], stdin: text, timeoutMs: 20000 });
    return readZ3(r.stdout, r.exitCode, r.stderr);
  };

  it("refutes the negation of a valid goal, with a core of the hypotheses it needs", async () => {
    const answer = await run(smt("(n m k : ℕ) (h : n < m) (h2 : k = 7) : n + 1 ≤ m"));
    assert.equal(answer.status, "unsat");
    const core = answer.core ?? [];
    assert.ok(core.includes("goal") && core.includes("h_1"));
    assert.ok(!core.includes("h_2"), "the irrelevant hypothesis is not in the core");
  });

  it("finds a model of the negation of a false goal", async () => {
    assert.equal((await run(smt("(n m : ℕ) (h : n ≤ m) : n < m"))).status, "sat");
  });

  it("proves goals over integers and abstract sorts", async () => {
    assert.equal((await run(smt("(a b : ℤ) : a + b = b + a"))).status, "unsat");
    assert.equal((await run(smt("(M : Type*) [Mul M] (h : ∀ x y : M, x * y = y * x) (a b : M) : a * b = b * a"))).status, "unsat");
    assert.equal((await run(smt("(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x"))).status, "sat");
  });

  it("translates a premise next to the goal", async () => {
    const premise = [{ name: "Foo.bound", statement: "(n : ℤ) (h : 0 < n) : 1 ≤ n" }];
    assert.equal((await run(smt("(a : ℤ) (h : 0 < a) : 1 ≤ a", []))).status, "unsat", "linear arithmetic needs no premise");
    const text = smt("(f : ℤ → ℤ) (a : ℤ) (h : 0 < f a) : 1 ≤ f a", premise);
    assert.equal((await run(text)).status, "unsat");
  });

  it("agrees with truncated natural subtraction", async () => {
    assert.equal((await run(smt("(a b : ℕ) : a - b ≤ a"))).status, "unsat");
    assert.equal((await run(smt("(a b : ℕ) : a - b + b = a"))).status, "sat");
  });
});

describe("the translation is sound: it reads the sort of every term, or refuses", () => {
  const z3 = (() => {
    try {
      execFileSync("z3", ["-version"]);
      return true;
    } catch {
      return false;
    }
  })();
  const answer = (goal: string): string => spawnSync("z3", ["-in"], { input: smt(goal), encoding: "utf8" }).stdout.split("\n")[0] ?? "";

  it("truncates the subtraction of every term of ℕ, function results included (review I1)", () => {
    const text = smt("(f : ℕ → ℕ) (h : f 3 - f 5 = 0) : f 3 ≤ f 5");
    assert.match(text, /\(ite \(>= \(f 3\) \(f 5\)\) \(- \(f 3\) \(f 5\)\) 0\)/);
    assert.match(text, /:named d_f\)/, "a result of ℕ is not negative");
    assert.throws(() => lower("(f : ℕ → ℕ) (x : ℤ) : f x = f x"), (e: unknown) => e instanceof Outside && /mixes ℕ/.test(e.message));
    if (z3) {
      assert.equal(answer("(f : ℕ → ℕ) (h : f 3 - f 5 = 0) : f 3 = f 5"), "sat", "the stronger goal is not provable");
      assert.equal(answer("(f : ℕ → ℕ) : f 3 ≥ 0"), "unsat");
    }
  });

  it("ends the scope of a quantified ℕ with the quantifier (review I2)", () => {
    const text = smt("(x : ℤ) : (∀ x : ℕ, x ≥ 0) → x - 1 ≥ 0");
    assert.doesNotMatch(text, /ite/, "the ℤ subtraction after the quantifier does not truncate");
    if (z3) assert.equal(answer("(x : ℤ) : (∀ x : ℕ, x ≥ 0) → x - 1 ≥ 0"), "sat");
  });

  it("does not read ℚ as the reals, and does not mix ℕ with ℤ or hide a truncation in a numeral expression (review I3)", () => {
    for (const goal of [": ∃ q : ℚ, q * q = 2", "(h : ∀ q : ℚ, q * q ≠ 2) : False", "(x : ℚ) : x = x", "(n : ℕ) (z : ℤ) : n + z = z + n", "(n : ℕ) : n + (2 - 3) = n", "(n : ℕ) : n = -1"]) {
      assert.throws(() => lower(goal), (e: unknown) => e instanceof Outside, goal);
    }
    assert.doesNotThrow(() => lower("(n : ℕ) : n - 1 ≤ n"));
  });
});
