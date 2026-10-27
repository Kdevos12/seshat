import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Journal, type Json } from "@seshat/core";
import { completeJson, type Line, type LineHooks } from "@seshat/lines";
import type { JsonSchema } from "@seshat/registry";
import { mergeSiteSpend, siteSpend } from "../src/index.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

const score: JsonSchema = { type: "object", properties: { score: { type: "integer", minimum: 0, maximum: 10 } }, required: ["score"] };

/** A line whose only act is `beforeProvers`. */
function asking(beforeProvers: NonNullable<LineHooks["beforeProvers"]>): Line {
  return { id: "M4", title: "asks", requires: [], hooks: { beforeProvers } };
}

describe("sites", () => {
  it("tags a line's calls and a prover's sessions, and splits the report's spend by site", async () => {
    const seen: Json[] = [];
    const line = asking(async (problem) => {
      seen.push((await problem.llm.complete({ prompt: "Say hi.", site: "test.greet" })).text);
      seen.push((await completeJson<{ score: number }>(problem.llm, { prompt: "Rate it.", schema: score, site: "test.rate" })).value as Json);
      seen.push((await problem.llm.complete({ prompt: "No site." })).text);
    });
    const { result, events, dir } = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"] },
      responses: [say("hi"), say('{"score": 4}'), say("anonymous"), check("bad"), check("exact trivial_proof")],
    });
    assert.deepEqual(seen, ["hi", { score: 4 }, "anonymous"]);
    assert.deepEqual(ofType(events, "model_call.finished").map((e) => e.data.site), ["test.greet", "test.rate", "m4.unlabeled"]);

    const sites = result.report.sites;
    assert.deepEqual(sites.map((s) => s.site).sort(), ["m4.unlabeled", "prover.session", "test.greet", "test.rate"]);
    assert.ok(Math.abs(sites.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9, "the shares add up to the whole");
    assert.ok(Math.abs(sites.reduce((sum, s) => sum + s.usd, 0) - result.report.usd) < 1e-9, "the sites add up to the run's cost");
    const prover = sites.find((s) => s.site === "prover.session");
    assert.equal(prover?.calls, ofType(events, "attempt.finished").reduce((sum, e) => sum + e.data.turns, 0));
    assert.ok(sites.every((s, i) => i === 0 || (sites[i - 1]?.usd ?? 0) >= s.usd), "the biggest spender first");

    // The projection says the same as the events.
    const journal = Journal.open(dir, result.runId);
    try {
      const projected = journal.projection.spendBySite();
      assert.deepEqual(
        projected.map((s) => [s.site, s.requests]),
        sites.map((s) => [s.site, s.calls]),
      );
      for (const [i, s] of projected.entries()) assert.ok(Math.abs(s.usd - (sites[i]?.usd ?? NaN)) < 1e-9, s.site);
    } finally {
      journal.close();
    }
    assert.deepEqual(siteSpend(events), sites);
  });

  it("merges the spend of several runs by site", async () => {
    const line = asking(async (problem) => void (await problem.llm.complete({ prompt: "Say hi.", site: "test.greet" })));
    const run = () => demoRun({ lines: { M4: line }, config: { lines: ["M4"] }, responses: [say("hi"), check("exact trivial_proof")] });
    const [a, b] = [await run(), await run()];
    const merged = mergeSiteSpend([a.result.report.sites, b.result.report.sites]);
    assert.deepEqual(merged.map((s) => s.site).sort(), ["prover.session", "test.greet"]);
    const total = a.result.report.usd + b.result.report.usd;
    assert.ok(Math.abs(merged.reduce((sum, s) => sum + s.usd, 0) - total) < 1e-9);
    const greet = merged.find((s) => s.site === "test.greet");
    assert.equal(greet?.calls, 2);
    assert.ok(Math.abs((greet?.usd ?? 0) - 2 * (a.result.report.sites.find((s) => s.site === "test.greet")?.usd ?? 0)) < 1e-9);
  });

  it("refuses a site that is not a dotted lowercase name before the call is paid for", async () => {
    let failure: string | undefined;
    const line = asking(async (problem) => {
      try {
        await problem.llm.complete({ prompt: "Say hi.", site: "Bad Site" });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    });
    const { events, faux } = await demoRun({ lines: { M4: line }, config: { lines: ["M4"] }, responses: [check("exact trivial_proof")] });
    assert.match(failure ?? "", /"Bad Site" is not a site/);
    assert.equal(ofType(events, "model_call.finished").length, 0);
    assert.equal(faux.getPendingResponseCount(), 0, "the one response was the prover's");
  });
});

describe("completeJson in a run", () => {
  it("retries once, and charges and journals the second call like the first", async () => {
    let answer: { value: { score: number }; modelCallIds: readonly string[]; cost: { usd: number } } | undefined;
    const line = asking(async (problem) => {
      answer = await completeJson<{ score: number }>(problem.llm, { prompt: "Rate it.", schema: score, site: "test.rate" });
    });
    const { result, events } = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"] },
      responses: [say("a seven, I think"), say('{"score": 7}'), check("exact trivial_proof")],
    });
    assert.deepEqual(answer?.value, { score: 7 });
    const calls = ofType(events, "model_call.finished");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => [c.data.site, c.data.outcome, c.actor]), [["test.rate", "ok", "line:M4"], ["test.rate", "ok", "line:M4"]]);
    assert.deepEqual(answer?.modelCallIds, calls.map((c) => c.data.modelCallId));
    assert.ok(calls.every((c) => c.data.usd > 0 && c.data.responseHash !== undefined && c.data.requestHash !== ""));
    assert.ok(Math.abs((answer?.cost.usd ?? 0) - calls.reduce((sum, c) => sum + c.data.usd, 0)) < 1e-9);
    const sessions = ofType(events, "attempt.finished").reduce((sum, a) => sum + a.data.usd, 0);
    const paid = calls.reduce((sum, c) => sum + c.data.usd, 0);
    assert.ok(Math.abs((result.problems[0]?.usd ?? 0) - sessions - paid) < 1e-9, "the problem pays for both calls");
    assert.equal(result.report.modelCalls?.total, 2);
  });

  it("fails clearly after the second wrong answer, both calls journaled and charged", async () => {
    const line = asking(async (problem) => void (await completeJson(problem.llm, { prompt: "Rate it.", schema: score, site: "test.rate" })));
    const { result, events } = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"] },
      responses: [say("no idea"), say('{"score": 12}')],
    });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.match(result.problems[0]?.reason ?? "", /line M4 failed in beforeProvers: the model's answer does not match the schema, after a retry: \$\.score: greater than 10/);
    const calls = ofType(events, "model_call.finished");
    assert.equal(calls.length, 2, "one retry, no more");
    assert.ok(calls.every((c) => c.data.usd > 0 && c.data.site === "test.rate"));
    assert.equal(ofType(events, "attempt.started").length, 0, "the provers never started");
    assert.ok(Math.abs((result.problems[0]?.usd ?? 0) - calls.reduce((sum, c) => sum + c.data.usd, 0)) < 1e-9, "both calls were charged");
  });
});

