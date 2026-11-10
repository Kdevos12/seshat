import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVENT_TYPES, Journal } from "../src/index.ts";

const finished = (over: Record<string, unknown> = {}) => ({ problemId: "p", claimId: "clm_1", state: "done" as const, queries: [], hits: 0, kept: 0, dropped: [], settled: 0, usd: 0, capUsd: 0.05, ...over });

describe("the intake events", () => {
  it("are known events: consent is a person's or the orchestrator's by rule, the record is the orchestrator's", () => {
    assert.ok(EVENT_TYPES.includes("intake.consented") && EVENT_TYPES.includes("intake.finished"));
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "intake-ev-")), "run_t");
    try {
      journal.emit("intake.consented", { problemId: "p", allowed: true, via: "asked" }, "human:ada");
      journal.emit("intake.consented", { problemId: "p", allowed: true, via: "bench" }, "orchestrator");
      journal.emit("intake.consented", { problemId: "p", allowed: false, via: "private" }, "orchestrator");
      assert.throws(() => journal.emit("intake.consented", { problemId: "p", allowed: true, via: "asked" }, "orchestrator"), /a person's/);
      assert.throws(() => journal.emit("intake.consented", { problemId: "p", allowed: true, via: "bench" }, "human:ada"), /orchestrator/);
      assert.throws(() => journal.emit("intake.consented", { problemId: "p", allowed: true, via: "private" }, "orchestrator"), /never allows/);
      journal.emit("intake.finished", finished(), "orchestrator");
      journal.emit("intake.finished", finished({ state: "skipped", reason: "private" }), "orchestrator");
      assert.throws(() => journal.emit("intake.finished", finished({ state: "skipped" }), "orchestrator"), /says why/);
      assert.throws(() => journal.emit("intake.finished", finished(), "line:M1"), /orchestrator/);
    } finally {
      journal.close();
    }
  });
});
