import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvokeContext } from "@seshat/registry";
import { headerProblems, isIdentifier, leanTextProblems, NO_EXTRA_TACTICS, proveAutoFactory, reconstructionTactics, runBattery, TACTICS, tacticsFor, UnsafeText } from "../src/index.ts";
import { Posteriors } from "../src/index.ts";
import { ScriptedLean } from "./fake-lean.ts";

const invoke = { signal: new AbortController().signal } as unknown as InvokeContext;

describe("the screen of text that reaches Lean (review I5)", () => {
  it("lets the battery's own tactics, honest statements and headers through", () => {
    for (const t of TACTICS) assert.deepEqual(leanTextProblems(t.script), [], t.name);
    assert.deepEqual(leanTextProblems("(n m : ℕ) (h : n < m) : n + 1 ≤ m"), []);
    assert.deepEqual(headerProblems("import Mathlib\nopen Nat\n\nnamespace Demo"), []);
  });

  it("refuses a statement that carries a command into the file, in the battery and in prove.auto", async () => {
    const lean = new ScriptedLean({});
    await assert.rejects(
      runBattery({ checker: lean, goal: { header: "import Mathlib", statement: ": True := by trivial\n#eval IO.println 1\nexample : True" }, tactics: tacticsFor(NO_EXTRA_TACTICS, { hammerCutoffs: [] }), domain: "general", posteriors: new Posteriors(), order: { mode: "mean" }, cpuBudgetSec: 5, signal: invoke.signal }),
      UnsafeText,
    );
    assert.equal(lean.calls.length, 0, "nothing reached Lean");
    const tool = await proveAutoFactory(() => lean)({ settings: {} } as never);
    await assert.rejects(tool.invoke({ statement: ": True", header: "import Mathlib\nrun_cmd logInfo \"x\"\n#eval 1" } as never, invoke), UnsafeText);
    await assert.rejects(tool.invoke({ statement: ": True -- and then" } as never, invoke), UnsafeText);
    assert.equal(lean.calls.length, 0);
  });

  it("takes only Lean identifiers as premise names", () => {
    assert.ok(isIdentifier("Nat.add_comm") && isIdentifier("h₁") && isIdentifier("foo'"));
    for (const bad of ["a b", "a]\n#eval 1", "a; sorry", "(add safe x)", "", "a,b", "x\ny"]) assert.equal(isIdentifier(bad), false, bad);
    assert.throws(() => reconstructionTactics(["Nat.add_comm", "x]; #eval 1"], { have: new Set() }), UnsafeText);
  });
});
