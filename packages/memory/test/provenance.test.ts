import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, type ProvenanceContext } from "@seshat/core";
import {
  betaCdf,
  betaMean,
  betaOfCounts,
  describeEpochChanges,
  lnGamma,
  MemoryStore,
  probabilityLess,
  probationWeight,
  shrinkBeta,
} from "../src/index.ts";

const context: ProvenanceContext = { modelId: "prov/model-5", promptVersion: "m0-2", mathlibRev: "abc123", harnessVersion: "rev1", budgetClass: "medium" };

function open(options: { provenance?: ProvenanceContext; probation?: number } = {}): { memory: MemoryStore; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "mh-memory-prov-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({
    journal,
    blobs: new BlobStore(join(dir, "blobs")),
    now: () => new Date("2026-10-27T10:00:00Z"),
    ...("provenance" in options ? { provenance: options.provenance as ProvenanceContext } : { provenance: context }),
    ...(options.probation !== undefined ? { probation: options.probation } : {}),
  });
  return { memory, journal };
}

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

describe("the provenance stamp of the store", () => {
  it("stamps what a mechanism learned, with the run's context and the store's clock", async () => {
    const { memory } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "test" });
    const lesson = memory.withActor("line:M5").recordNode({ kind: "lesson", claimId, data: { text: "t" }, learned: true });
    assert.deepEqual(lesson.provenance, { ...context, createdAt: "2026-10-27T10:00:00.000Z" });
    assert.equal(lesson.epoch, 0);
    assert.equal(memory.node(lesson.nodeId)?.provenance?.modelId, "prov/model-5");
    assert.equal(memory.stamp({ modelId: "prov/other" }).modelId, "prov/other");
    const plain = memory.recordNode({ kind: "fingerprint", data: null });
    assert.equal(plain.provenance, undefined, "a node that is not learned carries no stamp");
  });

  it("refuses to stamp without a context", () => {
    const { memory } = open({ provenance: undefined as never });
    assert.throws(() => memory.stamp(), /no provenance context/);
    assert.throws(() => memory.recordNode({ kind: "lesson", data: null, learned: true }), /no provenance context/);
    assert.throws(() => memory.openEpochIfChanged(context), /no provenance context/);
  });

  it("is on the attempt records and the lessons it reads", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "test" });
    const stamp = memory.stamp();
    journal.emit("attempt.started", { attemptId: "att_1", claimId, prover: "p1", iteration: 1, model: "prov/model-5", provenance: stamp }, "prover:p1");
    journal.emit("lesson.recorded", { attemptId: "att_1", claimId, text: "notes", provenance: stamp }, "prover:p1");
    assert.deepEqual(memory.attempts(claimId)[0]?.provenance, stamp);
    assert.equal(memory.attempts(claimId)[0]?.epoch, 0);
    assert.deepEqual(memory.lessons(claimId).map((l) => [l.text, l.provenance?.mathlibRev]), [["notes", "abc123"]]);
  });
});

describe("epochs and probation", () => {
  it("opens an epoch on each trigger, with the reason, and not when nothing changed", () => {
    for (const [change, field] of [
      [{ modelId: "prov/model-6" }, "modelFamily"],
      [{ promptVersion: "m0-3" }, "promptMajor"],
      [{ mathlibRev: "def456" }, "mathlibRev"],
    ] as const) {
      const { memory } = open({ provenance: { ...context, ...change } });
      const opened = memory.withActor("orchestrator").openEpochIfChanged(context);
      assert.equal(opened?.epoch, 1);
      assert.deepEqual(opened?.changes.map((c) => c.field), [field]);
      assert.match(opened?.reason ?? "", /changed from/);
      assert.equal(memory.epoch(), 1);
      assert.equal(memory.withActor("orchestrator").openEpochIfChanged(context)?.epoch, 2, "each call that finds a difference opens one more");
    }
    const same = open({ provenance: { ...context, harnessVersion: "rev2", budgetClass: "large", modelId: "prov/model-5-20251101" } });
    assert.equal(same.memory.withActor("orchestrator").openEpochIfChanged(context), undefined);
    assert.equal(same.memory.epoch(), 0);
    assert.deepEqual(same.memory.epochs(), []);
  });

  it("is opened by the orchestrator's store, not by a line's view", () => {
    const { memory } = open({ provenance: { ...context, modelId: "prov/model-6" } });
    assert.throws(() => memory.withActor("line:M5").openEpochIfChanged(context), /orchestrator only/);
    assert.equal(memory.epoch(), 0);
  });

  it("describes the changes in words", () => {
    assert.equal(
      describeEpochChanges([{ field: "modelFamily", from: "a", to: "b" }, { field: "mathlibRev", from: "x", to: "y" }]),
      "the prover model family changed from a to b; the Mathlib revision changed from x to y",
    );
  });

  it("weighs an outcome k for each epoch since, and an outcome of the current epoch in full", () => {
    assert.equal(probationWeight(3, 3), 1);
    assert.equal(probationWeight(3, 2), 0.25);
    assert.equal(probationWeight(3, 0, 0.5), 0.125);
    assert.equal(probationWeight(0, 0), 1);
    assert.throws(() => probationWeight(1, 0, 1.5), RangeError);
    const { memory } = open({ provenance: { ...context, modelId: "prov/model-6" }, probation: 0.5 });
    assert.equal(memory.weightOf(0), 1);
    memory.withActor("orchestrator").openEpochIfChanged(context);
    assert.equal(memory.weightOf(0), 0.5);
    assert.equal(memory.weightOf(1), 1);
  });

  it("shrinks the counters toward the prior: Beta(a, b) becomes Beta(1 + (a - 1) k, 1 + (b - 1) k)", () => {
    assert.deepEqual(shrinkBeta({ alpha: 9, beta: 5 }, 0.25), { alpha: 3, beta: 2 });
    assert.deepEqual(shrinkBeta({ alpha: 9, beta: 5 }, 1), { alpha: 9, beta: 5 });
    assert.deepEqual(shrinkBeta({ alpha: 9, beta: 5 }, 0), { alpha: 1, beta: 1 });
    assert.deepEqual(shrinkBeta({ alpha: 1, beta: 1 }, 0.25), { alpha: 1, beta: 1 }, "the prior stays the prior");
    assert.throws(() => shrinkBeta({ alpha: 2, beta: 2 }, -0.1), RangeError);
    // Counting the outcomes with their weights is the same shrinkage: 8 successes and 4 failures of an older epoch, at k = 0.25.
    assert.deepEqual(betaOfCounts(8 * 0.25, 4 * 0.25), shrinkBeta(betaOfCounts(8, 4), 0.25));
  });

  it("gives an item in probation its weight back only through outcomes", async () => {
    // Items 'a' had 8 successes and 0 failures in epoch 0, and the memory moved to epoch 1: the counters
    // weigh 2 and 0. Nothing but a new outcome moves them: being shown (a use) or the passing of time does not.
    const { memory } = open({ provenance: { ...context, modelId: "prov/model-6" } });
    const old = betaOfCounts(8 * memory.weightOf(0), 0);
    assert.deepEqual(old, { alpha: 9, beta: 1 }, "before the epoch: the old counters in full");
    memory.withActor("orchestrator").openEpochIfChanged(context);
    const probation = betaOfCounts(8 * memory.weightOf(0), 0);
    assert.deepEqual(probation, { alpha: 3, beta: 1 });
    // The same counters, read again after more epochs of the same weight rule: still k per epoch since, never more.
    assert.ok(betaMean(probation) < betaMean(old));
    // One outcome of the new epoch weighs 1: 3 + 1.
    assert.deepEqual(betaOfCounts(8 * memory.weightOf(0) + 1 * memory.weightOf(1), 0), { alpha: 4, beta: 1 });
    void (await memory.ensureClaim({ statement: ": True", origin: "t" }));
  });
});

describe("Beta arithmetic", () => {
  it("computes ln Gamma, the CDF and P(X < Y) against known values", () => {
    close(lnGamma(1), 0);
    close(lnGamma(5), Math.log(24), 1e-9);
    close(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
    close(betaCdf(0.3, { alpha: 1, beta: 1 }), 0.3, 1e-9);
    close(betaCdf(0.5, { alpha: 2, beta: 2 }), 0.5, 1e-9);
    close(betaCdf(0.25, { alpha: 2, beta: 1 }), 0.0625, 1e-9);
    close(probabilityLess({ alpha: 1, beta: 1 }, { alpha: 1, beta: 1 }), 0.5, 1e-6);
    close(probabilityLess({ alpha: 5, beta: 3 }, { alpha: 5, beta: 3 }), 0.5, 1e-6);
    // X uniform, Y with density 2y: P(X < Y) = the integral of 2y * y = 2/3.
    close(probabilityLess({ alpha: 1, beta: 1 }, { alpha: 2, beta: 1 }), 2 / 3, 1e-6);
    close(probabilityLess({ alpha: 2, beta: 1 }, { alpha: 1, beta: 1 }), 1 / 3, 1e-6);
    const [x, y] = [{ alpha: 3.5, beta: 6 }, { alpha: 7, beta: 2.25 }];
    close(probabilityLess(x, y) + probabilityLess(y, x), 1, 1e-6);
    assert.ok(probabilityLess({ alpha: 2, beta: 30 }, { alpha: 30, beta: 2 }) > 0.999999);
  });
});
