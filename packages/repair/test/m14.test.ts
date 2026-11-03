import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanSnippet, ValidationReport } from "@seshat/core";
import { buildTable, createM8, M8_OPTIONS, recordTable, REFUTED_HYPOTHESIS_KIND } from "@seshat/induction";
import type { FinishedAttempt, Line, ProblemContext, SessionContext } from "@seshat/lines";
import { CapabilityError, type Registry } from "@seshat/registry";
import { SimulatedDecide } from "../../models/test/simulated-lean.ts";
import { openMemory, scriptedLlm } from "../../induction/test/helpers.ts";
import { createM14, LAKATOS_KIND, M14_OPTIONS, readM14Options, REPAIR_FIDELITY_KIND, situationOf } from "../src/index.ts";

const TARGET = "(n : ℕ) : n ≤ n * n";
const lean = new SimulatedDecide({ truth: () => true });
const registry = {
  hash: "0".repeat(64),
  invoke: async (name: string, input: unknown) => {
    if (name === "lean.check") return { output: { results: await lean.check((input as { snippets: LeanSnippet[] }).snippets) } };
    throw new CapabilityError("unavailable", name, `the test host does not offer ${name}`);
  },
} as unknown as Registry;

const hypotheses = {
  hypotheses: [
    { id: "odd_prime", level: "pattern", informal: "an odd number from 3 on has at most two divisors", premise: "(n) => n % 2 === 1 && n >= 3", conclusion: "(n) => { let c = 0; for (let d = 1; d <= n; d++) if (n % d === 0) c++; return c <= 2; }", statement: "(n : ℕ) (h : n % 2 = 1) (h3 : 3 ≤ n) : (Nat.divisors n).card ≤ 2", uses: ["divisors"] },
  ],
};
const renamed = { hypotheses: [{ ...hypotheses.hypotheses[0], statement: "(m : ℕ) (h : m % 2 = 1) (h3 : 3 ≤ m) : (Nat.divisors m).card ≤ 2" }] };
const answers = (request: { site?: string }, proposed: unknown = hypotheses): unknown => {
  if (request.site === "induction.hypotheses") return proposed;
  if (request.site === "conjecture.relevance") return { score: 0.5 };
  if (request.site === "induction.dag" || request.site === "repair.dag") return { proof: "p", steps: [{ id: "s1", statement: "a step", dependsOn: [] }, { id: "s2", statement: "the repaired claim", dependsOn: ["s1"] }] };
  throw new Error(`unexpected ${request.site}`);
};

async function afterM8(proposed: unknown = hypotheses) {
  const memory = openMemory("orchestrator-test");
  const { claimId } = await memory.ensureClaim({ statement: TARGET, header: "import Mathlib", origin: "bench:t" });
  const logs: string[] = [];
  const problem = {
    line: "M8", runId: "r", problemId: "p", claimId, memory, registry, llm: scriptedLlm([(r: { site?: string }) => answers(r, proposed)]), log: (t: string) => logs.push(t),
    signal: new AbortController().signal, options: { ...M8_OPTIONS, rounds: 1, classical: false, triviality: false, testCases: 0 },
  } as unknown as ProblemContext;
  await createM8().hooks.beforeProvers?.(problem);
  return { memory, claimId, problem: { ...problem, line: "M14", options: { ...M14_OPTIONS } } as ProblemContext, logs };
}

const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
  const found = line.hooks[name];
  assert.ok(found !== undefined);
  return found;
};

describe("the line M14: Lakatos repair of what the table refuted", () => {
  it("makes the repaired conjecture an open claim derived from the target, with its concept recorded", async () => {
    const { memory, claimId, problem, logs } = await afterM8();
    const line = createM14();
    await hook(line, "beforeProvers")(problem);
    const repaired = memory.claims().filter((c) => c.origin === "line:M14");
    assert.equal(repaired.length, 1);
    const [claim] = repaired;
    assert.deepEqual([claim?.status, claim?.kind, claim?.parentId], ["open", "formal", claimId]);
    assert.match(claim?.statement ?? "", /^\(n : ℕ\) \(h : n % 2 = 1\) \(h3 : 3 ≤ n\) \(h_repair : ¬ \(/);
    assert.ok(memory.edges({ from: claim?.claimId as string, kinds: ["derived_from"] }).some((e) => e.to[0] === claimId));
    const nodes = memory.nodes(LAKATOS_KIND, { claimId: claim?.claimId as string });
    assert.equal(nodes.length, 1);
    const data = nodes[0]?.data as { kind: string; exact: boolean; lost: number; excluded: number; counterexamples: string[] };
    assert.deepEqual([data.kind, data.exact, data.lost], ["exception_barring", true, 0]);
    assert.ok(data.excluded > 0 && data.counterexamples.includes("9"));
    assert.ok(logs.length >= 0);
    const text = (await hook(line, "briefing")({ ...problem } as unknown as SessionContext))?.text ?? "";
    assert.match(text, /Small cases refuted "odd_prime"/);
    assert.match(text, /exception-barring/);
    assert.match(text, /open claim/);
    // Nothing moved: the refuted hypothesis became no claim, and no status changed.
    assert.ok(memory.claims().every((c) => c.status === "open"));
  });

  it("writes the premise in the hypothesis's own binder, not the target's", async () => {
    const { memory, problem } = await afterM8(renamed);
    await hook(createM14(), "beforeProvers")(problem);
    const [claim] = memory.claims().filter((c) => c.origin === "line:M14");
    assert.ok(claim !== undefined && claim.kind === "formal", "a formal repair");
    assert.match(claim.statement, /^\(m : ℕ\) \(h : m % 2 = 1\) \(h3 : 3 ≤ m\) \(h_repair : ¬ \(/);
    assert.doesNotMatch(claim.statement.split(":")[0] ?? "", /\bn\b/);
    assert.doesNotMatch(claim.statement.replace(/\(Nat\.divisors m\)/, ""), /\bn\b/);
  });

  it("writes nothing twice when it runs again (resume)", async () => {
    const { memory, problem } = await afterM8();
    const line = createM14();
    await hook(line, "beforeProvers")(problem);
    const claims = memory.claims().length;
    const edges = memory.edges({}).length;
    await hook(line, "resumeProblem")(problem, {} as never);
    assert.equal(memory.claims().length, claims);
    assert.equal(memory.edges({}).length, edges);
    assert.equal(memory.nodes(LAKATOS_KIND).length, 1);
  });

  it("makes an informal repair go through the step DAG first when a column of the concept has no Lean form", async () => {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: TARGET, origin: "bench:t" });
    const numbers = Array.from({ length: 40 }, (_, i) => i);
    const table = await buildTable({ family: "integers", objects: numbers, objectIds: numbers.map(String), columns: [{ name: "n", program: "(n) => n" }, { name: "sqfree", program: "(n) => n > 0 && [4, 9, 25].every((q) => n % q !== 0)", description: "n is squarefree" }] });
    recordTable(memory, claimId, table, "line:M8");
    const verdicts = numbers.map((n) => (n === 0 ? "." : n % 4 === 0 ? "0" : "1")).join("");
    memory.recordNode({ kind: REFUTED_HYPOTHESIS_KIND, claimId, data: { hypothesis: "p", informal: "every number has property P", tableId: table.id, counterexamples: ["4", "8"], verdicts } });
    const llm = scriptedLlm([answers]);
    const problem = { line: "M14", runId: "r", problemId: "p", claimId, memory, llm, log: () => undefined, signal: new AbortController().signal, options: { ...M14_OPTIONS } } as unknown as ProblemContext;
    await hook(createM14(), "beforeProvers")(problem);
    const informal = memory.claims({ kind: "informal" });
    assert.ok(informal.some((c) => /every number has property P, for the objects that do not satisfy/.test(c.statement)), informal.map((c) => c.statement).join(" | "));
    assert.ok(llm.requests.some((r) => r.site === "induction.dag"), "the step DAG was asked for");
    assert.ok(informal.length >= 3, "the repaired claim and the steps of its DAG");
    assert.ok(informal.every((c) => c.status === "open"));
  });

  it("checks its options", () => {
    assert.equal(readM14Options(M14_OPTIONS).maxLakatos, 3);
    assert.throws(() => readM14Options({ ...M14_OPTIONS, maxSuggestions: 9 }), /option M14\.maxSuggestions is an integer from 1 to 4/);
    assert.throws(() => readM14Options({ ...M14_OPTIONS, critics: 0 }), /option M14\.critics is true or false/);
    const line = createM14();
    assert.deepEqual([line.id, line.resume, typeof line.hooks.resumeProblem], ["M14", "rebuild", "function"]);
  });
});

describe("the line M14: typed repairs after a failed attempt", () => {
  const report = (text: string): ValidationReport =>
    ({ verdict: "invalid", method: "repl", reasons: [], axioms: [], messages: [{ severity: "error", pos: { line: 3, column: 2 }, text }], sorries: [], checked: "", submissionHash: "h", editsOutsideRegions: false, holes: false, leanStatus: "lean_error" }) as ValidationReport;
  const attempt = (text: string, extra: Partial<FinishedAttempt> = {}): FinishedAttempt =>
    ({ attemptId: "att_1", prover: "p1", session: 1, model: "m", outcome: "invalid", stoppedBy: "done", checks: 1, turns: 2, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, durationMs: 1, report: report(text), submission: { aux: "", proof: "induction n with\n| zero => simp\n| succ k ih => simp" }, strategy: "induction", ...extra }) as FinishedAttempt;

  it("reads the failure into a situation for the critics", () => {
    const s = situationOf(attempt("unsolved goals\ncase succ\nk : ℕ\nih : 0 + k = k\n⊢ 0 + (k + 1) = k + 1"), TARGET);
    assert.equal(s?.failureClass, "unsolved_goals");
    assert.equal(s?.detail, "unsolved goals at case succ");
    assert.match(s?.goal ?? "", /ih : 0 \+ k = k/);
    assert.equal(situationOf(attempt("x", { outcome: "valid" }), TARGET), undefined);
  });

  it("suggests a repair for the next session's briefing, at most as many as the options allow, and changes no status", async () => {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: TARGET, origin: "bench:t" });
    const logs: string[] = [];
    const problem = { line: "M14", runId: "r", problemId: "p", claimId, memory, llm: scriptedLlm([answers]), log: (t: string) => logs.push(t), signal: new AbortController().signal, options: { ...M14_OPTIONS, maxRepairs: 2 } } as unknown as ProblemContext;
    const line = createM14();
    const annotation = await hook(line, "afterAttempt")(problem, attempt("unsolved goals\ncase succ\nk : ℕ\n⊢ 0 + (k + 1) = k + 1"));
    assert.equal(annotation, undefined);
    let text = (await hook(line, "briefing")({ ...problem } as unknown as SessionContext))?.text ?? "";
    assert.match(text, /Repair suggested by the last failure/);
    assert.match(text, /strong induction|revert/);
    assert.ok(memory.claims().every((c) => c.status === "open"));
    // The cap on suggestions per problem.
    await hook(line, "afterAttempt")(problem, attempt("unsolved goals\ncase succ\nih : P\n⊢ Q"));
    await hook(line, "afterAttempt")(problem, attempt("unsolved goals\ncase succ\nih : P\n⊢ Q"));
    text = (await hook(line, "briefing")({ ...problem } as unknown as SessionContext))?.text ?? "";
    assert.match(text, /Repair suggested/);
    assert.ok(logs.filter((l) => /M14: after/.test(l)).length <= 2 + 1);
    // A failure no critic reads (syntax) leaves no suggestion.
    const quiet = createM14();
    await hook(quiet, "afterAttempt")(problem, attempt("unexpected token", { strategy: "simp" }));
    assert.equal(await hook(quiet, "briefing")({ ...problem } as unknown as SessionContext), undefined);
  });

  it("goes through the step DAG first when it refines, and measures the next formalization against it", async () => {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: TARGET, origin: "bench:t" });
    const llm = scriptedLlm([answers]);
    const problem = { line: "M14", runId: "r", problemId: "p", claimId, memory, llm, log: () => undefined, signal: new AbortController().signal, options: { ...M14_OPTIONS, refine: true } } as unknown as ProblemContext;
    const line = createM14();
    await hook(line, "afterAttempt")(problem, attempt("unsolved goals\ncase succ\nk : ℕ\n⊢ 0 + (k + 1) = k + 1"));
    assert.ok(llm.requests.some((r) => r.site === "induction.dag"));
    assert.ok(memory.claims({ kind: "informal" }).length >= 2, "the steps are informal claims");
    // The next attempt formalizes the steps as aux_ lemmas: the dependency match is recorded.
    await hook(line, "afterAttempt")(problem, attempt("unsolved goals", { outcome: "valid", submission: { aux: "lemma aux_s1 : True := trivial\nlemma aux_s2 : True := by exact aux_s1\n", proof: "exact aux_s2" } }));
    const fidelity = memory.nodes(REPAIR_FIDELITY_KIND, { claimId }).map((n) => n.data as { score: number; declared: number; found: number });
    assert.equal(fidelity.length, 1);
    assert.deepEqual([fidelity[0]?.score, fidelity[0]?.declared, fidelity[0]?.found], [1, 1, 1]);
  });
});
