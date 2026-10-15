import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import { loadCatalog, Registry } from "@seshat/registry";
import {
  distilFile,
  type GoalsInput,
  LeanGoals,
  LeanMetaError,
  pantographFactory,
  pantographImplementation,
  PantographRepl,
  renderGoal,
} from "../src/index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-pantograph.ts", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));

/** The settings that run the fake Pantograph. */
function fake(modules = ["Mathlib"]) {
  return { command: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE], modules };
}

function registryWith(settings: Record<string, Json>): Registry {
  return new Registry({
    catalog,
    host: { host: "test", capabilities: { "lean.goals": { use: ["pantograph"], settings: { pantograph: settings } } } },
    factories: { pantograph: pantographFactory() },
  });
}

const signal = () => new AbortController().signal;
const context = (scope: string, s: AbortSignal = signal()) => ({ signal: s, timeoutMs: 60_000, scope });
const call = (input: GoalsInput) => input as unknown as Json;

describe("the goals of lean.goals", () => {
  it("are shown as Lean shows them", () => {
    const goal = {
      userName: "succ",
      target: { pp: "a + b = b + a" },
      vars: [
        { userName: "a", type: { pp: "ℕ" } },
        { userName: "b", type: { pp: "ℕ" } },
        { userName: "n", isInaccessible: true, type: { pp: "ℕ" } },
        { userName: "k", type: { pp: "ℕ" }, value: { pp: "a + 1" } },
        { userName: "h", type: { pp: "a ≤ b" } },
      ],
    };
    assert.equal(renderGoal(goal), "case succ\na b n✝ : ℕ\nk : ℕ := a + 1\nh : a ≤ b\n⊢ a + b = b + a");
    assert.equal(renderGoal({ userName: "[anonymous]", target: { pp: "True" } }), "⊢ True");
  });

  it("come from a file whose imports are blanked, and only those Lean has loaded", () => {
    assert.equal(distilFile("/- doc -/\nimport Mathlib\n\nopen Nat\n", ["Mathlib"]), "\n\n\nopen Nat\n");
    assert.throws(() => distilFile("import Mathlib\nimport Other.Module\n", ["Mathlib"]), /imports Other\.Module, which this Lean has not loaded \(it has Mathlib\)/);
  });
});

describe("lean.goals over Pantograph", () => {
  it("starts a statement, runs tactics, and keeps every state of a scope", async () => {
    const registry = registryWith(fake());
    try {
      const goals = new LeanGoals(registry, { scope: "s1" });
      assert.deepEqual(await goals.start("(n : ℕ) : n + 0 = n", { header: "import Mathlib\nopen Nat" }), { state: 0, goals: ["n : ℕ\n⊢ n + 0 = n"] });
      const refused = "error: unknown identifier 'notDefinedAnywhere'";
      assert.deepEqual(await goals.tactic(0, "exact notDefinedAnywhere"), { error: refused, messages: [refused] });
      const unparsed = await goals.tactic(0, "(");
      assert.match("error" in unparsed ? unparsed.error : "", /^the tactic does not parse: /);
      assert.deepEqual(await goals.tactic(0, "simp", { timeoutSec: 20 }), { state: 1, goals: [], messages: [] });
      assert.deepEqual(await goals.goals(0), ["n : ℕ\n⊢ n + 0 = n"]);

      const other = new LeanGoals(registry, { scope: "s2" });
      assert.equal((await other.start(": 1 = 1 ∧ 2 = 2")).state, 0, "each scope numbers its states from 0");
      const split = await other.tactic(0, "constructor");
      assert.deepEqual("goals" in split ? split.goals : undefined, ["case left\n⊢ 1 = 1", "case right\n⊢ 2 = 2"]);
      const right = await other.tactic(1, "rfl", { goal: 1 });
      assert.deepEqual("goals" in right ? [right.state, right.goals] : undefined, [2, ["case left\n⊢ 1 = 1"]]);
    } finally {
      await registry.close();
    }
  });

  it("gives one target per declaration with a sorry", async () => {
    const registry = registryWith(fake());
    try {
      const code = "import Mathlib\n\ntheorem a (x y : ℕ) (h : x ≤ y) : x < y + 1 := by\n  sorry\n\ntheorem b : True := trivial\n\ntheorem c : 2 = 2 := by\n  sorry\n";
      assert.deepEqual(await new LeanGoals(registry, { scope: "s" }).sketch(code), [
        { state: 0, goals: ["x y : ℕ\nh : x ≤ y\n⊢ x < y + 1"] },
        { state: 1, goals: ["⊢ 2 = 2"] },
      ]);
    } finally {
      await registry.close();
    }
  });

  it("refuses an unknown state, a statement Lean refuses, and a module it has not loaded", async () => {
    const registry = registryWith(fake());
    try {
      const goals = new LeanGoals(registry, { scope: "s" });
      const rejected = (pattern: RegExp) => (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected" && pattern.test(e.details.join("\n"));
      await assert.rejects(goals.goals(7), rejected(/there is no state 7/));
      await assert.rejects(goals.start("(n : ℕ) : notDefinedAnywhere n"), rejected(/unknown identifier 'notDefinedAnywhere'/));
      await assert.rejects(goals.start(": True", { header: "import Other" }), rejected(/imports Other/));
    } finally {
      await registry.close();
    }
  });

  it("deletes a scope's states when it is released", async () => {
    const repl = new PantographRepl(fake());
    const impl = pantographImplementation(repl);
    try {
      await impl.invoke(call({ op: "start", statement: "(n : ℕ) : n + 0 = n" }), context("a"));
      await impl.invoke(call({ op: "start", statement: ": True" }), context("b"));
      assert.equal((await repl.request("stat", {}, signal())).nGoals, 2);
      await impl.release?.("a", { signal: signal() });
      assert.equal((await repl.request("stat", {}, signal())).nGoals, 1);
      await assert.rejects(impl.invoke(call({ op: "goals", state: 0 }), context("a")), /there is no state 0/);
      assert.deepEqual(await impl.invoke(call({ op: "goals", state: 0 }), context("b")), { state: 0, goals: ["⊢ True"] });
      assert.equal((await repl.request("options.print", {}, signal())).timeout, 60_000);
    } finally {
      await impl.close?.();
    }
  });

  it("stops Lean on an abort, and refuses the states it held", async () => {
    const repl = new PantographRepl(fake());
    const impl = pantographImplementation(repl);
    try {
      await impl.invoke(call({ op: "start", statement: ": True" }), context("a"));
      const controller = new AbortController();
      const slow = impl.invoke(call({ op: "tactic", state: 0, tactic: "slow" }), context("a", controller.signal));
      setTimeout(() => controller.abort(new Error("time is up")), 100);
      await assert.rejects(slow, /time is up/);
      assert.equal(repl.running, false);
      await assert.rejects(impl.invoke(call({ op: "goals", state: 0 }), context("a")), /state 0 was lost when Lean restarted/);
      assert.deepEqual(await impl.invoke(call({ op: "start", statement: ": True" }), context("a")), { state: 1, goals: ["⊢ True"] });
      await assert.rejects(impl.invoke(call({ op: "tactic", state: 1, tactic: "crash" }), context("a")), /Pantograph stopped: it exited \(code 3\)/);
      assert.deepEqual(await impl.invoke(call({ op: "start", statement: ": False" }), context("a")), { state: 2, goals: ["⊢ False"] });
    } finally {
      await impl.close?.();
    }
  });

  it("is unreachable when the REPL cannot start, and answers its health check", async () => {
    for (const settings of [fake(["Missing"]), { command: "/nonexistent/pantograph-repl" }]) {
      const registry = registryWith(settings);
      try {
        await assert.rejects(new LeanGoals(registry, { scope: "s" }).start(": True"), (e: unknown) => e instanceof LeanMetaError && e.kind === "unreachable" && /did not start/.test(e.message + e.details.join("\n")));
      } finally {
        await registry.close();
      }
    }
    const impl = pantographImplementation(new PantographRepl(fake()), "fake 0.3.13");
    try {
      assert.deepEqual(await impl.health?.({ signal: signal() }), { ok: true, detail: "fake 0.3.13, 0 goal state(s)" });
    } finally {
      await impl.close?.();
    }
  });
});

describe("the capability lean.goals", () => {
  it("loads with its contract: direct, stateful, one implementation over Pantograph", () => {
    const capability = catalog.capabilities.get("lean.goals");
    assert.ok(capability);
    assert.deepEqual([capability.manifest.exposure, capability.manifest.stateful], ["direct", true]);
    assert.deepEqual(
      capability.manifest.implementations.map((i) => [i.id, i.kind === "inproc" ? i.factory : ""]),
      [["pantograph", "pantograph"]],
    );
    assert.ok(capability.contract.some((c) => c.before !== undefined));
    assert.ok(capability.contract.some((c) => c.fails !== undefined));
  });
});
