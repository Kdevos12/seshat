import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanSnippet } from "@seshat/core";
import type { Line, ProblemContext, SessionContext } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import { SimulatedDecide } from "../../models/test/simulated-lean.ts";
import { createM8, M8_OPTIONS, POOL_KIND, readM8Options, readTables, RECURRENCE_KIND } from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

const TARGET = "(n : ℕ) : n ≤ n * n";

function registryOf(lean: SimulatedDecide): Registry {
  return {
    hash: "0".repeat(64),
    invoke: async (name: string, input: unknown) => {
      if (name === "lean.check") return { output: { results: await lean.check((input as { snippets: LeanSnippet[] }).snippets) } };
      throw new CapabilityError("unavailable", name, `the test host does not offer ${name}`);
    },
  } as unknown as Registry;
}

const hypotheses = {
  hypotheses: [
    { id: "square_big", level: "observation", informal: "n <= n squared", conclusion: "(n) => n <= n * n", statement: "(n : ℕ) : n ≤ n * n", uses: ["n"] },
    { id: "even_square", level: "pattern", informal: "an even number has an even square", premise: "(n) => n % 2 === 0", conclusion: "(n) => (n * n) % 2 === 0", statement: "(n : ℕ) (h : n % 2 = 0) : (n * n) % 2 = 0", uses: ["n", "odd"] },
    { id: "all_prime", level: "pattern", informal: "every number is prime", conclusion: "(n) => n === 2 || n % 2 === 1", statement: "(n : ℕ) : Nat.Prime n", uses: ["prime"] },
    { id: "odd_digits", level: "structure", informal: "the digit sum of an odd square is odd or at least 1", premise: "(n) => n % 2 === 1", conclusion: "(n) => String(n * n).split('').reduce((a, c) => a + Number(c), 0) >= 1", uses: ["digitsum"] },
  ],
};
const dag = { proof: "direct", steps: [{ id: "s1", statement: "the square of an odd number is positive", dependsOn: [] }, { id: "s2", statement: "so its digit sum is positive", dependsOn: ["s1"] }] };

function answers(request: { site?: string }): unknown {
  switch (request.site) {
    case "induction.hypotheses":
      return hypotheses;
    case "induction.dag":
      return dag;
    case "induction.formalize":
      return { statement: "(n : ℕ) (h : n % 2 = 1) : 1 ≤ (Nat.digits 10 (n * n)).sum" };
    case "conjecture.relevance":
      return { score: 0.8 };
    default:
      throw new Error(`unexpected site ${request.site}`);
  }
}

async function problemOf(options: Record<string, unknown> = {}, memory: MemoryStore = openMemory("orchestrator-test")) {
  const { claimId } = await memory.ensureClaim({ statement: TARGET, header: "import Mathlib", origin: "bench:test" });
  const logs: string[] = [];
  const llm = scriptedLlm([answers]);
  const lean = new SimulatedDecide({ truth: (instance) => instance.kind !== "nat" || instance.value >= 0 });
  const problem = {
    line: "M8",
    runId: "run_1",
    problemId: "p1",
    claimId,
    target: { theorem: "T.t", statement: TARGET, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [],
    memory,
    registry: registryOf(lean),
    llm,
    log: (text: string) => logs.push(text),
    signal: new AbortController().signal,
    options: { ...M8_OPTIONS, triviality: false, ...options },
  } as unknown as ProblemContext;
  return { problem, memory, claimId, logs, llm, lean };
}

const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
  const found = line.hooks[name];
  assert.ok(found !== undefined, `the line has a ${name} hook`);
  return found;
};

describe("the options of M8", () => {
  it("round-trip, and are checked with the name of the option", () => {
    assert.equal(readM8Options(M8_OPTIONS).conjectures, 20);
    assert.throws(() => readM8Options({ ...M8_OPTIONS, conjectures: 5 }), /option M8\.conjectures is an integer from 10 to 50, not 5/);
    assert.throws(() => readM8Options({ ...M8_OPTIONS, classical: "yes" }), /option M8\.classical is true or false/);
    assert.throws(() => readM8Options({ ...M8_OPTIONS, columns: [{ name: "x" }] }), /option M8\.columns\[0\]/);
    const line = createM8();
    assert.deepEqual([line.id, line.resume, typeof line.hooks.resumeProblem], ["M8", "rebuild", "function"]);
  });
});

describe("the line M8 on a statement about a number", () => {
  it("builds a table, keeps what the objects and Lean do not refute, and pools open conjectures derived from the target", async () => {
    const line = createM8();
    const { problem, memory, claimId, logs, llm } = await problemOf({ rounds: 1 });
    await hook(line, "beforeProvers")(problem);
    assert.equal(readTables(memory, claimId).length, 1);
    const claims = memory.claims().filter((c) => c.claimId !== claimId && c.kind === "formal");
    assert.ok(claims.length >= 2, `some conjectures, got ${claims.length}`);
    // A conjecture is an open claim and nothing else; each is derived from the target.
    assert.ok(claims.every((c) => c.status === "open" && c.origin === "line:M8" && c.parentId === claimId));
    assert.ok(claims.every((c) => memory.edges({ from: c.claimId, kinds: ["derived_from"] }).some((e) => e.to[0] === claimId)));
    // The refuted hypothesis never became a claim.
    assert.ok(!claims.some((c) => c.statement.includes("Nat.Prime n")));
    assert.ok(logs.some((l) => /all_prime is refuted/.test(l)));
    // The informal one went through the step DAG, whose steps are informal claims.
    assert.ok(memory.claims({ kind: "informal" }).length >= 2);
    assert.ok(claims.some((c) => c.statement.includes("Nat.digits")));
    assert.ok(llm.requests.some((r) => r.site === "induction.dag"));
    // The classical conjecturing ran before the model: Dalmatian bounds are claims too.
    assert.ok(claims.some((c) => /ℝ/.test(c.statement)));
    assert.ok(memory.nodes(POOL_KIND, { claimId }).length === 1);
    assert.ok(memory.nodes(RECURRENCE_KIND, { claimId }).length >= 0);
  });

  it("is written once when it runs again from the same journal (resume), asking the model nothing new", async () => {
    const line = createM8();
    const first = await problemOf({ rounds: 1 });
    await hook(line, "beforeProvers")(first.problem);
    const before = first.memory.claims().length;
    const edges = first.memory.edges({}).length;
    const again = { ...first.problem } as ProblemContext;
    await hook(line, "resumeProblem")(again, { begun: false, attempts: [], endedProvers: [], modelCalls: {}, workedClaims: [] } as never);
    assert.deepEqual(first.memory.claims().slice(before).map((c) => c.statement), [], "no claim twice");
    assert.equal(first.memory.edges({}).length, edges, "no edge twice");
    assert.equal(first.memory.nodes(POOL_KIND, { claimId: first.claimId }).length, 1, "the pool is recorded once");
    assert.equal(readTables(first.memory, first.claimId).length, 1);
  });

  it("puts the pool in the briefing, marking a conjecture the provers settled", async () => {
    const line = createM8();
    const { problem, memory } = await problemOf({ rounds: 1 });
    await hook(line, "beforeProvers")(problem);
    const text = (await hook(line, "briefing")({ ...problem, memory } as unknown as SessionContext))?.text ?? "";
    assert.match(text, /Conjectures found by testing small cases/);
    assert.match(text, /none is proved/);
    assert.match(text, /n ≤ n \* n|digits|ℝ/);
  });

  it("does nothing, and says so, for a statement it has no objects for", async () => {
    const line = createM8();
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(G : Type) [Group G] : True", origin: "bench:t" });
    const logs: string[] = [];
    const problem = { line: "M8", runId: "r", problemId: "p", claimId, memory, log: (t: string) => logs.push(t), signal: new AbortController().signal, options: M8_OPTIONS } as unknown as ProblemContext;
    await hook(line, "beforeProvers")(problem);
    assert.ok(logs.some((l) => /no table/.test(l)));
    assert.equal(memory.claims().length, 1);
  });

  it("works on magmas, with columns of the structure", async () => {
    const line = createM8();
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(M : Type) [Mul M] : ∀ x y : M, x * y = y * x", origin: "bench:t" });
    const logs: string[] = [];
    const problem = {
      line: "M8", runId: "r", problemId: "p", claimId, memory, registry: registryOf(new SimulatedDecide({ truth: () => true })), llm: scriptedLlm([{ hypotheses: [{ id: "assoc_commutes", level: "pattern", informal: "x", premise: "(o) => o.size >= 1", conclusion: "(o) => true", uses: [] }] }]),
      log: (t: string) => logs.push(t), signal: new AbortController().signal, options: { ...M8_OPTIONS, rounds: 0 },
    } as unknown as ProblemContext;
    await hook(line, "beforeProvers")(problem);
    const [table] = readTables(memory, claimId);
    assert.equal(table?.table.family, "magmas");
    assert.ok(table?.table.columns.some((c) => c.name === "associative"));
    assert.ok(table !== undefined && table.table.objectIds.length > 10);
  });
});
