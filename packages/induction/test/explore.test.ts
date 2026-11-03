import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemContext } from "@seshat/lines";
import { createM13, explore, freeMonoidStructure, LIBRARY_CANDIDATE_KIND, M13_OPTIONS, magmaStructure, natStructure, printEquation, readM13Options } from "../src/index.ts";
import { openMemory } from "./helpers.ts";

const laws = (s: ReturnType<typeof freeMonoidStructure> | ReturnType<typeof natStructure>, maxSize: number) => explore(s as never, { maxSize }).minimal.map((e) => printEquation(e, s.symbols));

describe("theory exploration", () => {
  it("finds the monoid laws from the free monoid, and nothing that follows from them", () => {
    const s = freeMonoidStructure({ seed: 3 });
    const found = laws(s, 5);
    const normal = found.map((l) => l.split(" = ").sort().join(" = "));
    assert.ok(normal.includes(["x * 1", "x"].sort().join(" = ")), found.join("; "));
    assert.ok(normal.includes(["1 * x", "x"].sort().join(" = ")), found.join("; "));
    assert.ok(found.some((l) => /^x \* y \* z|\(x \* y\) \* z/.test(l) || /x \* \(y \* z\)/.test(l)), `associativity in ${found.join("; ")}`);
    // 1 * 1 = 1 follows from x * 1 = x, and so does every longer unit law.
    assert.ok(!found.some((l) => l === "1 * 1 = 1" || l === "1 = 1 * 1"));
    assert.ok(found.length <= 4, `a minimal set is small: ${found.join("; ")}`);
    // Free-monoid words are not commutative: the exploration does not find that law.
    assert.ok(!found.some((l) => /x \* y = y \* x|y \* x = x \* y/.test(l)));
  });

  it("finds the commutativity of addition, and that 0 is a unit, over the numbers; the minimal set drops the consequences", () => {
    const s = natStructure({ seed: 1 });
    const result = explore(s, { maxSize: 5 });
    const text = result.minimal.map((e) => printEquation(e, s.symbols));
    assert.ok(text.some((l) => /x \+ y = y \+ x|y \+ x = x \+ y/.test(l)), text.join("; "));
    assert.ok(text.some((l) => /x \+ 0|0 \+ x/.test(l)));
    assert.ok(text.some((l) => /x \* 0|0 \* x/.test(l)));
    assert.ok(result.equations.length > result.minimal.length, "the raw equations are more than the minimal set");
    assert.ok(result.terms > 10 && !result.capped);
  });

  it("only keeps what held on the test points: a law of a larger magma class is not read off a smaller one", () => {
    // Left projection magmas of sizes 2 and 3: x*y = x holds, commutativity does not.
    const left = (n: number) => ({ size: n, table: Array.from({ length: n * n }, (_, i) => Math.floor(i / n)) });
    const s = magmaStructure([left(2), left(3)], { seed: 1 });
    const text = explore(s, { maxSize: 5 }).minimal.map((e) => printEquation(e, s.symbols));
    assert.ok(text.some((l) => /^x \* y = x$|^x = x \* y$/.test(l)), text.join("; "));
    assert.ok(!text.some((l) => /x \* y = y \* x/.test(l)));
  });

  it("cuts the enumeration at maxTerms and says so", () => {
    const r = explore(natStructure({ seed: 1 }), { maxSize: 7, maxTerms: 40 });
    assert.equal(r.capped, true);
  });
});

describe("the line M13", () => {
  const target = "(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x";
  async function problemOf(statement: string, options: Record<string, unknown> = {}) {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement, header: "import Mathlib", origin: "bench:t" });
    const logs: string[] = [];
    const problem = { line: "M13", runId: "r", problemId: "p", claimId, memory, log: (t: string) => logs.push(t), signal: new AbortController().signal, options: { ...M13_OPTIONS, ...options } } as unknown as ProblemContext;
    return { problem, memory, claimId, logs };
  }

  it("checks its options, and rebuilds on resume", () => {
    assert.equal(readM13Options(M13_OPTIONS).maxSize, 5);
    assert.throws(() => readM13Options({ ...M13_OPTIONS, theory: "ring" }), /option M13\.theory/);
    assert.throws(() => readM13Options({ ...M13_OPTIONS, maxSize: 1 }), /option M13\.maxSize is an integer from 3 to 8/);
    const line = createM13();
    assert.deepEqual([line.id, line.resume, typeof line.hooks.resumeProblem], ["M13", "rebuild", "function"]);
  });

  it("pours the laws of the numbers into the memory as open claims derived from the target, and as candidates", async () => {
    const line = createM13();
    const { problem, memory, claimId } = await problemOf("(n : ℕ) : n + 0 = n");
    await line.hooks.beforeProvers?.(problem);
    const claims = memory.claims().filter((c) => c.origin === "line:M13");
    assert.ok(claims.length >= 3);
    assert.ok(claims.every((c) => c.status === "open" && c.parentId === claimId));
    assert.ok(claims.every((c) => memory.edges({ from: c.claimId, kinds: ["derived_from"] }).some((e) => e.to[0] === claimId)));
    assert.equal(memory.nodes(LIBRARY_CANDIDATE_KIND).length, claims.length);
    const text = (await line.hooks.briefing?.({ ...problem } as never))?.text ?? "";
    assert.match(text, /not theorems/);
    // Running again (a resume) writes nothing twice.
    await line.hooks.resumeProblem?.(problem, {} as never);
    assert.equal(memory.claims().filter((c) => c.origin === "line:M13").length, claims.length);
    assert.equal(memory.nodes(LIBRARY_CANDIDATE_KIND).length, claims.length);
  });

  it("explores the magmas that satisfy the target's hypotheses, with the target's binders, and a sink of its own", async () => {
    const received: string[] = [];
    const line = createM13({ sink: () => ({ add: (c) => void received.push(c.statement) }) });
    const { problem, memory } = await problemOf(target);
    await line.hooks.beforeProvers?.(problem);
    const claims = memory.claims().filter((c) => c.origin === "line:M13");
    assert.ok(claims.length >= 1);
    assert.ok(claims.every((c) => c.statement.startsWith("(M : Type*) [Mul M] (h1 : ∀ x y : M, x * y = x) : ∀ ")));
    assert.deepEqual(received.sort(), claims.map((c) => c.statement).sort());
  });

  it("looks for integer relations among constants, and records them as evidence", async () => {
    const line = createM13();
    const { problem, memory, claimId } = await problemOf("(G : Type) [Group G] : True", { relations: [["pi", "atan(1/5)", "atan(1/239)"], ["pi", "e", "1"]] });
    await line.hooks.beforeProvers?.(problem);
    const nodes = memory.nodes("integer_relation", { claimId });
    assert.equal(nodes.length, 2);
    const machin = nodes[0]?.data as { found: boolean; text: string; significant: boolean };
    assert.equal(machin.found, true);
    assert.equal(machin.significant, true);
    assert.match(machin.text, /pi/);
    const none = nodes[1]?.data as { found: boolean; significant?: boolean };
    assert.ok(!none.found || none.significant === false, "pi, e and 1 are independent as far as 100 digits can tell");
    assert.equal(memory.claims().length, 1, "no claim, no status");
    assert.throws(() => readM13Options({ ...M13_OPTIONS, relations: [["pi"]] }), /option M13\.relations\[0\]/);
  });

  it("says why when there is nothing to explore", async () => {
    const line = createM13();
    const { problem, logs, memory } = await problemOf("(G : Type) [Group G] : True");
    await line.hooks.beforeProvers?.(problem);
    assert.ok(logs.some((l) => /nothing to explore/.test(l)));
    assert.equal(memory.claims().length, 1);
  });
});
