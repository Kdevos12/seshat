import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, type Json, type ProvenanceContext } from "@seshat/core";
import type { ProblemContext, SessionContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { proposeEdge } from "../../graph/src/index.ts";
import { certify, claim, link, prove, toyAnswer, world, type World } from "../../graph/test/helpers.ts";
import {
  cellKey, cellPosteriors, checkedDecompositions, dataOf, entropy, keepSchema, M15_HINT_KIND, M15_PICK_KIND, type HintData, type PickData, pickCell,
  readArchive, regionOf, retireWorn, settle, SKETCH_KIND, skeletonOf, type SketchEntry, type SketchRecord, m15Settings, M15_OPTIONS,
} from "../src/index.ts";
import { type SchemaData, SCHEMA_KIND, usableSchemas } from "@seshat/library";

const ROOT = "(n : ℕ) : n + 0 = n";
const context: ProvenanceContext = { modelId: "prov/model-5", promptVersion: "m0-2", mathlibRev: "abc123", harnessVersion: "rev1", budgetClass: "medium" };

/** The world's journal, with a memory over it that stamps what a line learns. */
function lineMemory(w: World, actor = "line:M15"): MemoryStore {
  return new MemoryStore({ journal: w.journal, blobs: new BlobStore(join(w.dir, "blobs")), provenance: context, actor });
}

async function decomposed(w: World, ...parts: string[]): Promise<{ root: string; parts: string[] }> {
  const root = await claim(w, ROOT);
  const ids = [];
  for (const p of parts) ids.push(await claim(w, p));
  return { root, parts: ids };
}

describe("the archive of a claim's decompositions", () => {
  it("holds the decompositions Lean checked, not the ones proposed", async () => {
    const w = world(toyAnswer);
    try {
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      proposeEdge(w.memory, { kind: "decomposes_into", from: root, to: parts });
      assert.deepEqual(readArchive(w.memory, root), { members: [], cells: [] });
      const edge = await link(w, "decomposes_into", root, ...parts);
      assert.deepEqual(checkedDecompositions(w.memory, root).map((e) => e.edgeId), [edge]);
      const archive = readArchive(w.memory, root);
      assert.deepEqual(archive.members.map((m) => [m.edgeId, m.rho, m.closed, m.leaves, m.depth]), [[edge, 0, 0, 2, 1]]);
    } finally {
      w.close();
    }
  });

  it("measures fitness as the share of leaves closed, from the labels: Lean's verdicts, and checked edges the graph follows", async () => {
    const w = world(toyAnswer);
    try {
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n", "(n : ℕ) : n = n");
      await link(w, "decomposes_into", root, ...parts);
      assert.equal(readArchive(w.memory, root).members[0]?.rho, 0);
      await prove(w, parts[0] as string);
      assert.ok(Math.abs((readArchive(w.memory, root).members[0]?.rho ?? 0) - 1 / 3) < 1e-9);
      // A leaf the graph derives through a checked instance_of edge from a proved fact is closed too, though its own status is open.
      const fact = await claim(w, "(n : ℕ) : n = n ∧ True");
      await prove(w, fact);
      await link(w, "instance_of", parts[2] as string, fact);
      const member = readArchive(w.memory, root).members[0];
      assert.equal(w.memory.claim(parts[2] as string)?.status, "open");
      assert.ok(Math.abs((member?.rho ?? 0) - 2 / 3) < 1e-9, `${member?.rho}`);
      await prove(w, parts[1] as string);
      assert.equal(readArchive(w.memory, root).members[0]?.rho, 1);
    } finally {
      w.close();
    }
  });

  it("counts computed leaves in the fitness but calls a decomposition certified only when the kernel proved every leaf", async () => {
    const w = world(toyAnswer);
    try {
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      await link(w, "decomposes_into", root, ...parts);
      await prove(w, parts[0] as string);
      await prove(w, parts[1] as string);
      const [fast] = readArchive(w.memory, root).members;
      assert.deepEqual([fast?.rho, fast?.certified], [1, false], "computed leaves close the fitness but are not certified");
      certify(w, parts[0] as string);
      assert.equal(readArchive(w.memory, root).members[0]?.certified, false, "one leaf certified is not enough");
      certify(w, parts[1] as string);
      assert.deepEqual([readArchive(w.memory, root).members[0]?.rho, readArchive(w.memory, root).members[0]?.certified], [1, true]);
    } finally {
      w.close();
    }
  });

  it("counts the leaves of a part that is itself decomposed, and bins the depth", async () => {
    const w = world(toyAnswer);
    try {
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      const [a, b] = parts as [string, string];
      const deeper = [await claim(w, "(n : ℕ) : n + 0 = n + 0 + 0"), await claim(w, "(n : ℕ) : n + 0 + 0 = 0 + n")];
      await link(w, "decomposes_into", root, a, b);
      await link(w, "decomposes_into", b, ...deeper);
      await prove(w, a);
      await prove(w, deeper[0] as string);
      const [m] = readArchive(w.memory, root).members;
      assert.deepEqual([m?.closed, m?.leaves, m?.depth, m?.key.split("|")[0]], [2, 3, 2, "2"]);
    } finally {
      w.close();
    }
  });

  it("puts a decomposition in the cell of its depth, the family of its main proof and its region", async () => {
    const w = world(toyAnswer);
    try {
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      const edge = await link(w, "decomposes_into", root, ...parts);
      const sketch: SketchEntry = { attemptId: "att_1", edgeId: edge, names: ["aux_a", "aux_b"], mainProof: "induction n with\n  | zero => exact aux_a 0\n  | succ k ih => exact aux_b k" };
      const [m] = readArchive(w.memory, root, [sketch]).members;
      assert.equal(m?.family, "induction");
      assert.equal(m?.region, "2p:=");
      assert.equal(m?.key, cellKey("1", "induction", "2p:="));
      assert.deepEqual([m?.attemptId, m?.names, m?.mainProof === sketch.mainProof], ["att_1", ["aux_a", "aux_b"], true]);
      assert.equal(readArchive(w.memory, root).members[0]?.family, "other", "a decomposition with no sketch has no family");
      assert.equal(regionOf(3, "(a b : ℕ) : a ∣ b ∨ b = 0"), "3p:∨");
      assert.equal(regionOf(1, "((("), "1p:pred");
    } finally {
      w.close();
    }
  });

  it("keeps one elite per cell, replaced only by a strictly higher fitness, and counts the members", async () => {
    const w = world(toyAnswer);
    try {
      const root = await claim(w, ROOT);
      const shared = [await claim(w, "(n : ℕ) : 0 + n = n"), await claim(w, "(n : ℕ) : n + 0 = 0 + n"), await claim(w, "(n : ℕ) : n = n")];
      const others = [await claim(w, "(n : ℕ) : 1 + n = n + 1"), await claim(w, "(n : ℕ) : n + 1 = 1 + n")];
      const first = await link(w, "decomposes_into", root, shared[0] as string, shared[1] as string);
      const second = await link(w, "decomposes_into", root, others[0] as string, others[1] as string);
      const third = await link(w, "decomposes_into", root, shared[0] as string, shared[2] as string);
      // The three are the same kind (two parts, depth 1, no sketch): one cell.
      const cell = () => readArchive(w.memory, root).cells;
      assert.deepEqual(cell().map((c) => [c.members, c.elite.edgeId]), [[3, first]], "all open: the incumbent stays on a tie");
      await prove(w, others[0] as string);
      assert.equal(cell()[0]?.elite.edgeId, second, "a challenger with a higher fitness replaces it");
      await prove(w, shared[0] as string);
      // The first and the third now close half of their leaves, as the second does: the archive is read from the journal in order of
      // creation, and only a strictly higher fitness replaces, so the oldest of the best, the first, is the elite.
      assert.deepEqual(cell().map((c) => [c.elite.edgeId, c.elite.rho]), [[first, 0.5]]);
      await prove(w, shared[2] as string);
      assert.deepEqual(cell().map((c) => [c.elite.edgeId, c.elite.rho]), [[third, 1]]);
      assert.equal(first === third, false);
    } finally {
      w.close();
    }
  });

  it("measures the diversity of mechanisms by entropy", () => {
    assert.equal(entropy([]), 0);
    assert.equal(entropy(["induction", "induction"]), 0);
    assert.equal(entropy(["induction", "cases"]), 1);
    assert.ok(Math.abs(entropy(["a", "b", "c", "d"]) - 2) < 1e-12);
  });
});

/** An attempt of the claim, as the journal records it. */
let counter = 0;
function attempt(w: World, claimId: string, o: { included?: string[]; withheld?: string[]; outcome?: "valid" | "invalid" | "aborted" }): string {
  const attemptId = `att_t${++counter}`;
  w.journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: 1, model: "m", ...(o.included ? { included: o.included } : {}), ...(o.withheld ? { withheld: o.withheld } : {}) }, "prover:p1");
  if (o.outcome !== undefined) {
    w.journal.emit("attempt.finished", { attemptId, outcome: o.outcome, ...(o.outcome === "invalid" ? { failureClass: "unsolved_goals" } : {}), durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 }, "prover:p1");
  }
  return attemptId;
}

function problemOf(memory: MemoryStore, claimId: string, extra: Record<string, unknown> = {}): ProblemContext & SessionContext {
  const logs: string[] = [];
  return { memory, problemId: "prb_1", claimId, runId: "run_1", prover: "p1", session: 1, attemptId: "att_now", log: (t: string) => logs.push(t), options: {}, signal: new AbortController().signal, ...extra } as unknown as ProblemContext & SessionContext;
}

describe("the posteriors of the cells", () => {
  it("are Beta counts of the picks that came to an end, weighted by their epoch's probation", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const pick = (cell: string, outcome?: PickData["outcome"]) =>
        memory.recordNode({ kind: M15_PICK_KIND, data: { problemId: "p", attemptId: "a", prover: "p1", session: 1, cell, rhoBefore: 0, cellsBefore: [], ...(outcome !== undefined ? { outcome } : {}) } as unknown as Json, learned: true });
      pick("1|induction|2p:=", "improved");
      pick("1|induction|2p:=", "improved");
      pick("1|induction|2p:=", "not_improved");
      pick("1|induction|2p:=", "void");
      pick("1|induction|2p:=");
      pick("new", "not_improved");
      assert.deepEqual([...cellPosteriors(memory)], [["1|induction|2p:=", { alpha: 3, beta: 2 }], ["new", { alpha: 1, beta: 2 }]]);
      // A new epoch: the old picks weigh a quarter, a new one counts in full.
      lineMemory(w, "orchestrator").openEpoch({ changes: [{ field: "mathlibRev", from: "abc123", to: "def456" }] });
      pick("1|induction|2p:=", "improved");
      assert.deepEqual(cellPosteriors(memory).get("1|induction|2p:="), { alpha: 1 + 2 * 0.25 + 1, beta: 1 + 0.25 });
      assert.ok(memory.nodes(M15_PICK_KIND).every((n) => n.provenance !== undefined), "a pick is stamped");
    } finally {
      w.close();
    }
  });
});

describe("choosing a cell", () => {
  it("is a Thompson draw over the cells and a fresh start, from the run's seeded source, recorded as a stamped node", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      await link(w, "decomposes_into", root, ...parts);
      await prove(w, parts[0] as string);
      const archive = readArchive(memory, root);
      const choose = (seed: number) => {
        const session = problemOf(memory, root, { seed, attemptId: `att_${seed}`, session: seed });
        pickCell(session, archive, m15Settings(M15_OPTIONS));
        return memory.nodes(M15_PICK_KIND).map((n) => n.data as unknown as PickData).find((d) => d.attemptId === `att_${seed}`);
      };
      const picks = Array.from({ length: 20 }, (_, k) => choose(k + 1));
      const cells = picks.map((p) => p?.cell);
      assert.ok(cells.includes("new") && cells.includes(archive.cells[0]?.key), "both arms are tried while nothing is known");
      assert.deepEqual(choose(3), picks[2], "the same seed and session choose the same");
      const cellPick = picks.find((p) => p?.cell !== "new");
      assert.deepEqual([cellPick?.elite, cellPick?.rhoBefore, cellPick?.cellsBefore], [archive.cells[0]?.elite.edgeId, 0.5, [archive.cells[0]?.key]]);
      assert.ok(memory.nodes(M15_PICK_KIND).every((n) => n.provenance !== undefined && n.epoch === 0));
    } finally {
      w.close();
    }
  });
});

describe("settling what a session came to", () => {
  /** A sketch record for the attempt, registered or not, as the scheduler writes it. */
  function sketch(memory: MemoryStore, root: string, attemptId: string, o: { edgeId?: string; holes?: string[]; registered: boolean }): void {
    const record: SketchRecord = {
      problemId: "prb_1", attemptId, submission: memory.blobs.put(JSON.stringify({ aux: "", proof: "exact main_ok" })), names: ["aux_a", "aux_b"], healthy: true,
      registered: o.registered, holes: o.holes ?? [], ...(o.edgeId !== undefined ? { edgeId: o.edgeId } : {}),
    };
    memory.recordNode({ kind: SKETCH_KIND, claimId: root, data: record as unknown as Json });
  }

  it("calls a pick improved when the session's decomposition closes more than the elite it was told to extend, and waits for an unregistered sketch", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      await link(w, "decomposes_into", root, ...parts);
      const better = [parts[0] as string, await claim(w, "(n : ℕ) : n = n")];
      const edge = await link(w, "decomposes_into", root, ...better);
      await prove(w, better[0] as string);
      await prove(w, better[1] as string);
      const mk = (cell: string, attemptId: string, rhoBefore: number, outcome?: "valid" | "invalid" | "aborted") => {
        attempt(w, root, outcome === undefined ? {} : { outcome });
        const id = attempt(w, root, outcome === undefined ? {} : { outcome });
        void id;
        const data: PickData = { problemId: "prb_1", attemptId, prover: "p1", session: 1, cell, rhoBefore, cellsBefore: ["1|other|2p:="] };
        return memory.recordNode({ kind: M15_PICK_KIND, claimId: root, data: data as unknown as Json, learned: true }).nodeId;
      };
      const finished = (outcome: "valid" | "invalid" | "aborted") => attempt(w, root, { outcome });
      const a1 = finished("invalid");
      const a2 = finished("invalid");
      const a3 = finished("invalid");
      const a4 = finished("aborted");
      const a5 = finished("valid");
      const running = attempt(w, root, {});
      void mk;
      const node = (attemptId: string, cell: string, rhoBefore: number) =>
        memory.recordNode({ kind: M15_PICK_KIND, claimId: root, data: { problemId: "prb_1", attemptId, prover: "p1", session: 1, cell, rhoBefore, cellsBefore: ["1|other|2p:="] } as unknown as Json, learned: true }).nodeId;
      const improving = node(a1, "1|other|2p:=", 0.5);
      const stale = node(a2, "1|other|2p:=", 1);
      const none = node(a3, "1|other|2p:=", 0);
      const cut = node(a4, "1|other|2p:=", 0);
      const solved = node(a5, "new", 0);
      const waiting = node(running, "1|other|2p:=", 0);
      sketch(memory, root, a1, { edgeId: edge, holes: better, registered: true });
      sketch(memory, root, a2, { edgeId: edge, holes: better, registered: true });
      const late = finished("invalid");
      const pending = node(late, "1|other|2p:=", 0);
      sketch(memory, root, late, { registered: false });
      const problem = problemOf(memory, root);
      settle(problem, false);
      const outcome = (nodeId: string) => (memory.node(nodeId)?.data as unknown as PickData).outcome;
      assert.deepEqual(
        [improving, stale, none, cut, solved, waiting, pending].map(outcome),
        ["improved", "not_improved", "not_improved", "void", "improved", undefined, undefined],
        "a session still running and a sketch not yet registered wait",
      );
      assert.equal((memory.node(improving)?.data as unknown as PickData).rhoAfter, 1);
      settle(problem, true);
      assert.deepEqual([outcome(waiting), outcome(pending)], ["void", "not_improved"], "at the end of the problem they are settled");
    } finally {
      w.close();
    }
  });

  it("marks a hint reused when the session's sketch has the schema's shape, whether the session was shown it or not", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const { root, parts } = await decomposed(w, "(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n");
      const edge = await link(w, "decomposes_into", root, ...parts);
      const skeleton = skeletonOf({ conclusion: ROOT, parts: ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n"], mainProof: "exact aux_a n" }, 0.3);
      assert.ok(typeof skeleton !== "string");
      const schema = memory.recordNode({ kind: SCHEMA_KIND, data: dataOf(skeleton, { names: ["aux_a", "aux_b"], family: "other", region: "2p:=", supports: [], gloss: "g" }) as unknown as Json, learned: true });
      const other = memory.recordNode({ kind: SCHEMA_KIND, data: dataOf(skeletonOf({ conclusion: ROOT, parts: ["(n : ℕ) : n = n", "(n : ℕ) : n = n + 0"], mainProof: "exact aux_a n" }, 0.3) as never, { names: ["aux_a", "aux_b"], family: "other", region: "2p:=", supports: [], gloss: "g" }) as unknown as Json, learned: true });
      const shown = attempt(w, root, { outcome: "invalid" });
      const hint = (schemaId: string, shownIt: boolean): string => {
        const data: HintData = { problemId: "prb_1", attemptId: shown, schemaId, name: "n", arm: "match", shown: shownIt };
        return memory.recordNode({ kind: M15_HINT_KIND, claimId: root, data: data as unknown as Json, learned: true }).nodeId;
      };
      const fits = hint(schema.nodeId, true);
      const misses = hint(other.nodeId, false);
      memory.recordNode({
        kind: SKETCH_KIND, claimId: root,
        data: { problemId: "prb_1", attemptId: shown, submission: memory.blobs.put(JSON.stringify({ aux: "", proof: "x" })), names: ["aux_a", "aux_b"], healthy: true, registered: true, holes: parts, edgeId: edge } as unknown as Json,
      });
      settle(problemOf(memory, root), false);
      const read = (id: string) => memory.node(id)?.data as unknown as HintData;
      assert.deepEqual([read(fits).reused, read(fits).matched, read(misses).reused, read(misses).matched], [true, 2, false, 0]);
    } finally {
      w.close();
    }
  });
});

describe("the effect of a schema", () => {
  async function stored(memory: MemoryStore): Promise<string> {
    const skeleton = skeletonOf({ conclusion: ROOT, parts: ["(n : ℕ) : 0 + n = n"], mainProof: "exact aux_a n" }, 0.3);
    assert.ok(typeof skeleton !== "string");
    return memory.recordNode({ kind: SCHEMA_KIND, data: dataOf(skeleton, { names: ["aux_a"], family: "other", region: "1p:=", supports: [], gloss: "g" }) as unknown as Json, learned: true }).nodeId;
  }

  it("retires a schema whose sessions fared worse with it than without it, not one that was only present", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const root = await claim(w, ROOT);
      const harmful = await stored(memory);
      const frequent = await stored(memory);
      for (let k = 0; k < 10; k++) {
        attempt(w, root, { included: [harmful], outcome: "invalid" });
        attempt(w, root, { withheld: [harmful], outcome: "valid" });
        attempt(w, root, { included: [frequent], outcome: "valid" });
        attempt(w, root, { withheld: [frequent], outcome: "valid" });
      }
      const problem = problemOf(memory, root);
      assert.equal(usableSchemas(memory).length, 2);
      retireWorn(problem, m15Settings({ ...M15_OPTIONS, minObservations: 8 }));
      const states = Object.fromEntries(memory.nodes(SCHEMA_KIND).map((n) => [n.nodeId, (n.data as unknown as SchemaData).state]));
      // `frequent` was present as often as `harmful` and fared as well with it as without; only `harmful` is retired.
      assert.equal(states[harmful], "inactive");
      assert.equal(states[frequent], "active");
      assert.match((memory.node(harmful)?.data as unknown as SchemaData).deactivated?.reason ?? "", /P\(effect < 0\) = 1\.00|P\(effect < 0\) = 0\.9/);
      assert.deepEqual(usableSchemas(memory).map((s) => s.nodeId), [frequent]);
    } finally {
      w.close();
    }
  });

  it("does not retire one on too few observations", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      const root = await claim(w, ROOT);
      const id = await stored(memory);
      for (let k = 0; k < 3; k++) {
        attempt(w, root, { included: [id], outcome: "invalid" });
        attempt(w, root, { withheld: [id], outcome: "valid" });
      }
      retireWorn(problemOf(memory, root), m15Settings({ ...M15_OPTIONS, minObservations: 8 }));
      assert.equal(usableSchemas(memory).length, 1);
    } finally {
      w.close();
    }
  });
});

describe("keeping schemas", () => {
  const input = (conclusion: string, parts: string[]) => {
    const s = skeletonOf({ conclusion, parts, mainProof: "exact (aux_b n).trans (aux_a n)" }, 0.3);
    assert.ok(typeof s !== "string", String(s));
    return s;
  };
  let real = "";
  const rest = (k: number) => ({ names: ["aux_a", "aux_b"], family: "rewriting", region: "2p:=", supports: [{ problemId: `p${k}`, claimId: real, edgeId: `e${k}` }], gloss: "g" });

  it("adds a support to a schema that covers a new decomposition, generalizes two of the same shape, and stamps what it stores", async () => {
    const w = world(toyAnswer);
    try {
      const memory = lineMemory(w);
      real = await claim(w, ROOT);
      const problem = problemOf(memory, real);
      const a = input("(n : ℕ) : n + 0 = n", ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n"]);
      assert.equal(keepSchema(problem, a, rest(1), 0.3), 1);
      assert.equal(keepSchema(problem, a, rest(2), 0.3), 0, "the same shape is another support");
      assert.equal(memory.nodes(SCHEMA_KIND).length, 1);
      assert.equal((memory.nodes(SCHEMA_KIND)[0]?.data as unknown as SchemaData).supports.length, 2);
      const b = input("(m : ℕ) : m * 1 = m", ["(m : ℕ) : 1 * m = m", "(m : ℕ) : m * 1 = 1 * m"]);
      assert.equal(keepSchema(problem, b, rest(3), 0.3), 1);
      const schemas = memory.nodes(SCHEMA_KIND).map((n) => [n.nodeId, n.data as unknown as SchemaData] as const);
      assert.equal(schemas.length, 2);
      assert.deepEqual(schemas.map(([, d]) => d.state), ["superseded", "active"]);
      const [, general] = schemas[1] as readonly [string, SchemaData];
      assert.deepEqual(general.generalizes, [schemas[0]?.[0]]);
      assert.equal(general.supports.length, 3);
      assert.deepEqual(usableSchemas(memory).map((s) => s.data.name), [general.name]);
      assert.ok(memory.nodes(SCHEMA_KIND).every((n) => n.provenance?.modelId === "prov/model-5"), "a schema is stamped");
      // A decomposition of another shape is a schema of its own.
      const c = input("(n : ℕ) : n + 0 = n", ["(n : ℕ) : 0 + n = n"]);
      assert.equal(keepSchema(problem, c, { ...rest(4), names: ["aux_a"], region: "1p:=" }, 0.3), 1);
      assert.equal(usableSchemas(memory).length, 2);
    } finally {
      w.close();
    }
  });
});
