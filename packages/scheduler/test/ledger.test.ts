import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, readEvents } from "@seshat/core";
import { routingInfo, TaskLedger, taskInfo } from "../src/index.ts";

const source = { repo: "r", rev: "v", path: "X.lean" };

function setup(maxProposed?: number): { journal: Journal; ledger: TaskLedger } {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-ledger-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: "st0_1", statement: ": True", origin: "bench", status: "open" }, "orchestrator");
  journal.emit("problem.registered", { problemId: "prb_1", claimId: "clm_1", target: "t", source, domain: [] }, "orchestrator");
  return { journal, ledger: new TaskLedger(journal, maxProposed === undefined ? {} : { maxProposed }) };
}

const prove = { type: "claim", claimId: "clm_1", minStatus: "computed" } as const;

function makeCandidate(journal: Journal): void {
  journal.emit(
    "validation.finished",
    { validationId: "val_1", claimId: "clm_1", method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" },
    "validator",
  );
  journal.emit(
    "claim.status_changed",
    { claimId: "clm_1", from: "open", to: "computed", reason: "a proof passed the fast check", validationId: "val_1" },
    "orchestrator",
  );
}

describe("TaskLedger", () => {
  it("takes a task from pending to done, every move written by the orchestrator", () => {
    const { journal, ledger } = setup();
    const id = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove, budget: { usd: 2, sessions: 4 }, title: "prove with p1" });
    assert.match(id, /^tsk_/);
    assert.equal(ledger.get(id)?.status, "pending");
    ledger.markReady(id, "no dependencies");
    ledger.start(id, "the prover started");
    assert.equal(ledger.holds(id), false);
    assert.equal(ledger.completeIfHolds(id, "x"), false, "a criterion that does not hold completes nothing");
    assert.throws(() => ledger.complete(id, "x"), /its criterion does not hold/);
    makeCandidate(journal);
    assert.equal(ledger.holds(id), true);
    assert.equal(ledger.completeIfHolds(id, "the prover found a candidate"), true);
    const row = ledger.get(id);
    assert.equal(row?.status, "done");
    assert.equal(row?.reason, "the prover found a candidate");
    assert.deepEqual(row?.budget, { usd: 2, sessions: 4 });
    const task = readEvents(journal.log.path).filter((e) => e.type.startsWith("task."));
    assert.deepEqual(task.map((e) => e.type), ["task.created", "task.status_changed", "task.status_changed", "task.status_changed"]);
    assert.ok(task.every((e) => e.actor === "orchestrator"));
    journal.close();
  });

  it("lists the tasks that meet a filter, in the order they were made", () => {
    const { journal, ledger } = setup();
    const first = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    const second = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p2", acceptance: prove });
    ledger.markReady(second, "no dependencies");
    assert.deepEqual(ledger.list().map((task) => task.task_id), [first, second]);
    assert.deepEqual(ledger.list({ problemId: "prb_1", statuses: ["ready"] }).map((task) => task.task_id), [second]);
    assert.deepEqual(ledger.list({ problemId: "prb_other" }), []);
    journal.close();
  });

  it("promotes the tasks whose dependencies are done", () => {
    const { journal, ledger } = setup();
    const first = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    const second = ledger.create({ kind: "review", problemId: "prb_1", claimId: "clm_1", owner: "line:M12", acceptance: prove, dependsOn: [first] });
    const third = ledger.create({ kind: "review", problemId: "prb_1", claimId: "clm_1", owner: "line:M12", acceptance: prove, dependsOn: [second] });
    assert.deepEqual(ledger.promote(), [first]);
    ledger.start(first, "go");
    assert.deepEqual(ledger.promote(), [], "a running task releases nothing");
    makeCandidate(journal);
    ledger.complete(first, "done");
    assert.deepEqual(ledger.promote("prb_1"), [second]);
    assert.equal(ledger.get(third)?.status, "pending");
    assert.deepEqual(ledger.promote("prb_other"), []);
    journal.close();
  });

  it("blocks a task on another and releases it when that is done, and waits for an outside key", () => {
    const { journal, ledger } = setup();
    const a = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    const b = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p2", acceptance: prove });
    const c = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p3", acceptance: prove });
    ledger.promote();
    ledger.start(b, "go");
    ledger.start(c, "go");
    ledger.block(b, [a], "waits for a");
    ledger.block(c, ["ext:human"], "waits for a person");
    assert.deepEqual(ledger.promote(), [], "a is not done, and an outside key is never released by the ledger");
    ledger.start(a, "go");
    makeCandidate(journal);
    ledger.complete(a, "done");
    assert.deepEqual(ledger.promote(), [b]);
    assert.equal(ledger.get(c)?.status, "blocked");
    ledger.markReady(c, "the person answered");
    assert.equal(ledger.get(c)?.status, "ready");
    journal.close();
  });

  it("sends the running tasks back to ready after a resumption, and not before", () => {
    const { journal, ledger } = setup();
    const a = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    const b = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p2", acceptance: prove });
    ledger.promote();
    ledger.start(a, "go");
    assert.throws(() => ledger.interrupt("interrupted"), /only after the run was resumed/);
    journal.emit(
      "run.resumed",
      { runId: "run_1", resumption: 1, spent: { usd: 0, inputTokens: 0, outputTokens: 0 }, interrupted: { attempts: 0, toolRuns: 0, tasks: 1 } },
      "orchestrator",
    );
    assert.deepEqual(ledger.interrupt("interrupted: the run was resumed"), [a]);
    assert.equal(ledger.get(a)?.status, "ready");
    assert.equal(ledger.get(a)?.reason, "interrupted: the run was resumed");
    assert.equal(ledger.get(b)?.status, "ready");
    journal.close();
  });

  it("cancels what is left of a problem when it ends", () => {
    const { journal, ledger } = setup();
    const a = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    const b = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p2", acceptance: prove });
    const c = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p3", acceptance: prove });
    ledger.promote();
    ledger.start(a, "go");
    ledger.start(b, "go");
    ledger.fail(b, "sessions used up");
    assert.deepEqual(ledger.closeProblem("prb_1", "the problem ended"), [a, c]);
    assert.deepEqual(journal.projection.tasks().map((t) => [t.task_id, t.status, t.reason]), [
      [a, "cancelled", "the problem ended"],
      [b, "failed", "sessions used up"],
      [c, "cancelled", "the problem ended"],
    ]);
    assert.deepEqual(ledger.closeProblem("prb_1", "again"), [], "an ended task is not touched again");
    journal.close();
  });

  it("records a routing decision and shows it to a line", () => {
    const { journal, ledger } = setup();
    const a = ledger.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: prove });
    ledger.route({ taskId: a, action: "branch", signal: { type: "drift_kind", value: "strategy_loop" }, reason: "three attempts used one strategy" });
    const [row] = journal.projection.taskRoutes(a);
    assert.deepEqual(routingInfo(row!), {
      taskId: a,
      action: "branch",
      signal: { type: "drift_kind", value: "strategy_loop" },
      reason: "three attempts used one strategy",
    });
    assert.equal(ledger.get(a)?.status, "pending", "routing moves nothing");
    journal.close();
  });
});

describe("TaskLedger.propose", () => {
  const context = { problemId: "prb_1", claimId: "clm_1", line: "M12" };

  it("commits a line's proposal as a pending task of the problem, owned by the line", () => {
    const { journal, ledger } = setup();
    const result = ledger.propose(context, { kind: "repair", acceptance: prove, budget: { usd: 0.5 }, title: "repair the sketch" });
    assert.equal(result.accepted, true);
    const taskId = result.accepted ? result.taskId : "";
    const task = ledger.get(taskId);
    assert.equal(task?.status, "pending");
    assert.equal(task?.problem_id, "prb_1");
    assert.equal(task?.claim_id, "clm_1", "a proposal that names no claim is about the problem's");
    assert.equal(task?.owner, "line:M12");
    assert.equal(task?.proposed_by, "line:M12");
    const [event] = readEvents(journal.log.path).filter((e) => e.type === "task.created");
    assert.equal(event?.actor, "orchestrator", "the orchestrator writes it, the line only asked");
    assert.deepEqual(taskInfo(task!), {
      taskId, kind: "repair", status: "pending", owner: "line:M12", claimId: "clm_1", dependsOn: [], acceptance: prove, budget: { usd: 0.5 },
      proposedBy: "line:M12", title: "repair the sketch",
    });
    journal.close();
  });

  it("refuses with a reason and writes nothing", () => {
    const { journal, ledger } = setup();
    const before = journal.log.length;
    const refused = (proposal: Parameters<TaskLedger["propose"]>[1]) => {
      const result = ledger.propose(context, proposal);
      assert.equal(result.accepted, false);
      return result.accepted ? "" : result.reason;
    };
    assert.match(refused({ kind: "prove", claimId: "clm_9", acceptance: prove }), /unknown claim clm_9/);
    assert.match(refused({ kind: "prove", acceptance: { type: "claim", claimId: "clm_9", minStatus: "computed" } }), /names unknown claim/);
    assert.match(refused({ kind: "prove", acceptance: { type: "claim", claimId: "clm_1", minStatus: "open" as never } }), /asks for one of/);
    assert.match(refused({ kind: "ponder" as never, acceptance: prove }), /unknown kind/);
    assert.match(refused({ kind: "prove", acceptance: prove, dependsOn: ["tsk_9"] }), /tsk_9 is not a task of this problem/);
    assert.match(refused({ kind: "prove", acceptance: prove, budget: { usd: -1 } }), /non-negative/);
    assert.equal(journal.log.length, before);
    journal.close();
  });

  it("takes dependencies and a parent from the same problem only", () => {
    const { journal, ledger } = setup();
    journal.emit("claim.created", { claimId: "clm_2", statementId: "st0_2", statement: ": True", origin: "bench", status: "open" }, "orchestrator");
    journal.emit("problem.registered", { problemId: "prb_2", claimId: "clm_2", target: "u", source, domain: [] }, "orchestrator");
    const other = ledger.create({ kind: "prove", problemId: "prb_2", claimId: "clm_2", owner: "prover:p1", acceptance: { type: "claim", claimId: "clm_2", minStatus: "computed" } });
    const mine = ledger.propose(context, { kind: "prove", acceptance: prove });
    assert.equal(mine.accepted, true);
    const taskId = mine.accepted ? mine.taskId : "";
    assert.deepEqual(ledger.propose(context, { kind: "review", acceptance: prove, dependsOn: [other] }), { accepted: false, reason: `${other} is not a task of this problem` });
    assert.deepEqual(ledger.propose(context, { kind: "review", acceptance: prove, parentTaskId: other }), { accepted: false, reason: `${other} is not a task of this problem` });
    assert.equal(ledger.propose(context, { kind: "review", acceptance: prove, dependsOn: [taskId], parentTaskId: taskId }).accepted, true);
    journal.close();
  });

  it("stops a line that proposes without end", () => {
    const { journal, ledger } = setup(2);
    assert.equal(ledger.propose(context, { kind: "search", acceptance: prove }).accepted, true);
    assert.equal(ledger.propose(context, { kind: "search", acceptance: prove }).accepted, true);
    const third = ledger.propose(context, { kind: "search", acceptance: prove });
    assert.deepEqual(third, { accepted: false, reason: "the problem already has 2 proposed tasks, the most the orchestrator takes" });
    assert.equal(journal.projection.tasks().length, 2);
    journal.close();
  });
});
