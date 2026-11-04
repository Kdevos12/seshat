import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, seeded } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import {
  bm25Selector,
  DEFAULT_FIRST_ORDER,
  FIRST_ORDER_RUN,
  type FirstOrderContext,
  mixSelectors,
  parseAtpTools,
  parseCutoffs,
  type Premise,
  reconstructionTactics,
  type Solvers,
  solveFirstOrder,
  symbolSelector,
  ToolMissing,
} from "../src/index.ts";
import { ScriptedLean } from "./fake-lean.ts";

const INDEX: Premise[] = [
  { name: "Int.add_comm", statement: "(a b : ℤ) : a + b = b + a" },
  { name: "Int.mul_comm", statement: "(a b : ℤ) : a * b = b * a" },
  { name: "Foo.dvd_trans", statement: "(a b c : ℤ) : a ∣ b → b ∣ c → a ∣ c" },
  { name: "List.length_append", statement: "(l m : List ℕ) : (l ++ m).length = l.length + m.length" },
];

describe("premise selection", () => {
  it("BM25 ranks the lemma that shares the goal's words", () => {
    const names = bm25Selector("(x y : ℤ) : x * y = y * x", INDEX, 2).map((p) => p.name);
    assert.equal(names[0], "Int.mul_comm");
  });

  it("symbol overlap prefers rare shared symbols, and a mix interleaves two streams without repeats", () => {
    const sym = symbolSelector("(a b c : ℤ) (h : a ∣ b) (h2 : b ∣ c) : a ∣ c", INDEX, 2).map((p) => p.name);
    assert.equal(sym[0], "Foo.dvd_trans");
    const mixed = mixSelectors(symbolSelector, bm25Selector)("(a b c : ℤ) : a ∣ c", INDEX, 3).map((p) => p.name);
    assert.equal(new Set(mixed).size, mixed.length);
    assert.ok(mixed.length <= 3);
  });

  it("reads the cutoffs option", () => {
    assert.deepEqual(parseCutoffs("64, 16,256,16"), [16, 64, 256]);
    assert.throws(() => parseCutoffs("0"), RangeError);
  });
});

function setup(solvers: Solvers, lean: ScriptedLean, validate: (r: ValidateRequest) => ValidateResult, extra: Partial<FirstOrderContext> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mh-fo-"));
  const memory = new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M10");
  const requests: ValidateRequest[] = [];
  const ctx: FirstOrderContext = {
    solvers,
    checker: lean,
    memory,
    validate: async (r) => {
      requests.push(r);
      return validate(r);
    },
    host: { have: new Set() },
    settings: { ...DEFAULT_FIRST_ORDER, cutoffs: [2, 4] },
    index: INDEX,
    random: seeded(1),
    signal: new AbortController().signal,
    log: () => {},
    ...extra,
  };
  return { ctx, memory, requests };
}

const valid: ValidateResult = { verdict: "valid", status: "computed", reasons: [], validationId: "val_9" };
const GOAL = { header: "import Mathlib", statement: "(a b : ℤ) : a + b = b + a" };

describe("ATP and SMT with reconstruction", () => {
  it("hands the premises of the core to grind, and submits only a Lean proof", async () => {
    const smtCalls: string[] = [];
    const solvers: Solvers = {
      smt: async (input) => {
        smtCalls.push(input.smtlib);
        // The core names the first premise and the goal.
        return { status: "unsat", core: ["p_1", "goal"], exitCode: 0, elapsedMs: 3 };
      },
      atp: null,
    };
    const lean = new ScriptedLean({ "grind [Int.add_comm]": { ok: true }, "grind [Int.add_comm, Int.mul_comm]": { ok: true } });
    const { ctx, memory, requests } = setup(solvers, lean, () => valid);
    const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
    assert.ok(out.settled);
    assert.equal(smtCalls.length, 2, "one call at each cutoff");
    assert.deepEqual(requests.map((r) => r.proof), ["grind [Int.add_comm]"]);
    const node = memory.nodes(FIRST_ORDER_RUN, { claimId: claim.claimId })[0];
    const data = node?.data as { evidence: Array<{ premises: string[] }>; solved?: { tactic: string } };
    assert.equal(data.evidence.length, 2);
    assert.equal(data.solved?.tactic, "grind [Int.add_comm]");
  });

  it("keeps an unsat answer as evidence when Lean does not accept the reconstruction", async () => {
    const solvers: Solvers = { smt: async () => ({ status: "unsat", core: ["p_1", "goal"], exitCode: 0, elapsedMs: 3 }), atp: null };
    const lean = new ScriptedLean({});
    const { ctx, memory, requests } = setup(solvers, lean, () => valid);
    const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
    assert.equal(out.settled, false);
    assert.deepEqual(requests, [], "nothing is submitted without a Lean proof");
    assert.ok(out.evidence.length > 0);
    assert.equal(memory.claim(claim.claimId)?.status, "open", "the solver's answer changes no status");
  });

  it("does not submit when the proof uses no premise beyond the hypotheses", async () => {
    const solvers: Solvers = { smt: async () => ({ status: "unsat", core: ["goal"], exitCode: 0, elapsedMs: 1 }), atp: null };
    const lean = new ScriptedLean({ grind: { ok: true } });
    const { ctx, memory, requests } = setup(solvers, lean, () => valid);
    const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
    assert.equal(out.settled, false);
    assert.deepEqual(requests, []);
  });

  it("unions the premises of the successes of several cutoffs and tools", async () => {
    let n = 0;
    const solvers: Solvers = {
      smt: async () => ({ status: n++ === 0 ? "unsat" : "unknown", core: ["p_1", "goal"], exitCode: 0, elapsedMs: 1 }),
      atp: async () => ({ szs: "Theorem", result: "theorem", used: ["p_2", "goal"], exitCode: 0, elapsedMs: 1 }),
    };
    const lean = new ScriptedLean({});
    const { ctx, memory } = setup(solvers, lean, () => valid);
    const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
    const data = memory.nodes(FIRST_ORDER_RUN)[0]?.data as { union: string[]; evidence: unknown[] };
    assert.equal(data.evidence.length, 3);
    assert.deepEqual(data.union.sort(), ["Int.add_comm", "Int.mul_comm"].sort());
  });

  it("leaves a goal outside the fragment to the battery, and says why", async () => {
    const solvers: Solvers = { smt: async () => ({ status: "unsat", exitCode: 0, elapsedMs: 1 }), atp: null };
    const { ctx, memory } = setup(solvers, new ScriptedLean({}), () => valid);
    const claim = await memory.ensureClaim({ statement: "(n : ℕ) : ∑ i in Finset.range n, i = n", header: "import Mathlib", origin: "test" });
    const out = await solveFirstOrder(ctx, { header: "import Mathlib", statement: "(n : ℕ) : ∑ i in Finset.range n, i = n", claimId: claim.claimId });
    assert.match(out.outside ?? "", /big operator/);
  });

  it("records a missing tool and goes on without it", async () => {
    const { ctx, memory } = setup({ smt: null, atp: null }, new ScriptedLean({}), () => valid);
    const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
    assert.equal(out.settled, false);
    const data = memory.nodes(FIRST_ORDER_RUN)[0]?.data as { missing: string[] };
    assert.deepEqual(data.missing, ["smt.z3", "atp.vampire"]);
  });

  describe("the ATP portfolio of Vampire and E", () => {
    const theorem = (used: string[]) => async () => ({ szs: "Theorem", result: "theorem" as const, used, exitCode: 0, elapsedMs: 1 });
    const nothing = async () => ({ szs: "GaveUp", result: "unknown" as const, used: [] as string[], exitCode: 1, elapsedMs: 1 });

    it("runs both provers at every cutoff and tags the evidence with the tool", async () => {
      const solvers: Solvers = { smt: null, atp: theorem(["p_1", "goal"]), eprover: theorem(["p_2", "goal"]) };
      const { ctx, memory } = setup(solvers, new ScriptedLean({}), () => valid);
      const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
      const data = memory.nodes(FIRST_ORDER_RUN)[0]?.data as { evidence: Array<{ tool: string }>; missing: string[] };
      assert.deepEqual(data.evidence.map((e) => e.tool).sort(), ["atp.eprover", "atp.eprover", "atp.vampire", "atp.vampire"]);
      assert.deepEqual(data.missing, []);
    });

    it("lets E win when only E's premises reconstruct in Lean, and submits one Lean proof", async () => {
      const solvers: Solvers = { smt: null, atp: theorem(["p_1", "goal"]), eprover: theorem(["p_2", "goal"]) };
      const lean = new ScriptedLean({ "grind [Int.mul_comm]": { ok: true } });
      const { ctx, memory, requests } = setup(solvers, lean, () => valid);
      const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
      assert.ok(out.settled);
      assert.deepEqual(requests.map((r) => r.proof), ["grind [Int.mul_comm]"]);
    });

    it("keeps the answers of both provers as evidence when Lean accepts neither, and changes no status", async () => {
      const solvers: Solvers = { smt: null, atp: theorem(["p_1", "goal"]), eprover: theorem(["p_2", "goal"]) };
      const { ctx, memory, requests } = setup(solvers, new ScriptedLean({}), () => valid);
      const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      const out = await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
      assert.equal(out.settled, false);
      assert.deepEqual(requests, []);
      assert.equal(memory.claim(claim.claimId)?.status, "open");
    });

    it("in order, tries E only when Vampire's answer did not reconstruct, and stops at the first accepted", async () => {
      const calls: string[] = [];
      const solvers: Solvers = {
        smt: null,
        atp: async () => (calls.push("vampire"), theorem(["p_1", "goal"])()),
        eprover: async () => (calls.push("eprover"), theorem(["p_2", "goal"])()),
      };
      // Vampire's premise fails in Lean, E's passes.
      const lean = new ScriptedLean({ "grind [Int.mul_comm]": { ok: true } });
      const first = setup(solvers, lean, () => valid, { settings: { ...DEFAULT_FIRST_ORDER, cutoffs: [2], atpMode: "order" } });
      const c1 = await first.memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      assert.ok((await solveFirstOrder(first.ctx, { ...GOAL, claimId: c1.claimId })).settled);
      assert.deepEqual(calls, ["vampire", "eprover"]);
      // Vampire's premise passes: E is never run.
      calls.length = 0;
      const second = setup(solvers, new ScriptedLean({ "grind [Int.add_comm]": { ok: true } }), () => valid, { settings: { ...DEFAULT_FIRST_ORDER, cutoffs: [2], atpMode: "order" } });
      const c2 = await second.memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      assert.ok((await solveFirstOrder(second.ctx, { ...GOAL, claimId: c2.claimId })).settled);
      assert.deepEqual(calls, ["vampire"]);
    });

    it("honours the tool list: E alone, or the installed prover alone when the other is missing", async () => {
      const calls: string[] = [];
      const solvers: Solvers = { smt: null, atp: async () => (calls.push("vampire"), nothing()), eprover: async () => (calls.push("eprover"), nothing()) };
      const only = setup(solvers, new ScriptedLean({}), () => valid, { settings: { ...DEFAULT_FIRST_ORDER, cutoffs: [2], atpTools: ["atp.eprover"] } });
      const c1 = await only.memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      await solveFirstOrder(only.ctx, { ...GOAL, claimId: c1.claimId });
      assert.deepEqual(calls, ["eprover"]);
      calls.length = 0;
      const fallback = setup({ smt: null, atp: solvers.atp, eprover: null }, new ScriptedLean({}), () => valid, { settings: { ...DEFAULT_FIRST_ORDER, cutoffs: [2] } });
      const c2 = await fallback.memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      await solveFirstOrder(fallback.ctx, { ...GOAL, claimId: c2.claimId });
      assert.deepEqual(calls, ["vampire"]);
      const data = fallback.memory.nodes(FIRST_ORDER_RUN)[0]?.data as { missing: string[] };
      assert.deepEqual(data.missing, [], "a prover the host does not offer is not an error when the other is there");
    });

    it("records a prover that vanished at run time as missing and goes on with the other", async () => {
      const solvers: Solvers = { smt: null, atp: theorem(["p_1", "goal"]), eprover: async () => { throw new ToolMissing("atp.eprover"); } };
      const { ctx, memory } = setup(solvers, new ScriptedLean({}), () => valid);
      const claim = await memory.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
      await solveFirstOrder(ctx, { ...GOAL, claimId: claim.claimId });
      const data = memory.nodes(FIRST_ORDER_RUN)[0]?.data as { missing: string[]; evidence: unknown[] };
      assert.deepEqual(data.missing, ["atp.eprover"]);
      assert.equal(data.evidence.length, 2);
    });

    it("reads the portfolio settings of the line", () => {
      assert.deepEqual(parseAtpTools("eprover, vampire"), ["atp.eprover", "atp.vampire"]);
      assert.deepEqual(parseAtpTools("vampire,eprover,vampire"), ["atp.vampire", "atp.eprover"]);
      assert.throws(() => parseAtpTools("spass"), RangeError);
      assert.throws(() => parseAtpTools(""), RangeError);
    });
  });

  it("writes the reconstruction tactics, the hammer only when the host has it", () => {
    assert.deepEqual(reconstructionTactics(["A", "B"], { have: new Set() }).map((t) => t.script), ["grind [A, B]", "aesop (add safe A) (add safe B)"]);
    assert.equal(reconstructionTactics(["A"], { have: new Set(["hammer"]) }).at(-1)?.script, "hammer [A]");
  });
});
