import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetClassOf, isProvenance } from "@seshat/core";
import { PROMPT_VERSION } from "../src/index.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

describe("the provenance stamp of a run", () => {
  it("is on every attempt record and every lesson of an M0 run, with the run's model, prompt, revision and budget class", async () => {
    const run = await demoRun({
      responses: [check("sorry"), say("notes of the first session"), check("exact trivial_proof")],
      config: { sessions: 2 },
      codeRev: "rev-test",
    });
    const attempts = ofType(run.events, "attempt.started");
    assert.equal(attempts.length, 2);
    const model = run.events.find((e) => e.type === "run.started")?.data.config as { model: string; bench: { source: { rev: string } } };
    for (const { data } of attempts) {
      assert.ok(isProvenance(data.provenance), "the attempt record is stamped");
      assert.deepEqual(
        { ...data.provenance, createdAt: "t" },
        { modelId: model.model, promptVersion: PROMPT_VERSION, mathlibRev: model.bench.source.rev, harnessVersion: "rev-test", budgetClass: budgetClassOf(5), createdAt: "t" },
      );
    }
    const lessons = ofType(run.events, "lesson.recorded");
    assert.equal(lessons.length, 1);
    assert.ok(isProvenance(lessons[0]?.data.provenance), "the lesson is stamped");
    assert.equal(lessons[0]?.data.provenance?.promptVersion, PROMPT_VERSION);
  });

  it("changes nothing else about an M0 run: no draw, no epoch", async () => {
    const run = await demoRun({ responses: [check("exact trivial_proof")] });
    for (const { data } of ofType(run.events, "attempt.started")) {
      assert.equal(data.included, undefined);
      assert.equal(data.withheld, undefined);
    }
    assert.deepEqual(ofType(run.events, "memory.epoch_opened"), []);
    assert.equal((run.events.find((e) => e.type === "run.started")?.data as Record<string, unknown>).memoryFrom, undefined);
  });
});
