import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanChecker, LeanCheckResult, LeanSnippet } from "@seshat/core";
import { parseBinders, plausibleTest, plausibleVerdict, vacuityTest } from "../src/index.ts";

/**
 * A simulated Lean for the vacuity test: it reads the `example : (A) ∧ (B)` of a witness probe, whose numbers are written as `(3 : ℕ)`, and
 * evaluates the comparisons (what `norm_num` would do); the probe of non-existence (`¬ ∃`) is valid when `refutable` says so.
 */
class SimLean implements LeanChecker {
  readonly implementation = "sim";
  readonly version = "0";
  readonly calls: LeanSnippet[] = [];
  readonly refutable: boolean;
  readonly plausible: string | undefined;
  constructor(refutable: boolean, plausible?: string) {
    this.refutable = refutable;
    this.plausible = plausible;
  }
  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    return snippets.map((s) => {
      this.calls.push(s);
      const body = /example [^\n]*?:\s*([^\n]*) := by/.exec(s.code)?.[1] ?? "";
      let ok = false;
      if (s.code.includes("plausible")) {
        return { id: s.id, status: "lean_error" as const, messages: [{ severity: "error" as const, pos: { line: 1, column: 0 }, text: this.plausible ?? "unknown tactic" }], sorries: [], timeMs: 1 };
      }
      if (s.code.includes("¬ ∃")) ok = this.refutable;
      else {
        const js = body.replace(/\((\d+) : [ℕℤℚℝ]\)/g, "$1").replace(/∧/g, "&&").replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≠/g, "!=").replace(/(?<![<>!=])=(?!=)/g, "==");
        try {
          ok = Boolean(new Function(`return ${js};`)());
        } catch {
          ok = false;
        }
      }
      return { id: s.id, status: ok ? ("valid" as const) : ("lean_error" as const), messages: [], sorries: [], timeMs: 1 };
    });
  }
}

describe("statement hygiene: the vacuity test", () => {
  it("finds an object that satisfies the hypotheses", async () => {
    const r = await vacuityTest(new SimLean(false), "import Mathlib", "(n : ℕ) (h : 2 < n) : n ≥ 3");
    assert.deepEqual([r.check, r.result, r.witness], ["vacuity", "satisfiable", "n = 3"]);
  });

  it("flags a statement vacuous only when Lean proves that no object satisfies the hypotheses", async () => {
    const lean = new SimLean(true);
    const r = await vacuityTest(lean, "import Mathlib", "(n : ℕ) (h : n < 0) : n = 5");
    assert.equal(r.result, "vacuous");
    assert.ok(lean.calls.at(-1)?.code.includes("¬ ∃ (n : ℕ), (n < 0)"));
    const unknown = await vacuityTest(new SimLean(false), "import Mathlib", "(n : ℕ) (h : n < 0) : n = 5");
    assert.equal(unknown.result, "unknown");
    assert.match(unknown.detail ?? "", /did not show that none exists/);
  });

  it("tries several hypotheses together, and statements with none are satisfiable", async () => {
    const r = await vacuityTest(new SimLean(false), "import Mathlib", "(a b : ℕ) (h1 : a < b) (h2 : b ≤ 2) : a + 1 ≤ b");
    assert.equal(r.result, "satisfiable");
    assert.equal(r.witness, "a = 0, b = 1");
    assert.equal((await vacuityTest(new SimLean(false), "import Mathlib", "(n : ℕ) : n + 0 = n")).result, "satisfiable");
  });

  it("is skipped, with the reason, for a statement it cannot read", async () => {
    for (const statement of ["(G : Type) [Group G] (h : 1 = 1) : True", "∀ n : ℕ, n = n", "(s : Finset ℕ) (h : s.card = 2) : True"]) {
      const r = await vacuityTest(new SimLean(false), "import Mathlib", statement);
      assert.equal(r.result, "skipped", statement);
    }
  });

  it("reads binders", () => {
    const p = parseBinders("(a b : ℕ) {c : ℤ} [Fact p] (h : a < b) : a ≤ b");
    assert.deepEqual(p?.binders.map((b) => [b.open, b.names, b.type]), [["(", ["a", "b"], "ℕ"], ["{", ["c"], "ℤ"], ["[", [], "Fact p"], ["(", ["h"], "a < b"]]);
    assert.equal(p?.conclusion, "a ≤ b");
    assert.equal(parseBinders("n + 0 = n"), undefined);
  });
});

describe("statement hygiene: plausible", () => {
  const result = (text: string, status: LeanCheckResult["status"] = "lean_error"): LeanCheckResult => ({ id: "p", status, messages: [{ severity: "error", pos: { line: 1, column: 0 }, text }], sorries: [], timeMs: 1 });

  it("reads Lean's answer: a counterexample, none, or no such tactic", () => {
    const c = plausibleVerdict(result("Found a counter-example!\nn := 3\nissue: 3 + 1 = 5 does not hold"));
    assert.equal(c.result, "counterexample");
    assert.match(c.detail ?? "", /n := 3/);
    assert.equal(plausibleVerdict(result("Gave up after failing to generate 100 samples")).result, "no_counterexample");
    assert.equal(plausibleVerdict(result("unknown tactic")).result, "unavailable");
    assert.equal(plausibleVerdict({ id: "p", status: "timeout", messages: [], sorries: [], timeMs: 1, error: "timeout" }).result, "unavailable");
  });

  it("tells an unknown tactic from a statement that is not testable and one that does not compile", () => {
    assert.equal(plausibleVerdict(result("unknown namespace 'Plausible'")).result, "unavailable");
    const nt = plausibleVerdict(result("Failed to create a `testable` instance for ∀ (p : Polynomial ℝ), p = p\nWhat to do: ..."));
    assert.equal(nt.result, "not_testable");
    assert.match(nt.detail ?? "", /^Failed to create a `testable` instance/);
    assert.doesNotMatch(nt.detail ?? "", /What to do/);
    const e = plausibleVerdict(result("Function expected at\n  aux_L\nunknown identifier 'aux_L'"));
    assert.equal(e.result, "error");
    assert.match(e.detail ?? "", /^the statement did not compile: Function expected/);
  });

  it("is asked of Lean as one example with the tactic", async () => {
    const lean = new SimLean(false, "Found a counterexample!\nn := 7");
    const r = await plausibleTest(lean, "import Mathlib", "(n : ℕ) : n < 5");
    assert.equal(r.result, "counterexample");
    assert.match(lean.calls[0]?.code ?? "", /example \(n : ℕ\) : n < 5 := by\n {2}plausible/);
    assert.equal((await plausibleTest(lean, "import Mathlib", "n < 5")).result, "skipped");
  });
});
