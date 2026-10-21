import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, type TaskRow } from "@seshat/core";
import type { Line, LineHooks, TaskInfo, TaskProposalResult } from "@seshat/lines";
import { check, DemoLean, demoAnswer, demoRun, ofType, say } from "./m0-helpers.ts";

/** A line whose only act is `beforeProvers`. */
function asking(beforeProvers: NonNullable<LineHooks["beforeProvers"]>): Line {
  return { id: "M4", title: "asks", requires: [], hooks: { beforeProvers } };
}

/** The tasks of a finished run, as the journal's projection holds them. */
function tasksOf(dir: string, runId: string): TaskRow[] {
  const journal = Journal.open(dir, runId);
  try {
    return journal.projection.tasks();
  } finally {
    journal.close();
  }
}

describe("the task ledger in an M0 run", () => {
  it("records one prove task per prover: made, started with the prover, done by its proof", async () => {
    const { result, events } = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");

    const [registered] = ofType(events, "problem.registered");
    const created = ofType(events, "task.created");
    assert.equal(created.length, 1, "one prover, one task");
    const [task] = created;
    assert.equal(task?.data.kind, "prove");
    assert.equal(task?.data.problemId, registered?.data.problemId);
    assert.equal(task?.data.claimId, registered?.data.claimId);
    assert.equal(task?.data.owner, "prover:p1");
    assert.deepEqual(task?.data.acceptance, { type: "claim", claimId: registered?.data.claimId, minStatus: "computed" });
    assert.deepEqual(task?.data.budget, { usd: 5, sessions: 2 });
    assert.deepEqual(task?.data.dependsOn, []);

    const moves = ofType(events, "task.status_changed");
    assert.deepEqual(moves.map((m) => [m.data.taskId === task?.data.taskId, m.data.from, m.data.to]), [
      [true, "pending", "ready"],
      [true, "ready", "running"],
      [true, "running", "done"],
    ]);
    assert.ok(moves.every((m) => m.data.reason.length > 0), "every move says why");
    assert.match(moves[2]?.data.reason ?? "", /prover p1's proof passed the fast check/);

    // The orchestrator wrote every task event, and the attempt worked for the task, as a prover session.
    assert.ok([...created, ...moves].every((e) => e.actor === "orchestrator"));
    const [attempt] = ofType(events, "attempt.started");
    assert.equal(attempt?.data.taskId, task?.data.taskId);
    assert.equal(attempt?.data.site, "prover.session");

    // The task ends after the claim became a candidate, not before: it is the claim's status that makes it done.
    const at = (type: string) => events.findIndex((e) => e.type === type);
    const lastAt = (type: string) => events.findLastIndex((e) => e.type === type);
    assert.ok(at("claim.status_changed") < lastAt("task.status_changed"));
    assert.ok(lastAt("attempt.finished") < lastAt("task.status_changed"));
    assert.ok(lastAt("task.status_changed") < at("problem.finished"));
    // The ledger holds no claim status: the claim's changes are the validator's and the orchestrator's alone.
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("records a task for each of several provers, and cancels the ones another prover made pointless", async () => {
    // Checks take 30 ms, so the second prover's check is under way when the first one's succeeds.
    const { events, result, dir } = await demoRun({
      config: { provers: 2 },
      lean: new DemoLean(demoAnswer, 30),
      responses: [check("exact trivial_proof"), check("slow")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const created = ofType(events, "task.created");
    assert.deepEqual(created.map((t) => [t.data.kind, t.data.owner]), [["prove", "prover:p1"], ["prove", "prover:p2"]]);
    const rows = tasksOf(dir, result.runId);
    assert.deepEqual(rows.map((t) => t.status).sort(), ["cancelled", "done"]);
    const cancelled = rows.find((t) => t.status === "cancelled");
    assert.match(cancelled?.reason ?? "", /another prover's proof passed first/);
    // Each prover's attempts work for its own task.
    const started = ofType(events, "attempt.started");
    assert.deepEqual(
      started.map((a) => [a.data.prover, rows.find((t) => t.task_id === a.data.taskId)?.owner]),
      [["p1", "prover:p1"], ["p2", "prover:p2"]],
    );
  });

  it("fails a prover's task when its sessions run out without a proof", async () => {
    const { events, result, dir } = await demoRun({
      config: { sessions: 2 },
      responses: [check("bad"), say("NOTES: no."), check("bad"), say("NOTES: still no.")],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    const [task] = tasksOf(dir, result.runId);
    assert.equal(task?.status, "failed");
    assert.match(task?.reason ?? "", /prover p1 used its 2 sessions without a proof that passes/);
    assert.deepEqual(ofType(events, "task.status_changed").map((m) => m.data.to), ["ready", "running", "failed"]);
    assert.equal(tasksOf(dir, result.runId).length, 1);
  });

  it("fails the task when the problem's budget runs out", async () => {
    const { result, dir } = await demoRun({
      pricePerMillion: 100_000,
      config: { budget: { problemUsd: 1 } },
      responses: [check("bad"), check("bad"), check("bad")],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    const [task] = tasksOf(dir, result.runId);
    assert.equal(task?.status, "failed");
    assert.equal(task?.reason, "the problem's budget ran out");
  });

  it("cancels the task of a prover that the run stopped", async () => {
    const controller = new AbortController();
    const { result, dir } = await demoRun({
      config: { sessions: 1 },
      signal: controller.signal,
      responses: [
        () => {
          controller.abort();
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "aborted");
    const [task] = tasksOf(dir, result.runId);
    assert.equal(task?.status, "cancelled");
    assert.equal(task?.reason, "the run was stopped");
  });

  it("makes no task for a problem that is skipped, and none stays open when a problem ends", async () => {
    const skipped = await demoRun({
      lean: new DemoLean((code) =>
        code.includes("HARNESS:") ? demoAnswer(code) : { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "unknown package" }] },
      ),
      responses: [],
    });
    assert.equal(skipped.result.problems[0]?.outcome, "skipped");
    assert.equal(ofType(skipped.events, "task.created").length, 0);

    const solved = await demoRun({ responses: [check("exact trivial_proof")] });
    const open = tasksOf(solved.dir, solved.result.runId).filter((t) => !["done", "failed", "cancelled"].includes(t.status));
    assert.deepEqual(open, []);
  });

  it("cancels, when the problem ends, a task that no prover took up", async () => {
    const line = asking(async () => {
      throw new Error("the line broke");
    });
    const { result, dir, events } = await demoRun({ lines: { M4: line }, config: { lines: ["M4"] }, responses: [] });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.equal(ofType(events, "attempt.started").length, 0);
    const [task] = tasksOf(dir, result.runId);
    assert.equal(task?.status, "cancelled");
    assert.equal(task?.reason, "the problem ended: error");
    // `problem.finished` is the problem's last word: the tasks were closed before it.
    assert.ok(events.findLastIndex((e) => e.type === "task.status_changed") < events.findLastIndex((e) => e.type === "problem.finished"));
  });
});

describe("what a session leaves in the journal for a resumed run", () => {
  it("writes each model response's cost as it is charged, and what the next session starts from", async () => {
    const { result, events, dir } = await demoRun({
      config: { sessions: 2 },
      responses: [check("have h : 1 = 1 := rfl\nsorry"), say("NOTES: the hole needs trivial_proof."), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const finished = ofType(events, "attempt.finished");
    const charged = ofType(events, "attempt.charged");
    assert.equal(finished.length, 2);
    for (const attempt of finished) {
      const own = charged.filter((c) => c.data.attemptId === attempt.data.attemptId);
      assert.equal(own.length, attempt.data.turns, "one charge per model response");
      const sum = (key: "usd" | "inputTokens" | "outputTokens") => own.reduce((total, c) => total + c.data[key], 0);
      assert.ok(Math.abs(sum("usd") - attempt.data.usd) < 1e-12, "the charges add up to the attempt's cost");
      assert.equal(sum("inputTokens"), attempt.data.inputTokens);
      assert.equal(sum("outputTokens"), attempt.data.outputTokens);
    }
    // The charge comes before the end of the attempt it belongs to.
    const firstCharge = events.findIndex((e) => e.type === "attempt.charged");
    assert.ok(events.findIndex((e) => e.type === "attempt.started") < firstCharge);
    assert.ok(firstCharge < events.findIndex((e) => e.type === "attempt.finished"));

    // The carry: the regions the next session starts from, the last check as the prover read it, the notes.
    const blobs = new BlobStore(join(dir, "blobs"));
    const [first, second] = finished;
    const read = (hash: string | undefined) => blobs.get(hash ?? "");
    assert.deepEqual(JSON.parse(read(first?.data.carry?.regions) ?? "null"), { aux: "", proof: "have h : 1 = 1 := rfl\nsorry" });
    assert.match(read(first?.data.carry?.lastCheck) ?? "", /Checked the sketch: no error, 1 hole\(s\) left/);
    assert.equal(read(first?.data.carry?.notes), "NOTES: the hole needs trivial_proof.");
    assert.deepEqual(JSON.parse(read(second?.data.carry?.regions) ?? "null"), { aux: "", proof: "exact trivial_proof" });
    assert.equal(read(second?.data.carry?.notes), "NOTES: the hole needs trivial_proof.", "the notes go on to the next session");

    // The projection counts the same as the events, by problem and by task.
    const journal = Journal.open(dir, result.runId);
    try {
      const [task] = journal.projection.tasks();
      const problemId = result.problems[0]?.problemId ?? "";
      assert.ok(Math.abs(journal.projection.problemSpend(problemId).usd - (result.problems[0]?.usd ?? NaN)) < 1e-12);
      assert.ok(Math.abs(journal.projection.taskSpend(task?.task_id ?? "").usd - finished.reduce((s, a) => s + a.data.usd, 0)) < 1e-12);
      assert.equal(journal.projection.taskSpend(task?.task_id ?? "").requests, charged.length);
    } finally {
      journal.close();
    }
  });

  it("records the problem on the validations its workbench made", async () => {
    const { result, events } = await demoRun({
      certifier: { implementation: "fake-certifier", version: "0", certify: async () => ({ verdict: "certified", reasons: [], axioms: [], timeMs: 1 }) },
      responses: [check("bad"), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    const validations = ofType(events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.data.method, v.data.verdict]), [["repl", "invalid"], ["repl", "valid"], ["kernel_replay", "valid"]]);
    assert.ok(validations.every((v) => v.data.problemId === result.problems[0]?.problemId), "the problem owns its checks and its certification");
  });
});

describe("lines and the ledger", () => {
  it("lets a line read the ledger and propose tasks, which the orchestrator commits or refuses", async () => {
    const seen: { before?: TaskInfo[]; ready?: TaskInfo[]; results: TaskProposalResult[]; task?: TaskInfo | undefined; dependent?: TaskInfo | undefined; elsewhere?: TaskInfo | undefined } = {
      results: [],
    };
    const line = asking(async (problem) => {
      const { tasks, claimId } = problem;
      seen.before = tasks.list();
      seen.ready = tasks.ready();
      const prove = seen.before[0];
      const criterion = { type: "claim", claimId, minStatus: "computed" } as const;
      const plain = tasks.propose({ kind: "search", acceptance: criterion, budget: { usd: 1 }, title: "look for a known proof" });
      seen.results.push(plain);
      if (plain.accepted) seen.task = tasks.get(plain.taskId);
      // A task that waits for the prover's: it stays pending until the prover's task is done.
      const dependent = tasks.propose({ kind: "review", dependsOn: [prove?.taskId ?? ""], acceptance: criterion });
      seen.results.push(dependent);
      if (dependent.accepted) seen.dependent = tasks.get(dependent.taskId);
      // Refused, each with a reason: an unknown dependency, an unknown claim, a criterion of the wrong shape.
      seen.results.push(tasks.propose({ kind: "search", dependsOn: ["tsk_nobody"], acceptance: criterion }));
      seen.results.push(tasks.propose({ kind: "search", claimId: "clm_nobody", acceptance: { type: "claim", claimId: "clm_nobody", minStatus: "computed" } }));
      seen.results.push(tasks.propose({ kind: "search", acceptance: { type: "claim", claimId, minStatus: "open" } as never }));
      // A proposal does not name a status or an owner; if it tries, the orchestrator does not listen.
      seen.results.push(tasks.propose({ kind: "compute", acceptance: criterion, owner: "prover:p1", status: "running" } as never));
      seen.elsewhere = tasks.get("tsk_nobody");
    });
    const { result, events, dir } = await demoRun({ lines: { M4: line }, config: { lines: ["M4"] }, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");

    // What the line saw before the provers started: their tasks, ready, with their owners.
    assert.deepEqual(seen.before?.map((t) => [t.kind, t.status, t.owner]), [["prove", "ready", "prover:p1"]]);
    assert.deepEqual(seen.ready?.map((t) => t.taskId), seen.before?.map((t) => t.taskId));

    const [plain, dependent, unknownDependency, unknownClaim, wrongShape, bossy] = seen.results;
    assert.equal(plain?.accepted, true);
    assert.equal(seen.task?.status, "ready", "no dependencies: ready as soon as it is accepted");
    assert.equal(seen.task?.proposedBy, "line:M4");
    assert.equal(seen.task?.owner, "line:M4");
    assert.equal(dependent?.accepted, true);
    assert.equal(seen.dependent?.status, "pending", "its dependency is not done");
    assert.deepEqual(seen.dependent?.dependsOn, [seen.before?.[0]?.taskId]);
    assert.equal(unknownDependency?.accepted, false);
    assert.match(unknownDependency?.accepted === false ? unknownDependency.reason : "", /tsk_nobody is not a task of this problem/);
    assert.equal(unknownClaim?.accepted, false);
    assert.match(unknownClaim?.accepted === false ? unknownClaim.reason : "", /clm_nobody/);
    assert.equal(wrongShape?.accepted, false);
    assert.match(wrongShape?.accepted === false ? wrongShape.reason : "", /asks for one of computed, proved_informal, proved, refuted, not open/);
    assert.equal(bossy?.accepted, true);
    assert.equal(seen.elsewhere, undefined);

    // Only the accepted proposals are in the journal, all written by the orchestrator, none with a status or an owner of the line's choosing.
    const created = ofType(events, "task.created");
    assert.equal(created.length, 1 + 3, "the prover's task and three proposals");
    assert.ok(created.every((e) => e.actor === "orchestrator"));
    const proposed = created.filter((e) => e.data.proposedBy !== undefined);
    assert.deepEqual(proposed.map((e) => [e.data.kind, e.data.owner, e.data.proposedBy]), [
      ["search", "line:M4", "line:M4"],
      ["review", "line:M4", "line:M4"],
      ["compute", "line:M4", "line:M4"],
    ]);

    // The dependent task was released when the prover's task was done; nobody took any of them up, and the problem's end cancelled them.
    const rows = tasksOf(dir, result.runId);
    assert.deepEqual(rows.map((t) => [t.kind, t.status]), [["prove", "done"], ["search", "cancelled"], ["review", "cancelled"], ["compute", "cancelled"]]);
    const dependentRow = rows.find((t) => t.kind === "review");
    assert.equal(dependentRow?.reason, "the problem ended: candidate");
    const moves = ofType(events, "task.status_changed").filter((m) => m.data.taskId === dependentRow?.task_id);
    assert.deepEqual(moves.map((m) => [m.data.from, m.data.to]), [["pending", "ready"], ["ready", "cancelled"]], "ready once the prover's task was done");

    // The ledger is not the claim's status.
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("shows a line the tasks of its own problem only", async () => {
    const seen: string[][] = [];
    const line = asking(async (problem) => {
      seen.push(problem.tasks.list().map((t) => t.taskId));
      // A task of another problem is not there to read, nor to depend on.
      const other = seen.length === 1 ? undefined : seen[0]?.[0];
      if (other !== undefined) {
        assert.equal(problem.tasks.get(other), undefined);
        const refused = problem.tasks.propose({ kind: "review", dependsOn: [other], acceptance: { type: "claim", claimId: problem.claimId, minStatus: "computed" } });
        assert.equal(refused.accepted, false);
      }
    });
    const { events } = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"], sessions: 1 },
      problems: 2,
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
    });
    assert.equal(seen.length, 2);
    assert.equal(new Set(seen.flat()).size, 2, "each problem saw its own prover's task");
    assert.equal(ofType(events, "problem.finished").length, 2);
  });
});
