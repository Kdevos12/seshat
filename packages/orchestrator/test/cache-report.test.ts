import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { buildReport, renderRunReport } from "../src/index.ts";
import { cacheReport } from "../src/cache-report.ts";
import { check, demoRun, pricedRegistry } from "./m0-helpers.ts";

const ev = (type: string, data: object): HarnessEvent => ({ type, data }) as unknown as HarnessEvent;
const near = (a: number | undefined, b: number) => assert.ok(Math.abs((a ?? NaN) - b) < 1e-12, `${a} is not ${b}`);

describe("the cache report", () => {
  it("gives the share and the savings per session, per line and per rung, from the journal alone", () => {
    const events = [
      ev("task.created", { taskId: "t1", problemId: "p1" }),
      ev("attempt.started", { attemptId: "a1", taskId: "t1" }),
      ev("attempt.charged", { attemptId: "a1", usd: 1, inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 }),
      ev("attempt.charged", { attemptId: "a1", usd: 1, inputTokens: 100, outputTokens: 1, cachedInputTokens: 90, savedUsd: 0.5 }),
      ev("attempt.finished", { attemptId: "a1", turns: 2, usd: 2, inputTokens: 200, outputTokens: 2, cachedInputTokens: 90, savedUsd: 0.5 }),
      ev("ladder.escalated", { problemId: "p1", to: 1 }),
      // A session the harness failed in: its finished record carries no cached sum, the charges do.
      ev("attempt.started", { attemptId: "a2", taskId: "t1" }),
      ev("attempt.charged", { attemptId: "a2", usd: 1, inputTokens: 100, outputTokens: 1, cachedInputTokens: 50, savedUsd: 0.25 }),
      ev("attempt.finished", { attemptId: "a2", turns: 1, usd: 1, inputTokens: 100, outputTokens: 1 }),
      ev("model_call.finished", { modelCallId: "m1", line: "M4", problemId: "p1", model: "x/y", outcome: "ok", usd: 0.5, inputTokens: 40, outputTokens: 1, cachedInputTokens: 10, savedUsd: 0.1 }),
      // Made inside a session: already in its totals.
      ev("model_call.finished", { modelCallId: "m2", line: "M4", attemptId: "a1", model: "x/y", outcome: "ok", usd: 9, inputTokens: 999, outputTokens: 1 }),
    ];
    const report = cacheReport(events);
    assert.ok(report !== undefined);
    assert.equal(report.total.inputTokens, 340);
    assert.equal(report.total.cachedInputTokens, 150);
    near(report.total.ratio, 150 / 340);
    near(report.total.savedUsd, 0.85);
    assert.deepEqual(report.sessions.map((s) => [s.attemptId, s.ratio]), [["a1", 0.45], ["a2", 0.5]]);
    near(report.byLine.prover?.ratio, 140 / 300);
    near(report.byLine.M4?.savedUsd, 0.1);
    assert.equal(report.byRung?.["0"]?.cachedInputTokens, 90);
    assert.equal(report.byRung?.["1"]?.cachedInputTokens, 60);
  });

  it("has nothing to say about a journal with no charges", () => {
    assert.equal(cacheReport([ev("problem.registered", { problemId: "p", target: "t" })]), undefined);
  });

  it("is in the run's report, with the dollars saved at the host's prices, from a faux provider that reports cache tokens", async () => {
    const pricing = { cacheHit: 0.1, cacheMiss: 2, output: 8 };
    const { events } = await demoRun({ responses: [check("bad"), check("bad"), check("exact trivial_proof")], registry: pricedRegistry({ "faux/prover": { pricing } }) });
    const report = buildReport(events);
    assert.ok(report.cache !== undefined);
    assert.ok((report.cache.total.ratio ?? 0) > 0.3, "later requests read the earlier ones from the cache");
    near(report.cache.total.savedUsd, (report.cache.total.cachedInputTokens * 1.9) / 1e6);
    assert.equal(report.cache.sessions.length, 1);
    assert.match(renderRunReport(report), /Prompt cache: \d+% of the input read from the cache, which saved \$/);
  });
});
