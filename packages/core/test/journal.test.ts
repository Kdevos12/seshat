import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { EventLog, Journal, PROJECTION_VERSION, readEvents, verifyChain } from "../src/index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mh-core-"));
}

const source = { repo: "google-deepmind/formal-conjectures", rev: "e47a327", path: "FormalConjectures/X.lean" };

function seedClaim(journal: Journal, claimId = "clm_1"): void {
  journal.emit("claim.created", { claimId, statementId: "st0_x", statement: "theorem t : True", origin: "bench", status: "open" }, "orchestrator");
  journal.emit("problem.registered", { problemId: `prb_${claimId}`, claimId, target: "t", source, domain: ["11"] }, "orchestrator");
}

describe("EventLog", () => {
  it("chains events and reads them back", () => {
    const path = join(tempDir(), "journal.jsonl");
    const log = EventLog.open(path, { run: "run_1" });
    const first = log.append("run.started", { runId: "run_1", benchId: "b", problems: 0, host: "local", config: {} }, "orchestrator");
    const second = log.append("run.finished", { runId: "run_1", attempted: 0, solved: 0, candidates: 0, usd: 0 }, "orchestrator");
    log.close();
    assert.equal(first.prev, "");
    assert.equal(second.prev, first.hash);
    const events = readEvents(path);
    assert.deepEqual(events.map((e) => e.type), ["run.started", "run.finished"]);
    assert.deepEqual(verifyChain(events), { ok: true });
  });

  it("refuses to open a journal whose content was changed", () => {
    const path = join(tempDir(), "journal.jsonl");
    const log = EventLog.open(path, { run: "run_1" });
    log.append("run.finished", { runId: "run_1", attempted: 1, solved: 0, candidates: 0, usd: 0.5 }, "orchestrator");
    log.append("run.finished", { runId: "run_1", attempted: 2, solved: 0, candidates: 0, usd: 0.5 }, "orchestrator");
    log.close();
    writeFileSync(path, readFileSync(path, "utf8").replace('"solved":0', '"solved":1'));
    assert.throws(() => EventLog.open(path, { run: "run_1" }), /corrupt at seq 0: hash does not match content/);
    assert.ok(!existsSync(`${path}.lock`), "a failed open releases the lock");
  });

  it("drops a torn last line and keeps appending after it", () => {
    const path = join(tempDir(), "journal.jsonl");
    const log = EventLog.open(path, { run: "run_1" });
    log.append("run.finished", { runId: "run_1", attempted: 0, solved: 0, candidates: 0, usd: 0 }, "orchestrator");
    log.close();
    appendFileSync(path, '{"v":1,"seq":1,"id":"evt_');
    const reopened = EventLog.open(path, { run: "run_1" });
    assert.equal(reopened.length, 1);
    reopened.append("run.finished", { runId: "run_1", attempted: 1, solved: 0, candidates: 0, usd: 0 }, "orchestrator");
    reopened.close();
    const events = readEvents(path);
    assert.equal(events.length, 2);
    assert.deepEqual(verifyChain(events), { ok: true });
  });

  it("lets one writer at a time hold the journal", () => {
    const path = join(tempDir(), "journal.jsonl");
    const log = EventLog.open(path, { run: "run_1" });
    assert.throws(() => EventLog.open(path, { run: "run_1" }), /already open in this process/);
    log.close();
    writeFileSync(`${path}.lock`, String(process.ppid));
    assert.throws(() => EventLog.open(path, { run: "run_1" }), /locked by process/);
    writeFileSync(`${path}.lock`, "99999999");
    EventLog.open(path, { run: "run_1" }).close();
    assert.ok(!existsSync(`${path}.lock`));
  });
});

describe("Journal", () => {
  it("keeps the projection in step and summarizes a run", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedClaim(journal);
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p0", iteration: 0, model: "faux" }, "prover:p0");
    journal.emit(
      "attempt.finished",
      { attemptId: "att_1", outcome: "invalid", durationMs: 10, turns: 3, usd: 0.25, inputTokens: 100, outputTokens: 50 },
      "prover:p0",
    );
    journal.emit("lesson.recorded", { attemptId: "att_1", claimId: "clm_1", text: "omega cannot see through digits" }, "prover:p0");
    const p = journal.projection;
    assert.equal(p.attempt("att_1")?.outcome, "invalid");
    assert.deepEqual(p.lessons("clm_1").map((l) => l.text), ["omega cannot see through digits"]);
    assert.deepEqual(p.problems()[0]?.source, source);
    assert.deepEqual(p.runSummary(), { problems: 1, solved: 0, refuted: 0, candidates: 0, attempts: 1, usd: 0.25, inputTokens: 100, outputTokens: 50 });
    journal.close();
  });

  it("refuses events that break the invariants", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedClaim(journal);
    assert.throws(() => seedClaim(journal), /already exists/);
    assert.throws(
      () => journal.emit("claim.status_changed", { claimId: "clm_1", from: "computed", to: "open", reason: "x" }, "orchestrator"),
      /is open, not computed/,
    );
    assert.throws(
      () => journal.emit("claim.status_changed", { claimId: "clm_1", from: "open", to: "retracted", reason: "x" }, "orchestrator"),
      /illegal claim status transition open -> retracted/,
    );
    assert.throws(
      () => journal.emit("attempt.finished", { attemptId: "att_9", outcome: "error", durationMs: 0, turns: 0, usd: 0, inputTokens: 0, outputTokens: 0 }, "x"),
      /unknown attempt/,
    );
    assert.throws(() => journal.emit("tool_run.finished", { toolRunId: "tr_9", outcome: "ok", durationMs: 1 }, "x"), /unknown tool run/);
    assert.equal(journal.log.length, 2, "refused events are not written");
    journal.close();
  });

  it("registers a problem once and finishes it once", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedClaim(journal);
    journal.emit("claim.created", { claimId: "clm_2", statementId: "st0_y", statement: "s", origin: "bench", status: "open" }, "x");
    assert.throws(
      () => journal.emit("problem.registered", { problemId: "prb_clm_1", claimId: "clm_2", target: "t", source, domain: [] }, "x"),
      /problem prb_clm_1 is already registered/,
    );
    const finish = (problemId: string, claimId: string) =>
      journal.emit(
        "problem.finished",
        { problemId, claimId, outcome: "unsolved", reason: "budget", attempts: 2, usd: 1.5, durationMs: 10 },
        "orchestrator",
      );
    assert.throws(() => finish("prb_9", "clm_1"), /unknown problem prb_9/);
    assert.throws(() => finish("prb_clm_1", "clm_2"), /is about claim clm_1, not clm_2/);
    finish("prb_clm_1", "clm_1");
    assert.throws(() => finish("prb_clm_1", "clm_1"), /already finished/);
    const row = journal.projection.problem("prb_clm_1");
    assert.equal(row?.outcome, "unsolved");
    assert.equal(row?.reason, "budget");
    assert.equal(journal.projection.problem("prb_9"), undefined);
    journal.close();
  });

  it("creates a claim open, whatever status the event names", () => {
    const journal = Journal.open(tempDir(), "run_1");
    for (const status of ["computed", "proved", "refuted"] as const) {
      assert.throws(
        () => journal.emit("claim.created", { claimId: "clm_p", statementId: "st0_p", statement: ": P", origin: "test", status }, "test"),
        new RegExp(`claim clm_p is created open, not ${status}`),
      );
    }
    assert.equal(journal.projection.claim("clm_p"), undefined);
    journal.close();
  });

  it("makes a claim computed only through a valid validation of that claim", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedClaim(journal);
    seedClaim(journal, "clm_2");
    const validation = (validationId: string, claimId: string, options: { verdict?: "valid" | "invalid"; negation?: boolean } = {}) =>
      journal.emit(
        "validation.finished",
        {
          validationId,
          claimId,
          method: "repl",
          verdict: options.verdict ?? "valid",
          reasons: [],
          axioms: [],
          submissionHash: "h",
          ...(options.negation === true ? { negation: true } : {}),
        },
        "validator",
      );
    const candidate = (validationId?: string) =>
      journal.emit(
        "claim.status_changed",
        { claimId: "clm_1", from: "open", to: "computed", reason: "candidate", ...(validationId === undefined ? {} : { validationId }) },
        "line:M1",
      );
    validation("val_invalid", "clm_1", { verdict: "invalid" });
    validation("val_other", "clm_2");
    validation("val_negation", "clm_1", { negation: true });
    assert.throws(() => candidate(), /claim clm_1 can become computed only with a valid validation of the claim/);
    assert.throws(() => candidate("val_unknown"), /can become computed only with a valid validation/);
    assert.throws(() => candidate("val_invalid"), /can become computed only with a valid validation/);
    assert.throws(() => candidate("val_other"), /validation val_other validates claim clm_2, not clm_1/);
    assert.throws(() => candidate("val_negation"), /proves the negation of the claim, so claim clm_1 cannot become computed/);
    assert.equal(journal.projection.claim("clm_1")?.status, "open");
    validation("val_ok", "clm_1");
    candidate("val_ok");
    assert.equal(journal.projection.claim("clm_1")?.status, "computed");
    assert.equal(journal.projection.runSummary().candidates, 1);
    journal.close();
  });

  it("makes a claim proved only through a certified validation of that claim", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedClaim(journal);
    seedClaim(journal, "clm_2");
    const validation = (validationId: string, method: "repl" | "kernel_replay", claimId = "clm_1") =>
      journal.emit(
        "validation.finished",
        { validationId, claimId, method, verdict: "valid", reasons: [], axioms: ["propext"], submissionHash: "h" },
        "validator",
      );
    validation("val_repl", "repl");
    journal.emit("claim.status_changed", { claimId: "clm_1", from: "open", to: "computed", reason: "candidate", validationId: "val_repl" }, "orchestrator");
    assert.equal(journal.projection.runSummary().candidates, 1);
    const prove = (validationId?: string) =>
      journal.emit(
        "claim.status_changed",
        { claimId: "clm_1", from: "computed", to: "proved", reason: "certified", ...(validationId ? { validationId } : {}) },
        "orchestrator",
      );
    assert.throws(() => prove(), /only with a certified validation/);
    assert.throws(() => prove("val_repl"), /only with a certified validation/);
    validation("val_other", "kernel_replay", "clm_2");
    assert.throws(() => prove("val_other"), /certifies claim clm_2, not clm_1/);
    validation("val_kernel", "kernel_replay");
    prove("val_kernel");
    assert.equal(journal.projection.claim("clm_1")?.status, "proved");
    assert.equal(journal.projection.runSummary().solved, 1);
    journal.close();
  });

  it("catches a lagging projection up and rebuilds one that does not match", () => {
    const dir = tempDir();
    const first = Journal.open(dir, "run_1");
    seedClaim(first);
    first.close();

    // The journal grows while the projection is away: reopening catches up.
    const log = EventLog.open(join(dir, "journal.jsonl"), { run: "run_1" });
    log.append("claim.created", { claimId: "clm_2", statementId: "st0_y", statement: "s", origin: "bench", status: "open" }, "x");
    log.close();
    const second = Journal.open(dir, "run_1");
    assert.equal(second.projection.claim("clm_2")?.status, "open");
    assert.equal(second.projection.lastSeq(), 2);
    second.close();

    // A different journal under the same projection: rebuilt from scratch.
    writeFileSync(join(dir, "journal.jsonl"), "");
    const fresh = EventLog.open(join(dir, "journal.jsonl"), { run: "run_2" });
    fresh.append("claim.created", { claimId: "clm_9", statementId: "st0_z", statement: "s", origin: "bench", status: "open" }, "x");
    fresh.close();
    const third = Journal.open(dir, "run_2");
    assert.equal(third.projection.claim("clm_1"), undefined);
    assert.equal(third.projection.claim("clm_9")?.status, "open");
    third.close();
  });

  it("rebuilds a projection written by another version of the code", () => {
    const dir = tempDir();
    const first = Journal.open(dir, "run_1");
    seedClaim(first);
    first.close();
    const db = new DatabaseSync(join(dir, "projection.sqlite"));
    db.exec("pragma user_version = 1");
    db.exec("drop table problems");
    db.close();
    const second = Journal.open(dir, "run_1");
    assert.equal(second.projection.problems().length, 1);
    second.close();
    const check = new DatabaseSync(join(dir, "projection.sqlite"));
    assert.equal((check.prepare("pragma user_version").get() as { user_version: number }).user_version, PROJECTION_VERSION);
    check.close();
  });
});
