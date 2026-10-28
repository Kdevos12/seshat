import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  budgetClassOf,
  configClassKey,
  configClassOf,
  epochChanges,
  hash32,
  isProvenance,
  Journal,
  modelFamily,
  type Provenance,
  type ProvenanceContext,
  promptMajor,
  provenanceProblems,
  seeded,
  stampProvenance,
  statementIdV0,
} from "../src/index.ts";

const context: ProvenanceContext = { modelId: "prov/model-5", promptVersion: "m0-2", mathlibRev: "abc123", harnessVersion: "rev1", budgetClass: "medium" };

function open(): Journal {
  return Journal.open(mkdtempSync(join(tmpdir(), "mh-prov-")), "run_1");
}

function claim(journal: Journal, claimId = "clm_1"): void {
  journal.emit("claim.created", { claimId, statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
}

const stamp = (changes: Partial<ProvenanceContext> = {}): Provenance => stampProvenance({ ...context, ...changes }, { now: new Date("2026-10-27T10:00:00Z") });

describe("the provenance stamp", () => {
  it("has the six fields, with the context's values and the time of the artifact", () => {
    assert.deepEqual(stamp(), { ...context, createdAt: "2026-10-27T10:00:00.000Z" });
    assert.equal(stampProvenance(context, { modelId: "prov/other", now: new Date(0) }).modelId, "prov/other");
    assert.ok(isProvenance(stamp()));
  });

  it("is checked for its shape", () => {
    assert.deepEqual(provenanceProblems(stamp()), []);
    assert.match(provenanceProblems({ ...stamp(), mathlibRev: "" }).join(), /mathlibRev must be a non-empty string/);
    assert.match(provenanceProblems({ ...stamp(), extra: 1 }).join(), /unknown field/);
    assert.match(provenanceProblems({ ...stamp(), createdAt: "yesterday" }).join(), /ISO 8601/);
    assert.match(provenanceProblems("x").join(), /an object/);
  });

  it("names the model family without the snapshot suffix, the prompt major and the budget class", () => {
    assert.equal(modelFamily("prov/model-5-20250929"), "prov/model-5");
    assert.equal(modelFamily("prov/model-5-2025-09-29"), "prov/model-5");
    assert.equal(modelFamily("prov/model-5@20250929"), "prov/model-5");
    assert.equal(modelFamily("prov/model-5-latest"), "prov/model-5");
    assert.equal(modelFamily("prov/model-5"), "prov/model-5");
    assert.notEqual(modelFamily("prov/model-5"), modelFamily("prov/model-6"), "a version number is a family");
    assert.equal(promptMajor("m0-2"), "m0-2");
    assert.equal(promptMajor("m0-2.1"), "m0-2");
    assert.equal(promptMajor("m0-12.3.4"), "m0-12");
    assert.equal(promptMajor("plain"), "plain");
    assert.deepEqual([0.1, 1, 5, 20, 100, undefined].map(budgetClassOf), ["tiny", "small", "medium", "large", "huge", "unbounded"]);
    assert.deepEqual(configClassOf({ modelId: "prov/model-5-20250929", budgetClass: "small" }), { family: "prov/model-5", budgetClass: "small" });
    assert.equal(configClassKey({ modelId: "prov/model-5", budgetClass: "small" }), "prov/model-5@small");
  });

  it("opens an epoch on each trigger, and on nothing else", () => {
    assert.deepEqual(epochChanges(context, { ...context, harnessVersion: "rev2", budgetClass: "large" }), []);
    assert.deepEqual(epochChanges(context, { ...context, modelId: "prov/model-5-20251101" }), [], "a new snapshot of the family is the same family");
    assert.deepEqual(epochChanges(context, { ...context, promptVersion: "m0-2.1" }), [], "a minor wording change is the same major");
    assert.deepEqual(epochChanges(context, { ...context, modelId: "prov/model-6" }), [{ field: "modelFamily", from: "prov/model-5", to: "prov/model-6" }]);
    assert.deepEqual(epochChanges(context, { ...context, promptVersion: "m0-3" }), [{ field: "promptMajor", from: "m0-2", to: "m0-3" }]);
    assert.deepEqual(epochChanges(context, { ...context, mathlibRev: "def456" }), [{ field: "mathlibRev", from: "abc123", to: "def456" }]);
    assert.equal(epochChanges(context, { ...context, modelId: "prov/model-6", promptVersion: "m0-3", mathlibRev: "z" }).length, 3);
  });
});

describe("the seeded source of the core", () => {
  it("repeats from its seed", () => {
    const a = Array.from({ length: 5 }, seeded(hash32("seed:key")));
    assert.deepEqual(a, Array.from({ length: 5 }, seeded(hash32("seed:key"))));
    assert.notDeepEqual(a, Array.from({ length: 5 }, seeded(hash32("seed:other"))));
  });
});

describe("provenance in the journal", () => {
  it("is kept with the attempt, the lesson and the node, and refused when it is not a stamp", () => {
    const journal = open();
    claim(journal);
    const started = { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "prov/model-5" };
    assert.throws(() => journal.emit("attempt.started", { ...started, provenance: { ...stamp(), modelId: "" } }, "prover:p1"), /modelId must be a non-empty string/);
    journal.emit("attempt.started", { ...started, provenance: stamp() }, "prover:p1");
    journal.emit("lesson.recorded", { attemptId: "att_1", claimId: "clm_1", text: "notes", provenance: stamp() }, "prover:p1");
    assert.throws(() => journal.emit("lesson.recorded", { attemptId: "att_1", claimId: "clm_1", text: "x", provenance: {} as never }, "prover:p1"), /provenance/);
    journal.emit("node.recorded", { nodeId: "nod_1", kind: "lesson", claimId: "clm_1", data: { text: "t" }, provenance: stamp() }, "line:M5");
    assert.throws(() => journal.emit("node.recorded", { nodeId: "nod_2", kind: "lesson", data: null, provenance: { modelId: "x" } as never }, "line:M5"), /provenance/);
    const p = journal.projection;
    assert.deepEqual(p.attempt("att_1")?.provenance, stamp());
    assert.deepEqual(p.lessons("clm_1")[0]?.provenance, stamp());
    assert.deepEqual(p.node("nod_1")?.provenance, stamp());
    journal.emit("node.recorded", { nodeId: "nod_3", kind: "fingerprint", data: null }, "line:M11");
    assert.equal(p.node("nod_3")?.provenance, null, "a node that is not learned has none");
    journal.close();
  });

  it("records an epoch that follows the last, with its reason, by the orchestrator only", () => {
    const journal = open();
    const p = journal.projection;
    assert.equal(p.currentEpoch(), 0);
    const open1 = { epoch: 1, reason: "the model changed", changes: [{ field: "modelFamily" as const, from: "a", to: "b" }], provenance: stamp() };
    assert.throws(() => journal.emit("memory.epoch_opened", open1, "line:M5"), /orchestrator only/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, epoch: 2 }, "orchestrator"), /epoch 1 of the memory, not 2/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, reason: "" }, "orchestrator"), /needs a reason/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, changes: [] }, "orchestrator"), /says what/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, changes: [{ field: "harnessVersion" as never, from: "a", to: "b" }] }, "orchestrator"), /does not open an epoch|not a change that opens/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, changes: [{ field: "mathlibRev", from: "a", to: "a" }] }, "orchestrator"), /one value to another/);
    assert.throws(() => journal.emit("memory.epoch_opened", { ...open1, provenance: undefined as never }, "orchestrator"), /needs a provenance/);
    journal.emit("memory.epoch_opened", open1, "orchestrator");
    assert.equal(p.currentEpoch(), 1);
    journal.emit("memory.epoch_opened", { ...open1, epoch: 2 }, "orchestrator");
    assert.deepEqual(p.epochs().map((e) => [e.epoch, e.reason]), [[1, "the model changed"], [2, "the model changed"]]);
    claim(journal);
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "m" }, "prover:p1");
    assert.equal(p.attempt("att_1")?.epoch, 2, "an attempt belongs to the epoch it started in");
    journal.close();
  });

  it("checks the items a draw included and withheld", () => {
    const journal = open();
    claim(journal);
    const started = { claimId: "clm_1", prover: "p1", iteration: 1, model: "m" };
    assert.throws(() => journal.emit("attempt.started", { ...started, attemptId: "att_1", included: ["a"], withheld: ["a"] }, "prover:p1"), /drawn twice/);
    assert.throws(() => journal.emit("attempt.started", { ...started, attemptId: "att_1", included: ["a", "a"] }, "prover:p1"), /drawn twice/);
    assert.throws(() => journal.emit("attempt.started", { ...started, attemptId: "att_1", withheld: [""] }, "prover:p1"), /item ids/);
    journal.emit("attempt.started", { ...started, attemptId: "att_1", included: ["a", "b"], withheld: ["c"] }, "prover:p1");
    journal.emit("attempt.started", { ...started, attemptId: "att_2", included: ["a"], withheld: ["b"] }, "prover:p1");
    const p = journal.projection;
    assert.deepEqual([p.attempt("att_1")?.included, p.attempt("att_1")?.withheld], [["a", "b"], ["c"]]);
    assert.equal(p.attempt("att_3"), undefined);
    assert.equal(p.itemUses("a"), 2);
    assert.equal(p.itemUses("b"), 1);
    assert.equal(p.itemUses("c"), 0, "a withheld item was not used");
    assert.deepEqual(p.itemAttempts("b").map((r) => [r.attempt.attempt_id, r.included]), [["att_1", true], ["att_2", false]]);
    journal.close();
  });
});
