import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Line, ProblemContext } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import {
  CEGIS_DROP_KIND,
  closedFormDisagreement,
  closedFormStatement,
  COUNTEREXAMPLE_KIND,
  createM8,
  evalClosedForm,
  growthDisagreement,
  growthProgram,
  growthStatement,
  M8_OPTIONS,
  parseClosedForm,
  parseGrowth,
  rat,
  readM8Options,
  rsolveProgram,
  SEQUENCE_GUESS_KIND,
  type SequenceGuessData,
  sequenceOf,
  statementProblem,
  guessHolonomic,
} from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

const catalan = (count: number): bigint[] => {
  const out: bigint[] = [1n];
  for (let k = 0n; out.length < count; k++) out.push(((out.at(-1) as bigint) * 2n * (2n * k + 1n)) / (k + 2n));
  return out;
};

/** (2n)! / (n! (n+1)!), as sympy prints Catalan's rsolve solution once its gammas are factorials. */
const CATALAN_TREE = ["mul", ["fact", ["mul", ["int", "2"], ["n"]]], ["pow", ["fact", ["n"]], ["int", "-1"]], ["pow", ["fact", ["add", ["n"], ["int", "1"]]], ["int", "-1"]]];
/** (2n)! / (n!)^2: the central binomial coefficient, which Catalan's terms refute from n = 1. */
const CENTRAL_TREE = ["mul", ["fact", ["mul", ["int", "2"], ["n"]]], ["pow", ["fact", ["n"]], ["int", "-2"]]];
const CATALAN_GROWTH = { base: ["4", "1"], exponent: ["-3", "2"], constant: ["pow", ["pi"], ["rat", "-1", "2"]] };

describe("CX8's strict readers and Seshat's own Lean writers", () => {
  it("read a closed-form tree, evaluate it exactly and write it in Lean over ℚ", () => {
    const f = parseClosedForm(CATALAN_TREE);
    assert.ok(f !== undefined);
    const terms = catalan(31);
    assert.equal(closedFormDisagreement(f, terms), undefined);
    assert.deepEqual(evalClosedForm(f, 5n), rat(42));
    const statement = closedFormStatement("catalan n", f);
    assert.equal(statement, "(n : ℕ) : ((catalan n : ℕ) : ℚ) = (((Nat.factorial (2 * n) : ℕ) : ℚ) * ((Nat.factorial n : ℕ) : ℚ)⁻¹ * ((Nat.factorial (n + 1) : ℕ) : ℚ)⁻¹)");
    assert.equal(statementProblem(statement as string), undefined);
    // The central binomial coefficient fails at n = 1.
    assert.equal(closedFormDisagreement(parseClosedForm(CENTRAL_TREE) as NonNullable<ReturnType<typeof parseClosedForm>>, terms), 1);
  });

  it("refuse whatever is outside the grammar or its limits", () => {
    for (const bad of [
      "(2n)!/(n!(n+1)!)",
      ["sin", ["n"]],
      ["int", "1.5"],
      ["int", "1".repeat(41)],
      ["rat", "1", "0"],
      ["add", ["n"]],
      ["pow", ["n"]],
      ["n", "x"],
      { op: "n" },
      Array.from({ length: 13 }).reduce<unknown>((acc) => ["fact", acc], ["n"]),
      ["add", ...Array.from({ length: 9 }, () => ["n"])],
    ]) {
      assert.equal(parseClosedForm(bad), undefined, JSON.stringify(bad));
    }
    // In the grammar but with no exact Lean writing: π in a sequence's closed form, a subtraction inside a factorial.
    assert.equal(closedFormStatement("f n", parseClosedForm(["mul", ["pi"], ["n"]]) as NonNullable<ReturnType<typeof parseClosedForm>>), undefined);
    assert.equal(closedFormStatement("f n", parseClosedForm(["fact", ["add", ["n"], ["int", "-1"]]]) as NonNullable<ReturnType<typeof parseClosedForm>>), undefined);
    for (const bad of [null, [], { base: ["4"], exponent: ["-3", "2"] }, { base: ["4", "1"], exponent: ["-3", "13"] }, { base: ["0", "1"], exponent: ["1", "1"] }, { base: ["4", "1"], exponent: ["1", "1"], extra: 1 }, { base: ["4", "1"], exponent: ["1", "1"], constant: ["sin", ["pi"]] }, { base: ["4", "1"], exponent: ["1", "1"], constant: ["int", "-1"] }]) {
      assert.equal(parseGrowth(bad), undefined, JSON.stringify(bad));
    }
  });

  it("write a growth as IsTheta, or IsEquivalent with an identified constant, and check it against the tail", () => {
    const g = parseGrowth(CATALAN_GROWTH);
    assert.ok(g !== undefined);
    const statement = growthStatement("catalan n", g);
    assert.equal(statement, ": Asymptotics.IsEquivalent Filter.atTop (fun n : ℕ => ((catalan n : ℕ) : ℝ)) (fun n : ℕ => (Real.sqrt Real.pi)⁻¹ * (4 : ℝ) ^ n * (n : ℝ) ^ ((-3 : ℝ) / 2))");
    assert.equal(statementProblem(statement as string), undefined);
    assert.equal(growthDisagreement(g, catalan(31)), undefined);
    const theta = parseGrowth({ base: ["1", "1"], exponent: ["3", "1"] });
    assert.equal(growthStatement("f n", theta as NonNullable<typeof theta>), ": Asymptotics.IsTheta Filter.atTop (fun n : ℕ => ((f n : ℕ) : ℝ)) (fun n : ℕ => (n : ℝ) ^ (3 : ℝ))");
    // A wrong exponent, a wrong base and a wrong constant are each refused by the terms.
    assert.match(growthDisagreement({ ...g, exponent: rat(-1) }, catalan(31)) ?? "", /log-log slope/);
    assert.match(growthDisagreement({ ...g, base: rat(3) }, catalan(31)) ?? "", /ratio/);
    assert.match(growthDisagreement({ ...g, constant: parseClosedForm(["int", "1"]) as NonNullable<ReturnType<typeof parseClosedForm>> }, catalan(31)) ?? "", /constant/);
  });

  it("write programs for compute.python that start with their data", () => {
    const rec = guessHolonomic(catalan(31), { maxOrder: 2, maxDegree: 2, minSurplus: 6 });
    assert.ok(rec !== undefined);
    const rsolve = rsolveProgram(rec, catalan(31));
    assert.match(rsolve, /^DATA = "/u);
    assert.match(rsolve, /sympy\.rsolve\(/u);
    const growth = growthProgram(catalan(31).slice(1), 1);
    assert.match(growth, /nsimplify/u);
    assert.match(growth, /mpmath\.identify/u);
    assert.deepEqual(JSON.parse(JSON.parse(/^DATA = (".*")\n/u.exec(growth)?.[1] as string) as string).terms.slice(0, 3), ["1", "2", "5"]);
  });

  it("take the exact non-negative integers of a column, up to the first that is not one", () => {
    assert.deepEqual(sequenceOf("c", [1, 2, 3, 2 ** 60, 5]).terms, [1n, 2n, 3n]);
    assert.deepEqual(sequenceOf("c", [1, null, 3]).terms, [1n]);
  });
});

const TARGET = "(n : ℕ) : n ≤ n * n";
const COLUMNS = [
  { name: "catalan", program: "(n) => { let c = 1n; for (let k = 0n; k < BigInt(n); k++) c = c * 2n * (2n * k + 1n) / (k + 2n); return Number(c); }", lean: "catalan n" },
  { name: "planted", program: "(n) => n * n * n + 5", lean: "n ^ 3 + 5" },
];

type Answer = (kind: "rsolve" | "growth", data: Record<string, unknown>) => string;

/** A fake `compute.python`: reads the data line of a CX8 program and answers with `answer`; every call is recorded. */
function registryOf(offered: readonly string[], answer: Answer): Registry & { calls: Array<{ name: string; code?: string }> } {
  const calls: Array<{ name: string; code?: string }> = [];
  return {
    hash: "0".repeat(64),
    calls,
    offers: (id: string) => offered.includes(id),
    release: async () => {},
    invoke: async (name: string, input: unknown) => {
      const code = (input as { code?: string }).code;
      if (name.startsWith("compute.")) calls.push({ name, ...(code !== undefined ? { code } : {}) });
      if (name !== "compute.python" || !offered.includes(name) || code === undefined) throw new CapabilityError("unavailable", name, `the test host does not offer ${name}`);
      const m = /^DATA = (".*")\n/u.exec(code);
      assert.ok(m !== null, "the program starts with its data");
      const data = JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>;
      return { output: { stdout: `${answer(/sympy\.rsolve\(/u.test(code) ? "rsolve" : "growth", data)}\n`, result: null } };
    },
  } as unknown as Registry & { calls: Array<{ name: string; code?: string }> };
}

/** The fake's answers: Catalan's closed form and growth, the planted sequence's growth (n³ + 5 ~ n³), and no closed form for it. */
const good: Answer = (kind, data) => {
  if (kind === "rsolve") return JSON.stringify({ closed: (data.initial as string[]).length === 1 ? CATALAN_TREE : null });
  const terms = data.terms as string[];
  return JSON.stringify(terms[0] === "1" ? CATALAN_GROWTH : { base: ["1", "1"], exponent: ["3", "1"], constant: ["int", "1"] });
};

async function problemOf(registry: Registry, options: Record<string, unknown> = {}, memory: MemoryStore = openMemory("orchestrator-test")) {
  const { claimId } = await memory.ensureClaim({ statement: TARGET, header: "import Mathlib", origin: "bench:test" });
  const logs: string[] = [];
  const llm = scriptedLlm([{ score: 0.5 }]);
  const problem = {
    line: "M8",
    runId: "run_1",
    problemId: "p1",
    claimId,
    target: { theorem: "T.t", statement: TARGET, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [],
    memory,
    registry,
    llm,
    log: (text: string) => logs.push(text),
    signal: new AbortController().signal,
    options: { ...M8_OPTIONS, guess: true, triviality: false, rounds: 0, maxNumber: 40, columns: COLUMNS, ...options },
  } as unknown as ProblemContext;
  return { problem, memory, claimId, logs };
}

const before = (line: Line) => line.hooks.beforeProvers as NonNullable<Line["hooks"]["beforeProvers"]>;
const guessed = (memory: MemoryStore, claimId: string) =>
  memory
    .claims()
    .filter((c) => c.claimId !== claimId && memory.edges({ from: c.claimId, kinds: ["derived_from"] }).some((e) => e.to[0] === claimId && /^guess:/u.test(e.note ?? "")))
    .map((c) => c.statement);

describe("CX8 in line M8, with a fake compute.python", () => {
  it("makes Catalan's closed form and the growth of a planted sequence open conjectures, each with its evidence", async () => {
    const registry = registryOf(["compute.python"], good);
    const { problem, memory, claimId, logs } = await problemOf(registry);
    await before(createM8())(problem);
    const statements = guessed(memory, claimId);
    assert.ok(statements.includes("(n : ℕ) : ((catalan n : ℕ) : ℚ) = (((Nat.factorial (2 * n) : ℕ) : ℚ) * ((Nat.factorial n : ℕ) : ℚ)⁻¹ * ((Nat.factorial (n + 1) : ℕ) : ℚ)⁻¹)"), statements.join("\n"));
    assert.ok(statements.includes(": Asymptotics.IsEquivalent Filter.atTop (fun n : ℕ => ((n ^ 3 + 5 : ℕ) : ℝ)) (fun n : ℕ => (1 : ℝ) * (n : ℝ) ^ (3 : ℝ))"), statements.join("\n"));
    assert.ok(statements.some((s) => s.startsWith(": Asymptotics.IsEquivalent Filter.atTop (fun n : ℕ => ((catalan n : ℕ) : ℝ))")));
    // Each is an open claim of the line with its sequence_guess node; the planted sequence's empty rsolve is a node on the target.
    for (const statement of statements) {
      const claim = memory.claims().find((c) => c.statement === statement);
      assert.equal(claim?.status, "open");
      assert.equal(claim?.origin, "line:M8");
      const nodes = memory.nodes(SEQUENCE_GUESS_KIND, { claimId: claim?.claimId as string }).map((n) => n.data as unknown as SequenceGuessData);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]?.answer, "found");
    }
    const onTarget = memory.nodes(SEQUENCE_GUESS_KIND, { claimId }).map((n) => n.data as unknown as SequenceGuessData);
    assert.deepEqual(onTarget.map((d) => `${d.column}/${d.method}/${d.answer}`), ["planted/rsolve/none"]);
    // Only compute.python was asked, four times: two columns, a closed form and a growth each.
    assert.equal(registry.calls.length, 4);
    assert.ok(registry.calls.every((c) => c.name === "compute.python"));
    assert.ok(logs.some((l) => /a closed form of the column catalan through compute\.python: found/u.test(l)));
    // A resume rebuilds the pool and asks the tool nothing.
    const again = await problemOf(registry, {}, memory);
    await before(createM8())(again.problem);
    assert.equal(registry.calls.length, 4);
  });

  it("gives nothing for malformed output", async () => {
    const registry = registryOf(["compute.python"], (kind) => (kind === "rsolve" ? "Traceback (most recent call last):\nNameError" : JSON.stringify({ ...CATALAN_GROWTH, constant: ["sin", ["pi"]] })));
    const { problem, memory, claimId } = await problemOf(registry);
    await before(createM8())(problem);
    assert.deepEqual(guessed(memory, claimId), []);
    const nodes = memory.nodes(SEQUENCE_GUESS_KIND, { claimId }).map((n) => n.data as unknown as SequenceGuessData);
    assert.equal(nodes.length, 4);
    assert.ok(nodes.every((d) => d.answer === "malformed" && d.statement === undefined));
  });

  it("drops a closed form that disagrees with a known term, and puts the term in the counterexample set", async () => {
    const registry = registryOf(["compute.python"], (kind, data) => (kind === "rsolve" ? JSON.stringify({ closed: (data.initial as string[]).length === 1 ? CENTRAL_TREE : null }) : JSON.stringify({ growth: null })));
    const { problem, memory, claimId } = await problemOf(registry);
    await before(createM8())(problem);
    assert.deepEqual(guessed(memory, claimId), []);
    const catalanNode = memory.nodes(SEQUENCE_GUESS_KIND, { claimId }).map((n) => n.data as unknown as SequenceGuessData).find((d) => d.column === "catalan" && d.method === "rsolve");
    assert.equal(catalanNode?.answer, "disagrees");
    assert.equal(catalanNode?.disagreesAt, 1);
    assert.ok(memory.nodes(COUNTEREXAMPLE_KIND, { claimId }).some((n) => (n.data as { refutes?: string }).refutes === "guess/catalan/closed_form"));
    // A second process meets the set first: the drop is counted.
    const second = openMemory("orchestrator-test");
    const run = await problemOf(registry, {}, second);
    await second.recordNode({ kind: COUNTEREXAMPLE_KIND, claimId: run.claimId, data: { object: 1, id: "1", source: "table_run", refutes: "earlier" } });
    await before(createM8())(run.problem);
    assert.equal(second.nodes(CEGIS_DROP_KIND, { claimId: run.claimId }).length, 1);
  });

  it("leaves M8 as it was without compute.python, or with the option off, and never sends the programs to Sage", async () => {
    const shape = (memory: MemoryStore) => ({
      claims: memory.claims().map((c) => `${c.status} ${c.origin} ${c.statement}`).sort(),
      // Claim ids are minted at each write, and the pool's key hashes them: both are left out.
      nodes: ["datatable", "recurrence", "conjecture_pool", "identification", COUNTEREXAMPLE_KIND, CEGIS_DROP_KIND, SEQUENCE_GUESS_KIND].map((k) => memory.nodes(k).map((n) => JSON.stringify(n.data).replace(/clm_[0-9A-Z]+/gu, "clm").replace(/"key":"[0-9a-f]+"/gu, '"key"'))),
      edges: memory.claims().flatMap((c) => memory.edges({ from: c.claimId }).map((e) => `${e.kind} ${e.note ?? ""}`)).sort(),
    });
    assert.equal(M8_OPTIONS.guess, false, "off by default, like the other stages of plan change CX");
    const off = registryOf(["compute.python"], good);
    const a = await problemOf(off, { guess: false });
    await before(createM8())(a.problem);
    const none = registryOf([], good);
    const b = await problemOf(none);
    await before(createM8())(b.problem);
    const sage = registryOf(["compute.sage"], good);
    const c = await problemOf(sage);
    await before(createM8())(c.problem);
    assert.deepEqual(off.calls, []);
    assert.deepEqual(none.calls, []);
    assert.deepEqual(sage.calls, []);
    const sa = shape(a.memory);
    assert.deepEqual(shape(b.memory), sa);
    assert.deepEqual(shape(c.memory), sa);
    assert.ok(sa.nodes[6]?.length === 0);
    // Options written before CX8, without `guess` and `guessSec`, read the defaults.
    assert.equal(readM8Options(Object.fromEntries(Object.entries(M8_OPTIONS).filter(([k]) => k !== "guess" && k !== "guessSec"))).guess, false);
    assert.throws(() => readM8Options({ ...M8_OPTIONS, guessSec: 1 }), /option M8\.guessSec is an integer from 5 to 600/);
  });

  it("stops asking, and records nothing, when compute.python cannot be reached", async () => {
    const registry = registryOf(["compute.python"], () => {
      throw new CapabilityError("unavailable", "compute.python", "no Pyodide here");
    });
    const { problem, memory, claimId, logs } = await problemOf(registry);
    await before(createM8())(problem);
    assert.equal(registry.calls.length, 1, logs.join("\n"));
    assert.equal(memory.nodes(SEQUENCE_GUESS_KIND).length, 0);
    assert.deepEqual(guessed(memory, claimId), []);
    assert.ok(logs.some((l) => /the guessing through compute\.python stopped/u.test(l)));
  });
});
