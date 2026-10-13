import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanCheckResult, LeanMessage, LeanSnippet } from "@math-harness/core";
import {
  checkExpectations,
  leanCheckImplementation,
  loadCatalog,
  Registry,
  runContract,
  type HealthAwareChecker,
  type ImplementationFactory,
} from "../src/index.ts";
import { addManifest, writeCatalog } from "./helpers.ts";

describe("checkExpectations", () => {
  const output = {
    results: [
      { id: "a", status: "valid", messages: [{ severity: "info", pos: { line: 4 }, text: "'t' depends on axioms: [propext]" }] },
      { id: "b", status: "sorry", messages: [] },
    ],
  };

  it("passes when every expectation holds", () => {
    assert.deepEqual(
      checkExpectations(output, [
        { path: "results", length: 2 },
        { path: "results.0.status", equals: "valid" },
        { path: "results.0.messages", some: [{ path: "pos.line", atLeast: 3 }, { path: "text", matches: "^'t' depends" }] },
        { path: "results", every: [{ path: "id", matches: "^[ab]$" }] },
        { path: "results.1.error", exists: false },
        { path: "results.0.messages.0.pos.line", atMost: 4 },
      ]),
      [],
    );
  });

  it("says what failed, and where", () => {
    assert.deepEqual(
      checkExpectations(output, [
        { path: "results.1.status", equals: "valid" },
        { path: "results.0.messages", some: [{ path: "severity", equals: "error" }] },
        { path: "results", every: [{ path: "status", equals: "valid" }] },
        { path: "results.2", exists: true },
        { path: "results.0.id", atLeast: 1 },
        { path: "results.0.missing", equals: 1 },
      ]),
      [
        'results.1.status: expected "valid", found "sorry"',
        'results.0.messages: no item has severity equals "error" (items: [{"severity":"info","pos":{"line":4},"text":"\'t\' depends on axioms: [propext]"}])',
        'results.1.status: expected "valid", found "sorry"',
        "results.2: expected a value, found nothing",
        'results.0.id: expected at least 1, found "a"',
        "results.0.missing: nothing there",
      ],
    );
  });
});

describe("runContract", () => {
  const contract = {
    capability: "math.add",
    cases: [
      { name: "small", input: { a: 1, b: 2 }, expect: [{ path: "sum", equals: 3 }] },
      { name: "negative", input: { a: -1, b: -2 }, expect: [{ path: "sum", equals: -3 }] },
    ],
  };
  const catalog = loadCatalog(writeCatalog({ "math.add": { manifest: addManifest(), contract } }));

  it("runs every case and reports the failures", async () => {
    const wrong: ImplementationFactory = () => ({
      invoke: async (input) => {
        const { a, b } = input as { a: number; b: number };
        return { sum: Math.abs(a + b) };
      },
    });
    const registry = new Registry({ catalog, host: { host: "test", capabilities: { "math.add": { use: ["js"] } } }, factories: { "js-add": wrong } });
    const report = await runContract(registry, "math.add");
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.implementation, "js");
    assert.deepEqual(report.cases.map((c) => [c.name, c.passed, c.failures]), [
      ["small", true, []],
      ["negative", false, ["sum: expected -3, found 3"]],
    ]);
  });

  it("runs an implementation the host does not use, and reports errors as failures", async () => {
    const registry = new Registry({
      catalog,
      host: { host: "test", capabilities: { "math.add": { use: ["js"] } } },
      factories: {
        "js-add": () => ({ invoke: async () => ({ sum: 0 }) }),
        "js-add-backup": () => ({
          invoke: async () => {
            throw new Error("solver crashed");
          },
        }),
      },
    });
    const report = await runContract(registry, "math.add", { implementation: "backup", only: ["small"] });
    assert.equal(report.implementation, "backup");
    assert.deepEqual(report.cases.map((c) => c.failures), [["failed: math.add/backup failed: solver crashed"]]);
  });
});

/**
 * What Lean v4.27.0 is expected to answer for the files of the lean.check contract. This only
 * checks that the contract's expectations are well written: whether Lean really answers so is
 * what running the contract against a server tells.
 */
class ExpectedLean implements HealthAwareChecker {
  readonly implementation = "expected-lean";
  readonly version = "0";

  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    return snippets.map((s) => this.answer(s));
  }

  private answer({ id, code }: LeanSnippet): LeanCheckResult {
    const info = (line: number, text: string): LeanMessage => ({ severity: "info", pos: { line, column: 0 }, text });
    const result = (status: LeanCheckResult["status"], messages: LeanMessage[], extra: Partial<LeanCheckResult> = {}): LeanCheckResult => ({
      id, status, messages, sorries: [], timeMs: 5, ...extra,
    });
    if (code.includes("Lean.versionString")) return result("valid", [info(1, '"4.27.0"')]);
    if (code.includes("#print axioms Harness.em")) return result("valid", [info(3, "'Harness.em' depends on axioms: [propext, Classical.choice, Quot.sound]")]);
    if (code.includes("#print axioms Harness.two")) return result("valid", [info(3, "'Harness.two' does not depend on any axioms")]);
    if (code.includes("1609.08688")) return result("valid", [info(7, "'Harness.«1609.08688».t' does not depend on any axioms")]);
    if (code.includes("#check @Harness.add_zero'")) {
      return result("valid", [
        info(4, "'Harness.add_zero'' does not depend on any axioms"),
        info(7, "@Harness.add_zero' : ∀ (n : Nat), @Eq.{1} Nat (@HAdd.hAdd.{0, 0, 0} Nat Nat Nat (@instHAdd.{0} Nat instAddNat) n (@OfNat.ofNat.{0} Nat 0 (instOfNatNat 0))) n"),
      ]);
    }
    if (code.includes("Harness.le_succ'")) {
      return result("sorry", [{ severity: "warning", pos: { line: 1, column: 8 }, text: "declaration uses 'sorry'" }], {
        sorries: [{ pos: { line: 2, column: 2 }, goal: "n : Nat\n⊢ n ≤ n + 1" }],
      });
    }
    if (code.includes("Harness.wrong")) return result("lean_error", [{ severity: "error", pos: { line: 2, column: 2 }, text: "The rfl tactic failed." }]);
    if (code.includes("Harness.three_eq_four")) return result("lean_error", [{ severity: "error", pos: { line: 8, column: 2 }, text: "The rfl tactic failed." }]);
    if (code.includes("FormalConjectures.Util.ProblemImports")) {
      return result("valid", [{ severity: "warning", pos: { line: 1, column: 0 }, text: "missing copyright header" }]);
    }
    if (code.includes("IO.sleep")) return result("timeout", [], { error: "Lean REPL command timed out in 5 seconds" });
    return result("repl_error", [], { error: "unexpected file" });
  }
}

describe("the lean.check contract", () => {
  it("is consistent with the answers Lean is expected to give", async () => {
    const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
    const registry = new Registry({
      catalog,
      host: { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } },
      factories: { kimina: () => leanCheckImplementation(new ExpectedLean()) },
    });
    const report = await runContract(registry, "lean.check");
    assert.equal(report.cases.length, 9);
    assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => [c.name, c.failures]), []);
  });
});
