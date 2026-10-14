import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, type AttemptOutcome, Journal, newId, readEvents } from "@seshat/core";
import { describeTried, MemoryStore, redundancy, renderTried, triedStrategies, type Attempt } from "../src/index.ts";

function open(): { memory: MemoryStore; journal: Journal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-tried-"));
  const journal = Journal.open(dir, "run_1");
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }), journal, dir };
}

interface Tried {
  strategy?: string;
  outcome: AttemptOutcome;
  failureClass?: string;
  failureDetail?: string;
}

/** An attempt on a claim, started and finished. */
function attempt(journal: Journal, claimId: string, tried: Tried): string {
  const attemptId = newId("att");
  journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: 1, model: "test/model" }, "prover:p1");
  journal.emit(
    "attempt.finished",
    {
      attemptId, outcome: tried.outcome, usd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, turns: 1,
      ...(tried.failureClass !== undefined ? { failureClass: tried.failureClass } : {}),
      ...(tried.strategy !== undefined ? { strategy: tried.strategy } : {}),
      ...(tried.failureDetail !== undefined ? { failureDetail: tried.failureDetail } : {}),
    },
    "prover:p1",
  );
  return attemptId;
}

const STEP = { strategy: "induction", outcome: "invalid", failureClass: "unsolved_goals", failureDetail: "unsolved goals at case succ" } as const;

describe("alreadyTried", () => {
  it("groups the attempts by strategy, with counts, failure classes and the last detail", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    attempt(journal, claimId, { ...STEP, failureDetail: "unsolved goals at case zero" });
    attempt(journal, claimId, STEP);
    attempt(journal, claimId, STEP);
    attempt(journal, claimId, { strategy: "automation", outcome: "invalid", failureClass: "timeout", failureDetail: "heartbeat limit" });
    attempt(journal, claimId, { strategy: "automation", outcome: "invalid", failureClass: "tactic_failed", failureDetail: "omega failed" });
    attempt(journal, claimId, { strategy: "automation", outcome: "valid" });
    // A session that submitted nothing, and a session that was cut, say nothing about a strategy.
    attempt(journal, claimId, { outcome: "no_submission" });
    attempt(journal, claimId, { strategy: "cases", outcome: "aborted" });
    const tried = memory.alreadyTried(claimId);
    assert.deepEqual(tried.map(describeTried), [
      "automation: 3 attempts, 1 accepted, 1 tactic failed, 1 timeout; last: omega failed",
      "induction: 3 attempts, unsolved goals at case succ",
    ]);
    assert.deepEqual(tried[1]?.failures, [{ class: "unsolved_goals", count: 3 }]);
    assert.equal(tried[1]?.last?.class, "unsolved_goals");
    journal.close();
  });

  it("includes the attempts on equivalent claims, and nothing of the attempts' text", async () => {
    const { memory, journal } = open();
    const a = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const b = await memory.ensureClaim({ statement: "(m : ℕ) : 0 + m = m", origin: "test" });
    attempt(journal, a.claimId, STEP);
    attempt(journal, b.claimId, STEP);
    assert.deepEqual(memory.alreadyTried(a.claimId).map(describeTried), ["induction: 1 attempt, unsolved goals at case succ"]);
    // Lean checks the link lemma, then the claims are equivalent and share their attempts.
    const link = { name: "link", statement: ": (∀ n : ℕ, n + 0 = n) ↔ ∀ m : ℕ, 0 + m = m" };
    const lemma = await memory.ensureClaim({ statement: link.statement, origin: "test" });
    const validationId = newId("val");
    journal.emit("validation.finished", { validationId, claimId: lemma.claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" }, "validator");
    memory.addEdge({ kind: "equiv", from: a.claimId, to: b.claimId, status: "lean_checked", validationId, link });
    assert.deepEqual(memory.alreadyTried(a.claimId).map(describeTried), ["induction: 2 attempts, unsolved goals at case succ"]);
    assert.deepEqual(memory.alreadyTried(b.claimId).map(describeTried), ["induction: 2 attempts, unsolved goals at case succ"]);
    assert.deepEqual(memory.alreadyTried("clm_unknown"), []);
    journal.close();
  });
});

describe("renderTried", () => {
  const entries = triedStrategies(
    ["induction", "cases", "automation"].map(
      (strategy, k): Attempt => ({
        attemptId: `att_${k}`, claimId: "clm_1", prover: "p1", iteration: 1, model: "m", role: "prove", outcome: "invalid", strategy,
        failureClass: "unsolved_goals", startedSeq: 2 * k, finishedSeq: 2 * k + 1,
      }),
    ),
  );

  it("writes one line per strategy after a sentence that says what they are", () => {
    const lines = renderTried(entries, { maxLines: 10 });
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? "", /^Typed summaries of the attempts on this statement or an equivalent one/);
    assert.deepEqual(lines.slice(1), ["automation: 1 attempt, unsolved goals", "cases: 1 attempt, unsolved goals", "induction: 1 attempt, unsolved goals"]);
  });

  it("cuts at the most lines it is given, and says how many strategies it left out", () => {
    assert.deepEqual(renderTried(entries, { maxLines: 3 }).slice(1), ["automation: 1 attempt, unsolved goals", "... and 2 more strategies"]);
    assert.equal(renderTried(entries, { maxLines: 3 }).length, 3);
    assert.equal(renderTried(entries, { maxLines: 4 }).length, 4);
    assert.deepEqual(renderTried(entries, { maxLines: 1 }), []);
    assert.deepEqual(renderTried([], { maxLines: 10 }), []);
  });
});

describe("redundancy", () => {
  it("counts the attempts that repeat a strategy and a failure already seen on the claim or an equivalent", async () => {
    const { memory, journal, dir } = open();
    const a = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const b = await memory.ensureClaim({ statement: "(m : ℕ) : 0 + m = m", origin: "test" });
    attempt(journal, a.claimId, STEP);
    attempt(journal, a.claimId, STEP); // redundant: the same strategy, the same way
    attempt(journal, a.claimId, { ...STEP, failureDetail: "unsolved goals at case zero" }); // another way
    attempt(journal, b.claimId, STEP); // not an equivalent yet
    attempt(journal, a.claimId, { outcome: "no_submission" }); // not counted
    const link = { name: "link", statement: ": (∀ n : ℕ, n + 0 = n) ↔ ∀ m : ℕ, 0 + m = m" };
    const lemma = await memory.ensureClaim({ statement: link.statement, origin: "test" });
    const validationId = newId("val");
    journal.emit("validation.finished", { validationId, claimId: lemma.claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" }, "validator");
    const edge = memory.addEdge({ kind: "equiv", from: a.claimId, to: b.claimId, link });
    memory.setEdgeStatus(edge.edgeId, "lean_checked", { reason: "link lemma checked", validationId });
    attempt(journal, b.claimId, STEP); // redundant now that the claims are equivalent
    attempt(journal, b.claimId, { strategy: "induction", outcome: "valid" }); // counted, never redundant
    journal.close();
    assert.deepEqual(redundancy(readEvents(join(dir, "journal.jsonl"))), { attempts: 6, redundant: 2, share: 2 / 6 });
  });

  it("is undefined when no attempt has a strategy", async () => {
    const { memory, journal, dir } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    attempt(journal, claimId, { outcome: "invalid", failureClass: "holes" });
    journal.close();
    assert.equal(redundancy(readEvents(join(dir, "journal.jsonl"))), undefined);
  });
});
