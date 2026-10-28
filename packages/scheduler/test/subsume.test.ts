import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { realize, GraphState } from "@seshat/graph";
import { LeanMeta, SimulatedLeanMeta } from "@seshat/lean-meta";
import { type HostProfile, loadCatalog, Registry } from "@seshat/registry";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { claim, HEADER, proofOf, prove, toyAnswer, world } from "../../graph/test/helpers.ts";
import { backwardSubsume, forwardSubsume, INSTANCE_CLOSERS, type SubsumeOptions } from "../src/index.ts";

const catalog = loadCatalog(join(fileURLToPath(new URL("../../../", import.meta.url)), "capabilities"));

/** `lean.meta` served by a table, through the registry as a deployment's would be. */
function metaOf(simulated: SimulatedLeanMeta): LeanMeta {
  const host: HostProfile = { host: "test", capabilities: { "lean.meta": { use: ["kimina"] } } };
  return new LeanMeta(new Registry({ catalog, host, factories: { "kimina-meta": simulated.factory() } }));
}

/** An instance's link lemma is closed by `intro h; exact h`; the rest is the toy Lean's. */
function answer(code: string): FakeLeanAnswer {
  if (proofOf(code)?.trim().startsWith("intro h; exact h") === true) return {};
  return toyAnswer(code);
}

describe("subsumption through lean.meta and Lean-checked instances", () => {
  it("closes a new claim that is an instance of a known fact, without a model, through a checked edge", async () => {
    const w = world(answer);
    try {
      const fact = await claim(w, "(n : ℕ) : n + 0 = n");
      await prove(w, fact);
      const special = await claim(w, ": 2 + 0 = 2");
      const simulated = new SimulatedLeanMeta([
        { input: { op: "instances", statement: ": 2 + 0 = 2" }, output: { instanceOf: [fact], covers: [] } },
      ]);
      const o: SubsumeOptions = { meta: metaOf(simulated), memory: w.memory, validate: w.validate, header: HEADER, limit: 10, seen: new Set() };
      const found = await forwardSubsume(o, special);
      assert.deepEqual(found.map((f) => [f.instance, f.general, f.checked]), [[special, fact, true]]);
      assert.deepEqual(simulated.calls.map((c) => c.op), ["instances"]);
      // The claim is still open: only the graph, from the checked edge and the proved fact, derives it, and Lean checks the composed proof.
      assert.equal(w.memory.claim(special)?.status, "open");
      const state = new GraphState(w.memory, [special]);
      state.sync();
      const done = await realize({ memory: w.memory, state, validate: w.validate, headerOf: () => HEADER });
      assert.deepEqual(done.map((r) => [r.fact.claim, r.verdict]), [[special, "valid"]]);
      assert.equal(w.memory.claim(special)?.status, "computed");
      assert.equal(w.memory.edges({ kinds: ["instance_of"], minStatus: "lean_checked" }).length, 1);
      // The same pair is not compared again.
      assert.deepEqual(await forwardSubsume(o, special), []);
      assert.equal(simulated.calls.length, 1);
    } finally {
      w.close();
    }
  });

  it("leaves an instance edge unchecked when Lean refuses its lemma: nothing propagates through it", async () => {
    const w = world(toyAnswer);
    try {
      const fact = await claim(w, "(n : ℕ) : n + 0 = n");
      await prove(w, fact);
      const special = await claim(w, ": 2 + 0 = 2");
      const simulated = new SimulatedLeanMeta([{ input: { op: "instances" }, output: { instanceOf: [fact], covers: [] } }]);
      const found = await forwardSubsume({ meta: metaOf(simulated), memory: w.memory, validate: w.validate, header: HEADER, limit: 10, seen: new Set() }, special);
      assert.deepEqual(found.map((f) => f.checked), [false]);
      const state = new GraphState(w.memory, [special]);
      state.sync();
      assert.deepEqual(await realize({ memory: w.memory, state, validate: w.validate, headerOf: () => HEADER }), []);
      assert.equal(w.memory.claim(special)?.status, "open");
    } finally {
      w.close();
    }
  });

  it("closes the open claims that a new general fact covers", async () => {
    const w = world(answer);
    try {
      const open = await claim(w, ": 2 + 0 = 2");
      const other = await claim(w, ": 3 = 3");
      const general = await claim(w, "(n : ℕ) : n + 0 = n");
      await prove(w, general);
      const simulated = new SimulatedLeanMeta([{ input: { op: "instances", statement: "(n : ℕ) : n + 0 = n" }, output: { instanceOf: [], covers: [open] } }]);
      const o: SubsumeOptions = { meta: metaOf(simulated), memory: w.memory, validate: w.validate, header: HEADER, limit: 10, seen: new Set() };
      const found = await backwardSubsume(o, general, [open, other]);
      assert.deepEqual(found.map((f) => [f.instance, f.general, f.checked]), [[open, general, true]]);
      // Both open claims were offered to lean.meta; only the covered one got an edge.
      const call = simulated.calls[0];
      assert.equal(call?.op, "instances");
      assert.deepEqual(call?.op === "instances" ? call.facts.map((f) => f.name) : [], [open, other]);
      const state = new GraphState(w.memory, [open]);
      state.sync();
      await realize({ memory: w.memory, state, validate: w.validate, headerOf: () => HEADER });
      assert.equal(w.memory.claim(open)?.status, "computed");
      assert.equal(w.memory.claim(other)?.status, "open");
    } finally {
      w.close();
    }
  });

  it("stops asking when lean.meta cannot answer", async () => {
    const w = world(answer);
    try {
      const fact = await claim(w, "(n : ℕ) : n + 0 = n");
      await prove(w, fact);
      const special = await claim(w, ": 2 + 0 = 2");
      const simulated = new SimulatedLeanMeta([{ input: { op: "instances" }, unavailable: "the server is down" }]);
      const down = { count: 0 };
      const logs: string[] = [];
      const o: SubsumeOptions = { meta: metaOf(simulated), memory: w.memory, validate: w.validate, header: HEADER, limit: 10, seen: new Set(), down, log: (t) => logs.push(t) };
      assert.deepEqual(await forwardSubsume(o, special), []);
      const second = await claim(w, ": 3 + 0 = 3");
      assert.deepEqual(await forwardSubsume(o, second), []);
      const third = await claim(w, ": 4 + 0 = 4");
      assert.deepEqual(await forwardSubsume(o, third), []);
      assert.equal(simulated.calls.length, 2, "after two failures the scheduler does not ask again");
      assert.equal(down.count, 2);
      assert.match(logs[0] ?? "", /unreachable/);
    } finally {
      w.close();
    }
  });

  it("tries cheap closers in order", () => {
    assert.equal(INSTANCE_CLOSERS[0], "intro h; exact h");
    assert.ok(INSTANCE_CLOSERS.length >= 3);
  });
});
