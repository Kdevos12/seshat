import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, hash32, Journal, type ProvenanceContext, seeded } from "@seshat/core";
import { DEFAULT_DRAW, drawItems, MemoryStore, shouldDeactivate } from "../src/index.ts";

const context: ProvenanceContext = { modelId: "prov/model-5", promptVersion: "m0-2", mathlibRev: "abc123", harnessVersion: "rev1", budgetClass: "medium" };

function open(provenance: ProvenanceContext = context): { memory: MemoryStore; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "mh-memory-draw-"));
  const journal = Journal.open(dir, "run_1");
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")), provenance }), journal };
}

let counter = 0;

/** An attempt on `claimId` that was shown `included` and denied `withheld`, and ended `outcome`. */
function attempt(
  journal: Journal,
  claimId: string,
  o: { included?: string[]; withheld?: string[]; outcome?: "valid" | "invalid" | "no_submission"; strategy?: string; declared?: string },
): string {
  const attemptId = `att_${++counter}`;
  journal.emit(
    "attempt.started",
    {
      attemptId,
      claimId,
      prover: "p1",
      iteration: 1,
      model: "m",
      ...(o.declared !== undefined ? { strategy: o.declared } : {}),
      ...(o.included !== undefined ? { included: o.included } : {}),
      ...(o.withheld !== undefined ? { withheld: o.withheld } : {}),
    },
    "prover:p1",
  );
  if (o.outcome !== undefined) {
    journal.emit(
      "attempt.finished",
      {
        attemptId,
        outcome: o.outcome,
        ...(o.outcome === "invalid" ? { failureClass: "unsolved_goals" } : {}),
        ...(o.strategy !== undefined ? { strategy: o.strategy } : {}),
        durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0,
      },
      "prover:p1",
    );
  }
  return attemptId;
}

/** `n` attempts that ended `outcome`, with these items shown and denied. */
function many(journal: Journal, claimId: string, n: number, outcome: "valid" | "invalid", items: { included?: string[]; withheld?: string[]; strategy?: string }): void {
  for (let k = 0; k < n; k++) attempt(journal, claimId, { ...items, outcome });
}

const none = { isFact: () => false, uses: () => 0 };

describe("randomized inclusion", () => {
  it("includes a new item with probability p_new, then p after N uses, by the plan's defaults", () => {
    assert.deepEqual(DEFAULT_DRAW, { pNew: 0.5, nNew: 20, p: 0.9 });
    const rate = (uses: number) => {
      let included = 0;
      const random = seeded(hash32("rates"));
      for (let k = 0; k < 4000; k++) included += drawItems(["lesson"], random, { isFact: () => false, uses: () => uses }).included.length;
      return included / 4000;
    };
    assert.ok(Math.abs(rate(0) - 0.5) < 0.03, `new item: ${rate(0)}`);
    assert.ok(Math.abs(rate(19) - 0.5) < 0.03, "still new at 19 uses");
    assert.ok(Math.abs(rate(20) - 0.9) < 0.02, `established item: ${rate(20)}`);
    const draw = drawItems(["a"], seeded(1), { isFact: () => false, uses: () => 20 });
    assert.deepEqual([draw.chances, draw.uses], [{ a: 0.9 }, { a: 20 }]);
    assert.deepEqual(drawItems(["a"], seeded(1), none, { pNew: 1, nNew: 5 }).included, ["a"]);
    assert.deepEqual(drawItems(["a"], seeded(1), none, { pNew: 0 }).withheld, ["a"]);
    assert.throws(() => drawItems(["a"], seeded(1), none, { p: 2 }), RangeError);
    assert.throws(() => drawItems(["a"], seeded(1), none, { nNew: 1.5 }), RangeError);
  });

  it("repeats from the seed, whatever order a line lists the items in", () => {
    const items = ["lesson_a", "lesson_b", "schema_c", "hint_d", "lesson_e", "lesson_f"];
    const first = drawItems(items, seeded(hash32("seed:1")), none);
    assert.deepEqual(first, drawItems(items, seeded(hash32("seed:1")), none));
    const reversed = drawItems([...items].reverse(), seeded(hash32("seed:1")), none);
    assert.deepEqual([...reversed.included].sort(), [...first.included].sort());
    assert.deepEqual([...reversed.withheld].sort(), [...first.withheld].sort());
    const seeds = Array.from({ length: 20 }, (_, k) => drawItems(items, seeded(hash32(`seed:${k}`)), none).included.join());
    assert.ok(new Set(seeds).size > 5, "other seeds draw otherwise");
    assert.equal(first.included.length + first.withheld.length, items.length);
    assert.deepEqual(drawItems(["a", "a", { id: "a" }], seeded(1), none, { pNew: 1 }).included, ["a"], "an item listed twice is drawn once");
  });

  it("never draws a verified fact or the goal: they come back fixed, in neither list", async () => {
    const { memory } = open();
    const goal = await memory.ensureClaim({ statement: ": 1 + 1 = 2", origin: "bench:x" });
    const fact = await memory.ensureClaim({ statement: ": 2 + 2 = 4", origin: "test" });
    const never = { pNew: 0, p: 0 };
    for (let k = 0; k < 50; k++) {
      const draw = memory.draw([goal.claimId, fact.claimId, "lesson_1", { id: "hint_2", verified: true }], seeded(k), never);
      assert.deepEqual(draw.fixed, [goal.claimId, fact.claimId, "hint_2"]);
      assert.deepEqual(draw.withheld, ["lesson_1"], "an unverified item is withheld when the chance is 0");
      assert.deepEqual(draw.included, []);
      assert.deepEqual(Object.keys(draw.chances), ["lesson_1"]);
    }
  });

  it("counts an item's uses from the attempts that included it, since the current epoch", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "t" });
    assert.equal(memory.itemUses("lesson_1"), 0);
    many(journal, claimId, 20, "valid", { included: ["lesson_1"], withheld: ["lesson_2"] });
    assert.equal(memory.itemUses("lesson_1"), 20);
    assert.equal(memory.itemUses("lesson_2"), 0, "a withheld item was not used");
    const random = seeded(7);
    assert.deepEqual(memory.draw(["lesson_1", "lesson_2"], random, {}).chances, { lesson_1: 0.9, lesson_2: 0.5 });
    // A new epoch puts the item back among the new ones: it earns its place again.
    const later = open({ ...context, mathlibRev: "def456" });
    const claim2 = (await later.memory.ensureClaim({ statement: ": True", origin: "t" })).claimId;
    many(later.journal, claim2, 25, "valid", { included: ["lesson_1"] });
    assert.deepEqual(later.memory.draw(["lesson_1"], seeded(7)).chances, { lesson_1: 0.9 });
    later.memory.withActor("orchestrator").openEpochIfChanged(context);
    assert.equal(later.memory.itemUses("lesson_1"), 0);
    assert.deepEqual(later.memory.draw(["lesson_1"], seeded(7)).chances, { lesson_1: 0.5 });
  });
});

describe("effect posteriors", () => {
  it("are the success of the attempts with the item and of those without it, as two Betas, on scripted outcomes", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "t" });
    many(journal, claimId, 6, "valid", { included: ["lesson_1"] });
    many(journal, claimId, 2, "invalid", { included: ["lesson_1"] });
    many(journal, claimId, 1, "valid", { withheld: ["lesson_1"] });
    many(journal, claimId, 4, "invalid", { withheld: ["lesson_1"] });
    attempt(journal, claimId, { included: ["lesson_1"], outcome: "no_submission" });
    attempt(journal, claimId, { included: ["lesson_1"] });
    many(journal, claimId, 3, "invalid", {});
    const effect = memory.itemEffect("lesson_1");
    assert.deepEqual(
      [effect.with.successes, effect.with.failures, effect.with.attempts, effect.with.posterior],
      [6, 2, 8, { alpha: 7, beta: 3 }],
      "a session with no verdict says nothing; the attempts the item was never offered to do not count",
    );
    assert.deepEqual([effect.without.successes, effect.without.failures, effect.without.posterior], [1, 4, { alpha: 2, beta: 5 }]);
    assert.ok(Math.abs(effect.difference - (7 / 10 - 2 / 7)) < 1e-12);
    assert.ok(effect.pNegative < 0.05, `a helpful item: P(effect < 0) = ${effect.pNegative}`);
    assert.equal(memory.itemEffect("never_drawn").with.attempts, 0);
    assert.ok(Math.abs(memory.itemEffect("never_drawn").pNegative - 0.5) < 1e-6, "no observation: no opinion");
  });

  it("stay within a claim group and a strategy label", async () => {
    const { memory, journal } = open();
    const a = (await memory.ensureClaim({ statement: ": True", origin: "t" })).claimId;
    const b = (await memory.ensureClaim({ statement: ": 1 = 1", origin: "t" })).claimId;
    many(journal, a, 5, "valid", { included: ["i"], strategy: "induction" });
    many(journal, a, 5, "invalid", { withheld: ["i"], strategy: "induction" });
    many(journal, a, 5, "invalid", { included: ["i"], strategy: "cases" });
    many(journal, a, 5, "valid", { withheld: ["i"], strategy: "cases" });
    many(journal, b, 9, "invalid", { included: ["i"], strategy: "induction" });
    attempt(journal, a, { included: ["i"], declared: "algebra", outcome: "valid" });
    const induction = memory.itemEffect("i", { claimIds: [a], strategy: "induction" });
    assert.deepEqual([induction.with.posterior, induction.without.posterior], [{ alpha: 6, beta: 1 }, { alpha: 1, beta: 6 }]);
    assert.deepEqual(induction.claimIds, [a]);
    assert.equal(induction.strategy, "induction");
    const cases = memory.itemEffect("i", { claimIds: [a], strategy: "cases" });
    assert.ok(cases.pNegative > 0.95, `harmful in this stratum: ${cases.pNegative}`);
    assert.ok(induction.pNegative < 0.05);
    const wide = memory.itemEffect("i", { claimIds: [a, b], strategy: "induction" });
    assert.equal(wide.with.attempts, 14, "the other claim joins when the group does");
    const split = memory.itemEffects("i", { claimIds: [a] });
    assert.deepEqual(split.map((e) => e.strategy), ["algebra", "cases", "induction"], "one effect per label, in the order of the labels");
    assert.equal(memory.itemEffect("i", { claimIds: [a], strategy: "algebra" }).with.successes, 1, "the declared label counts when none was classified");
  });

  it("apply the deactivation rule: P(effect < 0) above 0.9 after enough observations on each side", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "t" });
    many(journal, claimId, 1, "invalid", { included: ["bad"] });
    many(journal, claimId, 1, "valid", { withheld: ["bad"] });
    assert.equal(shouldDeactivate(memory.itemEffect("bad"), { minObservations: 5 }), false, "too few observations");
    many(journal, claimId, 11, "invalid", { included: ["bad"] });
    many(journal, claimId, 9, "valid", { withheld: ["bad"] });
    many(journal, claimId, 2, "invalid", { withheld: ["bad"] });
    const effect = memory.itemEffect("bad");
    assert.ok(effect.pNegative > 0.99, `${effect.pNegative}`);
    assert.equal(shouldDeactivate(effect, { minObservations: 5 }), true);
    assert.equal(shouldDeactivate(effect, { minObservations: 13 }), false, "13 observations on each side are not there yet");
    assert.equal(shouldDeactivate(effect, { minObservations: 5, threshold: 0.9999999 }), false);
    many(journal, claimId, 6, "valid", { included: ["flat"] });
    many(journal, claimId, 6, "valid", { withheld: ["flat"] });
    assert.equal(shouldDeactivate(memory.itemEffect("flat"), { minObservations: 5 }), false, "no difference: it stays");
  });

  it("counts the observations of an item with their probation weight, so old evidence does not satisfy the minimum", async () => {
    const { memory, journal } = open({ ...context, modelId: "prov/model-6" });
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "t" });
    // Epoch 0: 20 attempts that were shown the item and failed, 20 that were denied it and succeeded.
    many(journal, claimId, 20, "invalid", { included: ["old"] });
    many(journal, claimId, 20, "valid", { withheld: ["old"] });
    const rule = { minObservations: 10 };
    assert.equal(shouldDeactivate(memory.itemEffect("old"), rule), true, "in the current epoch 20 observations are 20");
    memory.withActor("orchestrator").openEpochIfChanged({ ...context, modelId: "prov/model-5" });
    const probation = memory.itemEffect("old");
    assert.equal(probation.with.attempts, 20, "the attempts are still 20");
    assert.ok(Math.abs(probation.with.failures - 5) < 1e-9, "and weigh 5");
    assert.equal(shouldDeactivate(probation, rule), false, "20 old attempts are 5 observations: below the minimum of 10");
    assert.equal(shouldDeactivate(probation, { minObservations: 5 }), true);
    // New outcomes of the current epoch make up the minimum.
    many(journal, claimId, 5, "invalid", { included: ["old"] });
    many(journal, claimId, 5, "valid", { withheld: ["old"] });
    assert.equal(shouldDeactivate(memory.itemEffect("old"), rule), true);
  });

  it("put an item of an older epoch in probation: its old outcomes weigh k each epoch since, new outcomes in full", async () => {
    const { memory, journal } = open({ ...context, modelId: "prov/model-6" });
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "t" });
    // Epoch 0: the item did well, 8 successes against 0 failures with it, 0 against 4 without it.
    many(journal, claimId, 8, "valid", { included: ["i"] });
    many(journal, claimId, 4, "invalid", { withheld: ["i"] });
    const before = memory.itemEffect("i");
    assert.deepEqual([before.with.posterior, before.without.posterior], [{ alpha: 9, beta: 1 }, { alpha: 1, beta: 5 }]);
    assert.ok(before.pNegative < 0.01);
    // The model family changes: epoch 1. The same attempts count a quarter.
    memory.withActor("orchestrator").openEpochIfChanged({ ...context, modelId: "prov/model-5" });
    assert.equal(memory.epoch(), 1);
    const probation = memory.itemEffect("i");
    assert.deepEqual([probation.with.posterior, probation.without.posterior], [{ alpha: 3, beta: 1 }, { alpha: 1, beta: 2 }]);
    assert.deepEqual([probation.with.attempts, probation.without.attempts], [8, 4], "nothing is deleted: the attempts are still there");
    // Time and exposure do not give the weight back: an attempt that was shown the item and said nothing, or any number of draws.
    attempt(journal, claimId, { included: ["i"], outcome: "no_submission" });
    memory.draw(["i"], seeded(1));
    assert.deepEqual(memory.itemEffect("i").with.posterior, { alpha: 3, beta: 1 });
    // Outcomes of the new epoch do, one for one.
    many(journal, claimId, 2, "invalid", { included: ["i"] });
    assert.deepEqual(memory.itemEffect("i").with.posterior, { alpha: 3, beta: 3 });
    // A second epoch shrinks the old ones again, and the first epoch's new outcomes too.
    memory.withActor("orchestrator").openEpoch({ changes: [{ field: "mathlibRev", from: "a", to: "b" }] });
    assert.equal(memory.weightOf(0), 0.0625);
    assert.deepEqual(memory.itemEffect("i").with.posterior, { alpha: 1 + 8 * 0.0625, beta: 1 + 2 * 0.25 });
  });
});
