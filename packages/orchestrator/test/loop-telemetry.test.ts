import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, readEvents } from "@seshat/core";
import { loopTelemetry, renderLoop } from "../src/loop-telemetry.ts";
import { buildReport, renderRunReport } from "../src/report.ts";

/** A journal written by hand: two problems; the first has three attempts (the last two fail the same way), the second one that proves it. */
function journalOf(options: { split?: boolean; verdicts?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-loop-"));
  const j = Journal.open(dir, "run_loop");
  const o = "orchestrator";
  j.emit("run.started", { runId: "run_loop", benchId: "b", problems: 2, host: "test", config: { budget: { problemUsd: 1, runUsd: 5 } } }, o);
  for (const [taskId, problemId] of [["t1", "p1"], ["t2", "p2"]] as const) {
    const claimId = `c_${taskId}`;
    j.emit("claim.created", { claimId, statementId: `sid_${claimId}`, statement: "S", origin: "test", status: "open", kind: "formal" }, "memory");
    j.emit("problem.registered", { problemId, claimId, target: problemId, source: { repo: "r", rev: "x", path: "B.lean" }, domain: [] }, o);
    j.emit("task.created", { taskId, kind: "prove", problemId, claimId, dependsOn: [], owner: "prover:p1", acceptance: { type: "claim", claimId, minStatus: "proved" }, budget: { sessions: 3 } }, o);
    j.emit("task.status_changed", { taskId, from: "pending", to: "ready", reason: "ready" }, o);
    j.emit("task.status_changed", { taskId, from: "ready", to: "running", reason: "started" }, o);
  }
  const attempt = (attemptId: string, taskId: string, checks: number[], finish: Record<string, unknown>) => {
    j.emit("attempt.started", { attemptId, claimId: `c_${taskId}`, prover: "p1", iteration: 1, model: "faux/m", taskId }, "prover:p1");
    // Two requests; the last one's input is the context the session ended with.
    const cacheRead = options.split === true ? { cachedInputTokens: 800, cacheReadUsd: 0.001, outputUsd: 0.004 } : {};
    j.emit("attempt.charged", { attemptId, usd: 0.005, inputTokens: 1000, outputTokens: 100, ...cacheRead }, "prover:p1");
    j.emit("attempt.charged", { attemptId, usd: 0.005, inputTokens: 2500, outputTokens: 100, ...cacheRead }, "prover:p1");
    checks.forEach((ms, i) => {
      const toolRunId = `${attemptId}_run${i}`;
      j.emit("tool_run.started", { toolRunId, capability: "lean.check", implementation: "x", version: "1", inputHash: "h", attemptId }, "prover:p1");
      j.emit("tool_run.finished", { toolRunId, outcome: "ok", durationMs: ms }, "prover:p1");
    });
    j.emit("attempt.finished", { attemptId, durationMs: 10, turns: 2, usd: 0.01, inputTokens: 3500, outputTokens: 200, ...finish } as never, "prover:p1");
  };
  attempt("a1", "t1", [1000, 2000, 3000, 4000], { outcome: "invalid", stoppedBy: "turns", failureDetail: "unsolved goals", checks: 4, holes: [3, 2, 2, 1] });
  attempt("a2", "t1", [2000, 2000], { outcome: "invalid", stoppedBy: "context", failureDetail: "unsolved goals", checks: 2, holes: [1, 1] });
  attempt("a3", "t1", [5000], { outcome: "invalid", stoppedBy: "model", failureDetail: "unsolved goals", checks: 1, holes: [1] });
  attempt("a4", "t2", [1000], { outcome: "valid", stoppedBy: "solved", checks: 1, holes: [0] });
  if (options.verdicts === true) {
    // n1 and n4 have a Lean-checked negation; n5 is only a suspicion, which is not counted as false.
    for (const [nodeId, verdict, negationValidated] of [["n1", "statement_wrong", true], ["n2", "proof_too_hard", false], ["n3", "proof_too_hard", false], ["n4", "statement_wrong", true], ["n5", "statement_wrong", false]] as const) {
      j.emit("node.recorded", { nodeId, kind: "hole_verdict", data: { verdict, ...(negationValidated ? { negationValidated } : {}) } }, "line:M12");
    }
  }
  j.close();
  return dir;
}

describe("loop telemetry", () => {
  it("reads the checks, their seconds, the tokens, the context and the stop reasons of each attempt", () => {
    const loop = loopTelemetry(readEvents(join(journalOf(), "journal.jsonl")));
    const a1 = loop.attempts.find((a) => a.attemptId === "a1");
    assert.equal(a1?.checks, 4);
    assert.equal(a1?.problemId, "p1");
    assert.equal(a1?.medianSec, 3, "the median of 1, 2, 3, 4 s taken at index floor(q*n)");
    assert.equal(a1?.p95Sec, 4);
    assert.equal(a1?.outputTokensPerCheck, 50);
    assert.equal(a1?.endContextTokens, 2500);
    assert.equal(a1?.stoppedBy, "turns");
    assert.equal(a1?.split, undefined, "this journal's charges do not carry the dollar split");
    assert.equal(loop.totals.checks, 8);
    assert.deepEqual(loop.totals.stoppedBy, { context: 1, model: 1, solved: 1, turns: 1 });
    assert.equal(loop.totals.medianSec, 2000 / 1000, "the 8 checks: 1 1 2 2 2 3 4 5 s");
    assert.equal(loop.totals.p95Sec, 5);
    assert.equal(loop.totals.outputTokensPerCheck, 800 / 8);
  });

  it("gives the repeated failures and the open holes over time per problem", () => {
    const loop = loopTelemetry(readEvents(join(journalOf(), "journal.jsonl")));
    const p1 = loop.problems.find((p) => p.problemId === "p1");
    assert.deepEqual(p1?.repeatedFailures, { repeated: 2, failed: 3, rate: 2 / 3 });
    assert.deepEqual(p1?.openHoles, [3, 2, 2, 1, 1, 1, 1]);
    const p2 = loop.problems.find((p) => p.problemId === "p2");
    assert.equal(p2?.repeatedFailures, undefined);
    assert.deepEqual(p2?.openHoles, [0]);
  });

  it("splits the dollars by cache hit, cache miss and output when the charges carry it, and says so when they do not", () => {
    const withSplit = loopTelemetry(readEvents(join(journalOf({ split: true }), "journal.jsonl")));
    const a = withSplit.attempts[0];
    assert.deepEqual(a?.split && { hit: a.split.cacheHitUsd, out: a.split.outputUsd, miss: +a.split.cacheMissUsd.toFixed(6) }, { hit: 0.002, out: 0.008, miss: 0 });
    assert.match(renderLoop(withSplit).join("\n"), /cache hit 20%, cache miss 0%.*output 80%/);
    assert.match(renderLoop(loopTelemetry(readEvents(join(journalOf(), "journal.jsonl")))).join("\n"), /Dollars by cache hit, miss and output: not recorded/);
  });

  it("counts the proposed sub-lemmas found false from verdict nodes, and says not recorded without them", () => {
    const some = loopTelemetry(readEvents(join(journalOf({ verdicts: true }), "journal.jsonl")));
    assert.deepEqual(some.holes, { verdicts: 5, wrong: 2, share: 0.4, suspected: 1 });
    assert.match(renderLoop(some).join("\n"), /turned out false \(a Lean-checked negation\): 2 of 5 \(40%\)\. Suspected false, unverified: 1/);
    const none = loopTelemetry(readEvents(join(journalOf(), "journal.jsonl")));
    assert.equal(none.holes, undefined);
    assert.match(renderLoop(none).join("\n"), /turned out false: not recorded/);
  });

  it("appears as the Loop section of the run report, from the journal alone", () => {
    const events = readEvents(join(journalOf(), "journal.jsonl"));
    const text = renderRunReport(buildReport(events));
    assert.match(text, /## Loop/);
    assert.match(text, /8 Lean check\(s\)/);
    assert.match(text, /\| p1 \| 3 \| 2 of 3 \(67%\) \| 3 > 2 > 2 > 1 > 1 > 1 > 1 \|/);
  });
});
