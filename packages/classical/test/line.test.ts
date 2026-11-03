import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { Line, ProblemContext, SessionContext, ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import { BATTERY_RUN, createM10, describeTried, FIRST_ORDER_RUN, M10, M10_DEFAULTS, type M10Services, readOptions, type Solvers, subgoalsOf } from "../src/index.ts";
import { ScriptedLean, type Script } from "./fake-lean.ts";

const valid: ValidateResult = { verdict: "valid", status: "computed", reasons: [], validationId: "val_1" };
const STATEMENT = "(n m : ℕ) (h : n < m) : n + 1 ≤ m";

function openMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-m10-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M10");
}

/** A registry whose `lean.check` is the scripted Lean: enough for `RegistryLeanChecker`. */
function registryOf(lean: ScriptedLean): Registry {
  return {
    hash: "0".repeat(64),
    invoke: async (name: string, input: unknown) => {
      if (name !== "lean.check") throw new CapabilityError("unavailable", name, `host test does not offer ${name}`);
      return { output: { results: await lean.check((input as { snippets: Array<{ id: string; code: string }> }).snippets) } };
    },
  } as unknown as Registry;
}

interface Setup {
  script?: Record<string, Script>;
  options?: Record<string, unknown>;
  validate?: (r: ValidateRequest) => ValidateResult;
  memory?: MemoryStore;
  statement?: string;
}

async function problemOf(setup: Setup = {}) {
  const memory = setup.memory ?? openMemory();
  const statement = setup.statement ?? STATEMENT;
  const { claimId } = await memory.ensureClaim({ statement, header: "import Mathlib", origin: "bench:test" });
  const lean = new ScriptedLean(setup.script ?? {});
  const logs: string[] = [];
  const requests: ValidateRequest[] = [];
  const problem = {
    line: "M10",
    runId: "run_1",
    problemId: "p1",
    claimId,
    seed: 1,
    target: { theorem: "T.t", statement, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [],
    memory,
    registry: registryOf(lean),
    validate: async (r: ValidateRequest) => {
      requests.push(r);
      return (setup.validate ?? (() => valid))(r);
    },
    log: (t: string) => logs.push(t),
    signal: new AbortController().signal,
    options: { ...M10_DEFAULTS, probe: false, ...setup.options },
  } as unknown as ProblemContext;
  return { problem, memory, claimId, lean, logs, requests };
}

const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
  const found = line.hooks[name];
  assert.ok(found !== undefined, `the line has a ${name} hook`);
  return found;
};

describe("the options of line M10", () => {
  it("have a default of the type the run must keep, checked when a hook reads them", () => {
    assert.equal(M10.id, "M10");
    assert.equal(M10.resume, "stateless");
    assert.deepEqual(readOptions(M10_DEFAULTS).hammerCutoffs, [16, 64, 256]);
    assert.throws(() => readOptions({ ...M10_DEFAULTS, parallel: 0 }), /option M10\.parallel is an integer from 1 to 16, not 0/);
    assert.throws(() => readOptions({ ...M10_DEFAULTS, order: "random" }), /option M10\.order is one of thompson, mean/);
    assert.throws(() => readOptions({ ...M10_DEFAULTS, packages: "hammer,magic" }), /names "magic"/);
    assert.throws(() => readOptions({ ...M10_DEFAULTS, premiseCutoffs: "0" }), /premise cutoff/);
    assert.deepEqual(readOptions({ ...M10_DEFAULTS, packages: "hammer, canonical" }).packages, ["hammer", "canonical"]);
  });
});

describe("beforeProvers", () => {
  it("settles a problem the battery closes: the winner goes through validate, nothing else changes a status", async () => {
    const { problem, memory, claimId, requests, logs } = await problemOf({ script: { omega: { ok: true } } });
    await hook(M10, "beforeProvers")(problem);
    assert.deepEqual(requests, [{ claimId, proof: "omega" }]);
    assert.match(logs.join("\n"), /omega closed the target \(domain presburger/);
    assert.equal(memory.nodes(BATTERY_RUN, { claimId }).length, 1);
    assert.equal(memory.claim(claimId)?.status, "open", "the line raised no status: validate does, and the stub validate did not");
    assert.equal(memory.nodes(FIRST_ORDER_RUN, { claimId }).length, 0, "ATP and SMT run only when the battery fails");
  });

  it("tries only the tactics the host has, and asks the host's Lean when it is told to probe", async () => {
    const { problem, lean } = await problemOf({ options: { probe: true }, script: { hammer: { unknown: true }, canonical: { ok: false }, polyrith: { unknown: true }, bv_decide: { unknown: true } } });
    await hook(M10, "beforeProvers")(problem);
    const tried = new Set(lean.calls.filter((c) => !c.code.includes("(0 : Nat) = 0")).map((c) => c.tactic));
    assert.ok(lean.calls.some((c) => c.tactic === "polyrith" && c.code.includes("(0 : Nat) = 0")), "the host was asked");
    assert.ok(tried.has("canonical"), "canonical parsed, so it is offered");
    for (const t of ["polyrith", "bv_decide"]) assert.ok(!tried.has(t), `${t} is unknown to this Lean, so it is not tried`);
    assert.ok(!tried.has("hammer"), "no hammer for a Lean without it");
    assert.ok(![...tried].some((x) => x.startsWith("hammer {")), "no hammer cutoff for a Lean without the hammer");
  });

  it("goes on to ATP and SMT when the battery fails, and records the evidence without a status", async () => {
    const solvers: Solvers = { smt: async () => ({ status: "unsat", core: ["goal"], exitCode: 0, elapsedMs: 1 }), atp: null };
    const services: M10Services = { solvers: () => solvers };
    const { problem, memory, claimId, requests, logs } = await problemOf({});
    await hook(createM10(services), "beforeProvers")(problem);
    assert.deepEqual(requests, []);
    assert.equal(memory.nodes(FIRST_ORDER_RUN, { claimId }).length, 1);
    assert.equal(memory.claim(claimId)?.status, "open");
    assert.match(logs.join("\n"), /ATP\/SMT answered 1 time\(s\), not reconstructed/);
  });

  it("works the open subgoals of the target too", async () => {
    const { problem, memory, claimId, requests } = await problemOf({ script: { omega: { ok: false }, linarith: { ok: true } }, statement: "(x y : ℝ) (h : x ≤ y) : 2 * x ≤ x + y" });
    const sub = await memory.ensureClaim({ statement: "(a b : ℕ) (h : a < b) : a + 1 ≤ b", header: "import Mathlib", origin: "line:M12", parentId: claimId });
    memory.addEdge({ kind: "decomposes_into", from: claimId, to: [sub.claimId], origin: "line:M12" } as never);
    assert.deepEqual(subgoalsOf(memory, claimId, 8).map((c) => c.claimId), [sub.claimId]);
    await hook(M10, "beforeProvers")(problem);
    assert.equal(requests[0]?.claimId, claimId, "the target is first");
    assert.ok(memory.nodes(BATTERY_RUN, { claimId: sub.claimId }).length === 1 || requests.length >= 1);
  });

  it("does not run twice on a goal it has a record of (a resumed run)", async () => {
    const memory = openMemory();
    const first = await problemOf({ memory, script: {} });
    await hook(M10, "beforeProvers")(first.problem);
    const calls = first.lean.calls.length;
    assert.ok(calls > 0);
    const second = await problemOf({ memory, script: {} });
    await hook(M10, "beforeProvers")(second.problem);
    assert.equal(second.lean.calls.length, 0, "the record stands");
    assert.equal(memory.nodes(BATTERY_RUN).length, 1);
  });

  it("learns across problems: a tactic that won before is tried first the next time", async () => {
    const memory = openMemory();
    const a = await problemOf({ memory, options: { order: "mean", parallel: 1 }, script: { aesop: { ok: true } }, statement: "(n m : ℕ) (h : n < m) : n + 1 ≤ m" });
    await hook(M10, "beforeProvers")(a.problem);
    for (let i = 0; i < 4; i++) {
      const more = await problemOf({ memory, options: { order: "mean", parallel: 1 }, script: { aesop: { ok: true } }, statement: `(n m : ℕ) (h : n < m + ${i}) : n ≤ m + ${i}` });
      await hook(M10, "beforeProvers")(more.problem);
    }
    const next = await problemOf({ memory, options: { order: "mean", parallel: 1 }, script: { aesop: { ok: true } }, statement: "(a b : ℕ) (h : a < b) : a < b + 1" });
    await hook(M10, "beforeProvers")(next.problem);
    assert.equal(next.lean.calls[0]?.tactic, "aesop", "five wins of aesop in presburger put it above omega's prior");
  });
});

describe("the briefing", () => {
  it("says what was tried and how it ended", async () => {
    const { problem, memory, claimId } = await problemOf({ script: { simp: { timeout: true, timeMs: 7000 } } });
    await hook(M10, "beforeProvers")(problem);
    const text = describeTried(memory, claimId) ?? "";
    assert.match(text, /filed the goal under "presburger"/);
    assert.match(text, /already tried on the whole goal, without a model: /);
    assert.match(text, /simp \(timed out\)/);
    assert.match(text, /\bomega\b/);
    assert.match(text, /Do not repeat them/);
    const briefing = await hook(M10, "briefing")({ memory, claimId } as unknown as SessionContext);
    assert.equal(briefing?.title, "Classical tools, tried before any model (line M10)");
  });

  it("says nothing when the line did nothing", async () => {
    assert.equal(describeTried(openMemory(), "clm_none"), undefined);
  });
});
