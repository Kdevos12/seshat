import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemContext, SessionContext } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import { createM8, M8_OPTIONS, readM8Options, SMT_RECIPE_KIND, type SmtRecipeData } from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

/** A statement M8's table does not read: the line runs the recipes and stops before any table. */
const TARGET = "(x : ℝ) : x ≤ x + 1";
const BITS = { name: "bits", vars: ["a", "b", "c"], constraints: ["(<= 0 a 1)", "(<= 0 b 1)", "(<= 0 c 1)", "(<= (+ a b) 1)", "(<= (+ b c) 1)"], objective: "(+ a b c)", sense: "maximize" };
const OPTIMUM = "(objectives\n (obj 2)\n)\n(\n  (define-fun s0 () Int\n    1)\n  (define-fun s1 () Int\n    0)\n  (define-fun s2 () Int\n    1)\n)";

/** A host whose `smt.z3` answers every script with `model`, and counts the calls. */
function z3Answering(model: string | null): Registry & { calls: Array<{ smtlib: string }> } {
  const calls: Array<{ smtlib: string }> = [];
  return {
    hash: "0".repeat(64),
    calls,
    host: { host: "test", capabilities: { "smt.z3": { use: ["process"] } } },
    capability: () => ({}),
    invoke: async (name: string, input: unknown) => {
      if (name !== "smt.z3") throw new CapabilityError("unavailable", name, `the test host does not offer ${name}`);
      calls.push(input as { smtlib: string });
      return { output: model === null ? { status: "unknown", exitCode: 0, elapsedMs: 2 } : { status: "sat", model, exitCode: 0, elapsedMs: 2 } };
    },
  } as unknown as Registry & { calls: Array<{ smtlib: string }> };
}

async function problemOf(registry: Registry, options: Record<string, unknown>, memory: MemoryStore = openMemory("orchestrator-test")) {
  const { claimId } = await memory.ensureClaim({ statement: TARGET, header: "import Mathlib", origin: "bench:test" });
  const logs: string[] = [];
  const problem = {
    line: "M8", runId: "run_1", problemId: "p1", claimId, memory, registry, llm: scriptedLlm([{}]), log: (t: string) => logs.push(t),
    signal: new AbortController().signal, options: { ...M8_OPTIONS, ...options },
  } as unknown as ProblemContext;
  return { problem, memory, claimId, logs };
}

describe("M8's Optimize recipe (option optima, plan change CX7)", () => {
  it("makes the optimum an open claim derived from the target, with its smt_recipe node, and says so in the briefing", async () => {
    const z3 = z3Answering(OPTIMUM);
    const { problem, memory, claimId } = await problemOf(z3, { optima: [BITS] });
    const line = createM8();
    await line.hooks.beforeProvers?.(problem);
    assert.equal(z3.calls.length, 1);
    assert.match(z3.calls[0]?.smtlib ?? "", /\(maximize obj\)/);
    const made = memory.claims().filter((c) => c.origin === "line:M8");
    assert.equal(made.length, 1);
    const [claim] = made;
    assert.deepEqual([claim?.status, claim?.kind, claim?.parentId], ["open", "formal", claimId]);
    assert.match(claim?.statement ?? "", /^: \(∃ a b c : Int, .* = 2\) ∧ \(∀ a b c : Int, .* ≤ 2\)$/u);
    assert.ok(memory.edges({ from: claim?.claimId as string, kinds: ["derived_from"] }).some((e) => e.to[0] === claimId));
    const nodes = memory.nodes(SMT_RECIPE_KIND, { claimId: claim?.claimId as string });
    assert.equal(nodes.length, 1);
    const data = nodes[0]?.data as unknown as SmtRecipeData;
    assert.deepEqual([data.recipe, data.answer, data.value, data.target], ["optimum", "optimum", "2", claimId]);
    assert.deepEqual(data.witness, { a: "1", b: "0", c: "1" });
    const text = (await line.hooks.briefing?.(problem as unknown as SessionContext))?.text ?? "";
    assert.match(text, /z3 \(Optimize\) proposes 2 as the optimum of bits, reached at a = 1, b = 0, c = 1; it is an open claim/);
    // Nothing moved: only Lean through validate changes a status.
    assert.ok(memory.claims().every((c) => c.status === "open"));

    // A resumed problem reads the node again: z3 is not asked twice, and nothing is written twice.
    await line.hooks.resumeProblem?.(problem, undefined as never);
    assert.equal(z3.calls.length, 1);
    assert.equal(memory.claims().filter((c) => c.origin === "line:M8").length, 1);
    assert.equal(memory.nodes(SMT_RECIPE_KIND).length, 1);
  });

  it("makes no claim of a malformed or unknown answer: the node records why", async () => {
    for (const model of [OPTIMUM.replace("(obj 2)", "(obj oo)"), OPTIMUM.replace("(obj 2)", "(obj 3)"), null]) {
      const { problem, memory, claimId } = await problemOf(z3Answering(model), { optima: [BITS] });
      await createM8().hooks.beforeProvers?.(problem);
      assert.equal(memory.claims().filter((c) => c.origin === "line:M8").length, 0);
      const [node] = memory.nodes(SMT_RECIPE_KIND, { claimId });
      const data = node?.data as unknown as SmtRecipeData;
      assert.equal(data.answer, model === null ? "unknown" : "malformed");
      assert.equal(data.claimId, undefined);
      assert.equal(data.statement, undefined);
    }
  });

  it("is off by default: no z3 call and no node, and the options read as before", async () => {
    assert.deepEqual(M8_OPTIONS.optima, []);
    const z3 = z3Answering(OPTIMUM);
    const { problem, memory } = await problemOf(z3, {});
    await createM8().hooks.beforeProvers?.(problem);
    assert.equal(z3.calls.length, 0);
    assert.equal(memory.nodes(SMT_RECIPE_KIND).length, 0);
    const { optima: _, ...older } = M8_OPTIONS;
    assert.deepEqual(readM8Options(older).optima, []);
    assert.throws(() => readM8Options({ ...M8_OPTIONS, optima: [{ ...BITS, objective: "(div a 2)" }] }), /M8\.optima\[0\]\.objective/);
  });

  it("does not run where the host has no smt.z3", async () => {
    const none = { hash: "0".repeat(64), host: { host: "test", capabilities: {} }, capability: () => ({}), invoke: async () => assert.fail("no call") } as unknown as Registry;
    const { problem, memory, logs } = await problemOf(none, { optima: [BITS] });
    await createM8().hooks.beforeProvers?.(problem);
    assert.equal(memory.nodes(SMT_RECIPE_KIND).length, 0);
    assert.ok(logs.some((l) => /does not offer smt\.z3/.test(l)));
  });
});
