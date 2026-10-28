import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acceptanceHolds,
  acceptanceProblems,
  CLAIM_STATUSES,
  canTaskTransition,
  EventLog,
  isFinalTaskStatus,
  Journal,
  readEvents,
  sha256Hex,
  SITE,
  TASK_STATUSES,
  type TaskAcceptance,
  verifyChain,
} from "../src/index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mh-tasks-"));
}

const source = { repo: "google-deepmind/formal-conjectures", rev: "e47a327", path: "FormalConjectures/X.lean" };

function seedProblem(journal: Journal, claimId = "clm_1"): void {
  journal.emit("claim.created", { claimId, statementId: `st0_${claimId}`, statement: "theorem t : True", origin: "bench", status: "open" }, "orchestrator");
  journal.emit("problem.registered", { problemId: `prb_${claimId}`, claimId, target: "t", source, domain: ["11"] }, "orchestrator");
}

function makeTask(journal: Journal, taskId: string, extra: Record<string, unknown> = {}): void {
  journal.emit(
    "task.created",
    {
      taskId,
      kind: "prove",
      problemId: "prb_clm_1",
      claimId: "clm_1",
      dependsOn: [],
      owner: "prover:p1",
      acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" },
      budget: { usd: 1 },
      ...extra,
    } as never,
    "orchestrator",
  );
}

function move(journal: Journal, taskId: string, from: string, to: string, extra: Record<string, unknown> = {}): void {
  journal.emit("task.status_changed", { taskId, from, to, reason: "test", ...extra } as never, "orchestrator");
}

/** The claim becomes a candidate the way a prover's valid check makes it. */
function makeCandidate(journal: Journal, claimId = "clm_1", validationId = "val_1"): void {
  journal.emit(
    "validation.finished",
    { validationId, claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" },
    "validator",
  );
  journal.emit(
    "claim.status_changed",
    { claimId, from: "open", to: "computed", reason: "a proof passed the fast check", validationId },
    "orchestrator",
  );
}

describe("the task vocabulary", () => {
  it("shares no word with the claim statuses, so a task never looks like a claim", () => {
    const shared = TASK_STATUSES.filter((status) => (CLAIM_STATUSES as readonly string[]).includes(status));
    assert.deepEqual(shared, []);
  });

  it("moves tasks along the deterministic transitions", () => {
    assert.ok(canTaskTransition("pending", "ready"));
    assert.ok(canTaskTransition("ready", "running"));
    assert.ok(canTaskTransition("running", "done"));
    assert.ok(canTaskTransition("running", "blocked"));
    assert.ok(canTaskTransition("blocked", "ready"));
    assert.ok(!canTaskTransition("pending", "running"), "a task is ready before it runs");
    assert.ok(!canTaskTransition("pending", "done"));
    assert.ok(!canTaskTransition("ready", "done"));
    for (const final of ["done", "failed", "cancelled"] as const) {
      assert.ok(isFinalTaskStatus(final));
      for (const to of TASK_STATUSES) assert.ok(!canTaskTransition(final, to), `${final} -> ${to}`);
    }
  });

  it("reads a claim criterion as at least, with a proof also a candidate", () => {
    const view = (status: (typeof CLAIM_STATUSES)[number]) => ({ claimStatus: () => status, edgeStatus: () => undefined });
    const computed: TaskAcceptance = { type: "claim", claimId: "c", minStatus: "computed" };
    assert.equal(acceptanceHolds(computed, view("open")), false);
    assert.equal(acceptanceHolds(computed, view("computed")), true);
    assert.equal(acceptanceHolds(computed, view("proved")), true);
    assert.equal(acceptanceHolds(computed, view("refuted")), false, "a refuted claim has no candidate proof");
    const proved: TaskAcceptance = { type: "claim", claimId: "c", minStatus: "proved" };
    assert.equal(acceptanceHolds(proved, view("computed")), false);
    assert.equal(acceptanceHolds(proved, view("proved")), true);
    const refuted: TaskAcceptance = { type: "claim", claimId: "c", minStatus: "refuted" };
    assert.equal(acceptanceHolds(refuted, view("refuted")), true);
    assert.equal(acceptanceHolds(refuted, view("proved")), false);
    assert.equal(acceptanceHolds(computed, { claimStatus: () => undefined, edgeStatus: () => undefined }), false, "a missing claim meets nothing");
  });

  it("reads an edge criterion in the order of the edge statuses", () => {
    const criterion: TaskAcceptance = { type: "edge", edgeId: "e", minStatus: "human_signed" };
    const view = (status: "proposed" | "computed" | "informal_checked" | "human_signed" | "lean_checked") => ({
      claimStatus: () => undefined,
      edgeStatus: () => status,
    });
    assert.equal(acceptanceHolds(criterion, view("informal_checked")), false);
    assert.equal(acceptanceHolds(criterion, view("human_signed")), true);
    assert.equal(acceptanceHolds(criterion, view("lean_checked")), true);
  });

  it("describes what is wrong with a criterion", () => {
    assert.deepEqual(acceptanceProblems({ type: "claim", claimId: "c", minStatus: "computed" }), []);
    assert.match(acceptanceProblems({ type: "claim", claimId: "c", minStatus: "open" }).join(), /asks for one of/);
    assert.match(acceptanceProblems({ type: "edge", edgeId: "e", minStatus: "done" }).join(), /edge status/);
    assert.match(acceptanceProblems({ type: "node" }).join(), /claim or edge/);
    assert.match(acceptanceProblems(undefined).join(), /must be an object/);
  });

  it("names a site with dot-separated lowercase words", () => {
    for (const ok of ["prover.session", "graph.attempt", "conjecture.relevance", "m1.unlabeled", "x"]) assert.match(ok, SITE);
    for (const bad of ["", "Prover.session", "graph.", ".graph", "graph attempt", "graph-attempt", "1x"]) assert.doesNotMatch(bad, SITE);
  });
});

describe("the task ledger in the journal", () => {
  it("moves a task from pending to done when its criterion holds, and changes no claim", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    assert.equal(journal.projection.task("tsk_1")?.status, "pending");
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    assert.equal(journal.projection.task("tsk_1")?.running_seq, journal.log.length - 1);
    assert.throws(() => move(journal, "tsk_1", "running", "done"), /cannot be done: its criterion does not hold \(claim clm_1 is at least computed\)/);
    assert.equal(journal.projection.task("tsk_1")?.status, "running", "the refused event changed nothing");
    makeCandidate(journal);
    move(journal, "tsk_1", "running", "done");
    const task = journal.projection.task("tsk_1");
    assert.equal(task?.status, "done");
    assert.equal(task?.reason, "test");
    assert.equal(journal.projection.claim("clm_1")?.status, "computed", "the claim is as the validation left it");
    journal.close();
  });

  it("does not let a done task raise a claim: the claim moves only through its validation", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1", { acceptance: { type: "claim", claimId: "clm_1", minStatus: "proved" } });
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    makeCandidate(journal);
    assert.throws(() => move(journal, "tsk_1", "running", "done"), /does not hold/, "a candidate is not a proof");
    assert.equal(journal.projection.claim("clm_1")?.status, "computed");
    // The task events carry no claim status at all.
    for (const event of readEvents(journal.log.path).filter((e) => e.type.startsWith("task."))) {
      assert.ok(!JSON.stringify(event.data).includes("claim.status"), event.type);
    }
    journal.close();
  });

  it("checks an edge criterion", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    seedProblem(journal, "clm_2");
    journal.emit("edge.added", { edgeId: "edg_1", kind: "implies", from: "clm_1", to: ["clm_2"], status: "proposed" }, "orchestrator");
    makeTask(journal, "tsk_1", { kind: "repair", claimId: undefined, acceptance: { type: "edge", edgeId: "edg_1", minStatus: "computed" } });
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    assert.throws(() => move(journal, "tsk_1", "running", "done"), /edge edg_1 is at least computed/);
    journal.emit("edge.status_changed", { edgeId: "edg_1", from: "proposed", to: "computed", reason: "a model found it" }, "orchestrator");
    move(journal, "tsk_1", "running", "done");
    assert.equal(journal.projection.task("tsk_1")?.status, "done");
    journal.close();
  });

  it("accepts task events from the orchestrator only", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    const created = {
      taskId: "tsk_1", kind: "prove", claimId: "clm_1", dependsOn: [], acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" }, budget: {},
    } as never;
    for (const actor of ["line:M12", "prover:p1", "validator", "Orchestrator", ""]) {
      assert.throws(() => journal.emit("task.created", created, actor), /written by the orchestrator only/, actor);
    }
    journal.emit("task.created", created, "orchestrator");
    for (const actor of ["line:M12", "prover:p1"]) {
      assert.throws(() => journal.emit("task.assigned", { taskId: "tsk_1", owner: "prover:p2", reason: "x" }, actor), /orchestrator only/);
      assert.throws(
        () => journal.emit("task.status_changed", { taskId: "tsk_1", from: "pending", to: "cancelled", reason: "x" }, actor),
        /orchestrator only/,
      );
      assert.throws(
        () => journal.emit("task.routed", { taskId: "tsk_1", action: "retry_fresh", signal: { type: "failure_class", value: "syntax" }, reason: "x" }, actor),
        /orchestrator only/,
      );
      assert.throws(
        () => journal.emit("run.resumed", { runId: "run_1", resumption: 1, spent: { usd: 0, inputTokens: 0, outputTokens: 0 }, interrupted: { attempts: 0, toolRuns: 0, tasks: 0 } }, actor),
        /orchestrator only/,
      );
    }
    assert.equal(journal.projection.task("tsk_1")?.status, "pending");
    journal.close();
  });

  it("refuses a malformed task", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    assert.throws(() => makeTask(journal, "tsk_1"), /already exists/);
    assert.throws(() => makeTask(journal, "tsk_2", { kind: "ponder" }), /unknown kind ponder/);
    assert.throws(() => makeTask(journal, "tsk_2", { problemId: "prb_9" }), /unknown problem/);
    assert.throws(() => makeTask(journal, "tsk_2", { claimId: "clm_9" }), /unknown claim clm_9/);
    assert.throws(() => makeTask(journal, "tsk_2", { edgeId: "edg_9" }), /unknown edge/);
    assert.throws(() => makeTask(journal, "tsk_2", { dependsOn: ["tsk_9"] }), /unknown task tsk_9/);
    assert.throws(() => makeTask(journal, "tsk_2", { dependsOn: ["tsk_1", "tsk_1"] }), /depends on a task twice/);
    assert.throws(() => makeTask(journal, "tsk_2", { dependsOn: ["tsk_2"] }), /unknown task tsk_2/, "a task cannot depend on itself");
    assert.throws(() => makeTask(journal, "tsk_2", { parentTaskId: "tsk_9" }), /unknown parent task/);
    assert.throws(() => makeTask(journal, "tsk_2", { acceptance: { type: "claim", claimId: "clm_9", minStatus: "computed" } }), /names unknown claim clm_9/);
    assert.throws(() => makeTask(journal, "tsk_2", { acceptance: { type: "claim", claimId: "clm_1", minStatus: "open" } }), /asks for one of/);
    assert.throws(() => makeTask(journal, "tsk_2", { budget: { usd: -1 } }), /non-negative/);
    assert.throws(() => makeTask(journal, "tsk_2", { budget: { dollars: 1 } }), /no limit named dollars/);
    assert.throws(() => makeTask(journal, "tsk_2", { owner: "" }), /owner must name/);
    assert.throws(() => makeTask(journal, "tsk_2", { proposedBy: "" }), /proposedBy/);
    assert.equal(journal.projection.tasks().length, 1);
    journal.close();
  });

  it("makes a task ready only when its dependencies are done, and runs it only with an owner", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    makeTask(journal, "tsk_2", { dependsOn: ["tsk_1"], owner: undefined });
    assert.throws(() => move(journal, "tsk_2", "pending", "ready"), /cannot be ready: tsk_1 not done/);
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    makeCandidate(journal);
    move(journal, "tsk_1", "running", "done");
    move(journal, "tsk_2", "pending", "ready");
    assert.throws(() => move(journal, "tsk_2", "ready", "running"), /has no owner, so it cannot run/);
    journal.emit("task.assigned", { taskId: "tsk_2", owner: "line:M12", reason: "proposed by the line" }, "orchestrator");
    assert.equal(journal.projection.task("tsk_2")?.owner, "line:M12");
    move(journal, "tsk_2", "ready", "running");
    assert.throws(
      () => journal.emit("task.assigned", { taskId: "tsk_2", owner: "prover:p1", reason: "x" }, "orchestrator"),
      /only a task that has not started can change owner/,
    );
    assert.throws(() => move(journal, "tsk_1", "done", "ready"), /illegal task status transition done -> ready/);
    assert.throws(() => move(journal, "tsk_2", "pending", "ready"), /is running, not pending/);
    journal.close();
  });

  it("names what blocks a blocked task, and frees it when that is done", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    makeTask(journal, "tsk_2");
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_2", "pending", "ready");
    move(journal, "tsk_2", "ready", "running");
    assert.throws(() => move(journal, "tsk_2", "running", "blocked"), /blocked by nothing/);
    assert.throws(() => move(journal, "tsk_2", "running", "blocked", { blockedBy: [] }), /blocked by nothing/);
    assert.throws(() => move(journal, "tsk_2", "running", "blocked", { blockedBy: ["tsk_2"] }), /cannot be blocked by itself/);
    assert.throws(() => move(journal, "tsk_2", "running", "blocked", { blockedBy: ["tsk_9"] }), /unknown task tsk_9/);
    assert.throws(() => move(journal, "tsk_2", "running", "blocked", { blockedBy: ["tsk_1", "tsk_1"] }), /same thing twice/);
    assert.throws(() => move(journal, "tsk_2", "running", "blocked", { blockedBy: ["a person"] }), /unknown task a person/);
    assert.throws(() => move(journal, "tsk_2", "running", "done", { blockedBy: ["tsk_1"] }), /only a blocked task has blockedBy/);
    move(journal, "tsk_2", "running", "blocked", { blockedBy: ["tsk_1", "ext:human"] });
    assert.deepEqual(journal.projection.task("tsk_2")?.blocked_by, ["tsk_1", "ext:human"]);
    // tsk_1 is not done: tsk_2 stays blocked.
    assert.throws(() => move(journal, "tsk_2", "blocked", "ready"), /still blocked by tsk_1/);
    move(journal, "tsk_1", "ready", "running");
    makeCandidate(journal);
    move(journal, "tsk_1", "running", "done");
    assert.throws(() => journal.emit("task.status_changed", { taskId: "tsk_2", from: "blocked", to: "blocked", reason: "x", blockedBy: ["tsk_1"] }, "orchestrator"), /illegal/);
    move(journal, "tsk_2", "blocked", "ready");
    assert.equal(journal.projection.task("tsk_2")?.blocked_by, null, "a task that is no longer blocked waits for nothing");
    // A task cannot be blocked by one that is done.
    assert.throws(() => move(journal, "tsk_2", "ready", "blocked", { blockedBy: ["tsk_1"] }), /which is done/);
    journal.close();
  });

  it("returns a running task to ready only after the run was resumed", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    assert.throws(() => move(journal, "tsk_1", "running", "ready"), /only after the run was resumed/);
    const resumed = (resumption: number) =>
      journal.emit(
        "run.resumed",
        { runId: "run_1", resumption, spent: { usd: 0, inputTokens: 0, outputTokens: 0 }, interrupted: { attempts: 0, toolRuns: 0, tasks: 1 } },
        "orchestrator",
      );
    assert.throws(() => resumed(2), /this is resumption 1 of the run, not 2/);
    resumed(1);
    assert.equal(journal.projection.lastResumedSeq(), journal.log.length - 1);
    move(journal, "tsk_1", "running", "ready", { reason: "interrupted: the run was resumed" });
    move(journal, "tsk_1", "ready", "running");
    // The new start is after the resumption: it needs another one to go back.
    assert.throws(() => move(journal, "tsk_1", "running", "ready"), /only after the run was resumed/);
    assert.throws(() => resumed(1), /this is resumption 2 of the run, not 1/);
    resumed(2);
    move(journal, "tsk_1", "running", "ready");
    assert.deepEqual(journal.projection.resumptions().map((r) => r.resumption), [1, 2]);
    journal.close();
  });

  it("records routing decisions, which change no status", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    const route = (data: Record<string, unknown>) => journal.emit("task.routed", { taskId: "tsk_1", reason: "r", ...data } as never, "orchestrator");
    route({ action: "retry_fresh", signal: { type: "failure_class", value: "syntax" } });
    route({ action: "branch", signal: { type: "drift_kind", value: "strategy_loop" }, reason: "the same strategy three times" });
    assert.throws(() => route({ action: "retry", signal: { type: "failure_class", value: "syntax" } }), /unknown routing action/);
    assert.throws(() => route({ action: "branch", signal: { type: "mood", value: "x" } }), /unknown routing signal/);
    assert.throws(() => route({ action: "branch", signal: { type: "drift_kind", value: "" } }), /needs a value/);
    assert.throws(() => route({ action: "branch", signal: { type: "drift_kind", value: "x" }, reason: "" }), /needs a reason/);
    assert.throws(() => route({ action: "branch", signal: { type: "drift_kind", value: "x" }, attemptId: "att_9" }), /unknown attempt/);
    assert.throws(() => route({ taskId: "tsk_9", action: "branch", signal: { type: "drift_kind", value: "x" } }), /unknown task/);
    const routes = journal.projection.taskRoutes("tsk_1");
    assert.deepEqual(routes.map((r) => [r.action, r.signal_type, r.signal_value]), [
      ["retry_fresh", "failure_class", "syntax"],
      ["branch", "drift_kind", "strategy_loop"],
    ]);
    assert.equal(journal.projection.task("tsk_1")?.status, "pending");
    assert.equal(journal.projection.claim("clm_1")?.status, "open");
    journal.close();
  });

  it("filters tasks", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    seedProblem(journal, "clm_2");
    makeTask(journal, "tsk_1");
    makeTask(journal, "tsk_2", { kind: "refute", owner: "prover:p2", acceptance: { type: "claim", claimId: "clm_1", minStatus: "refuted" } });
    makeTask(journal, "tsk_3", { problemId: "prb_clm_2", claimId: "clm_2", acceptance: { type: "claim", claimId: "clm_2", minStatus: "computed" } });
    move(journal, "tsk_1", "pending", "ready");
    const p = journal.projection;
    assert.deepEqual(p.tasks().map((t) => t.task_id), ["tsk_1", "tsk_2", "tsk_3"]);
    assert.deepEqual(p.tasks({ problemId: "prb_clm_1" }).map((t) => t.task_id), ["tsk_1", "tsk_2"]);
    assert.deepEqual(p.tasks({ statuses: ["pending"] }).map((t) => t.task_id), ["tsk_2", "tsk_3"]);
    assert.deepEqual(p.tasks({ kinds: ["refute"] }).map((t) => t.task_id), ["tsk_2"]);
    assert.deepEqual(p.tasks({ owner: "prover:p2" }).map((t) => t.task_id), ["tsk_2"]);
    assert.deepEqual(p.tasks({ claimId: "clm_2", statuses: [] }).map((t) => t.task_id), [], "an empty list of statuses matches none");
    journal.close();
  });

  it("rebuilds the ledger from the journal", () => {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    makeTask(journal, "tsk_2", { dependsOn: ["tsk_1"], owner: undefined, parentTaskId: "tsk_1", proposedBy: "line:M12", title: "second" });
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    journal.emit("task.routed", { taskId: "tsk_1", action: "retry_fresh", signal: { type: "failure_class", value: "timeout" }, reason: "r" }, "orchestrator");
    const before = { tasks: journal.projection.tasks(), routes: journal.projection.taskRoutes() };
    journal.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `projection.sqlite${suffix}`), { force: true });
    const again = Journal.open(dir, "run_1");
    assert.deepEqual({ tasks: again.projection.tasks(), routes: again.projection.taskRoutes() }, before);
    assert.equal(again.projection.task("tsk_2")?.proposed_by, "line:M12");
    assert.equal(again.projection.task("tsk_2")?.title, "second");
    again.close();
  });
});

describe("attempts, charges and sites", () => {
  it("lets an attempt work only for a running task of its claim", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    seedProblem(journal, "clm_2");
    makeTask(journal, "tsk_1");
    const start = (extra: Record<string, unknown>) =>
      journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "faux", ...extra } as never, "prover:p1");
    assert.throws(() => start({ taskId: "tsk_9" }), /unknown task/);
    assert.throws(() => start({ taskId: "tsk_1" }), /is pending, not running/);
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    assert.throws(() => start({ taskId: "tsk_1", claimId: "clm_2" }), /about claim clm_2, but task tsk_1 is about claim clm_1/);
    assert.throws(() => start({ taskId: "tsk_1", site: "Prover Session" }), /bad site/);
    start({ taskId: "tsk_1", site: "prover.session" });
    assert.equal(journal.projection.attempt("att_1")?.task_id, "tsk_1");
    assert.deepEqual(journal.projection.attemptsOfTask("tsk_1").map((a) => a.attempt_id), ["att_1"]);
    journal.close();
  });

  it("counts the responses of a session that never finished", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    makeTask(journal, "tsk_1");
    move(journal, "tsk_1", "pending", "ready");
    move(journal, "tsk_1", "ready", "running");
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "faux", taskId: "tsk_1" }, "prover:p1");
    journal.emit("attempt.charged", { attemptId: "att_1", usd: 0.25, inputTokens: 100, outputTokens: 10 }, "prover:p1");
    journal.emit("attempt.charged", { attemptId: "att_1", usd: 0.5, inputTokens: 200, outputTokens: 20 }, "prover:p1");
    const p = journal.projection;
    assert.deepEqual(p.openAttempts().map((a) => a.attempt_id), ["att_1"]);
    assert.deepEqual(p.taskSpend("tsk_1"), { usd: 0.75, inputTokens: 300, outputTokens: 30, requests: 2 });
    assert.deepEqual(p.problemSpend("prb_clm_1"), { usd: 0.75, inputTokens: 300, outputTokens: 30, requests: 2 });
    assert.equal(p.runSummary().usd, 0.75, "the run's spend counts the unfinished session");
    assert.throws(() => journal.emit("attempt.charged", { attemptId: "att_9", usd: 1, inputTokens: 0, outputTokens: 0 }, "x"), /unknown attempt/);
    assert.throws(() => journal.emit("attempt.charged", { attemptId: "att_1", usd: -1, inputTokens: 0, outputTokens: 0 }, "x"), /non-negative/);
    // The attempt's own totals replace the running sum once it is finished, and cannot be charged again.
    journal.emit(
      "attempt.finished",
      { attemptId: "att_1", outcome: "aborted", durationMs: 1, turns: 2, usd: 0.75, inputTokens: 300, outputTokens: 30 },
      "orchestrator",
    );
    assert.deepEqual(p.openAttempts(), []);
    assert.deepEqual(p.problemSpend("prb_clm_1"), { usd: 0.75, inputTokens: 300, outputTokens: 30, requests: 2 });
    assert.throws(() => journal.emit("attempt.charged", { attemptId: "att_1", usd: 1, inputTokens: 0, outputTokens: 0 }, "x"), /already finished/);
    journal.close();
  });

  it("keeps what a prover carries to its next session", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "faux" }, "prover:p1");
    assert.equal(journal.projection.attempt("att_1")?.carry, null);
    journal.emit(
      "attempt.finished",
      {
        attemptId: "att_1", outcome: "invalid", durationMs: 1, turns: 1, usd: 0.1, inputTokens: 1, outputTokens: 1,
        carry: { regions: "b1", lastCheck: "b2" },
      },
      "prover:p1",
    );
    assert.deepEqual(journal.projection.attempt("att_1")?.carry, { regions: "b1", lastCheck: "b2" });
    journal.close();
  });

  it("splits the spend by site, the provers' sessions under their own", () => {
    const journal = Journal.open(tempDir(), "run_1");
    seedProblem(journal);
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "faux" }, "prover:p1");
    journal.emit(
      "attempt.finished",
      { attemptId: "att_1", outcome: "invalid", durationMs: 1, turns: 4, usd: 0.75, inputTokens: 100, outputTokens: 10 },
      "prover:p1",
    );
    const call = (modelCallId: string, usd: number, site?: string) =>
      journal.emit(
        "model_call.finished",
        {
          modelCallId, line: "M2", problemId: "prb_clm_1", model: "faux", outcome: "ok", requestHash: "r", durationMs: 1,
          usd, inputTokens: 10, outputTokens: 1, ...(site !== undefined ? { site } : {}),
        },
        "line:M2",
      );
    call("mc_1", 0.25, "graph.attempt");
    call("mc_2", 0.25, "graph.attempt");
    call("mc_3", 0.125);
    assert.throws(() => call("mc_4", 1, "Graph Attempt"), /bad site/);
    assert.deepEqual(journal.projection.spendBySite(), [
      { site: "prover.session", usd: 0.75, inputTokens: 100, outputTokens: 10, requests: 4 },
      { site: "graph.attempt", usd: 0.5, inputTokens: 20, outputTokens: 2, requests: 2 },
      { site: "unknown", usd: 0.125, inputTokens: 10, outputTokens: 1, requests: 1 },
    ]);
    assert.equal(journal.projection.runSummary().usd, 1.375);
    journal.close();
  });
});

describe("a journal a crash cut", () => {
  function twoEvents(dir: string): string {
    const path = join(dir, "journal.jsonl");
    const log = EventLog.open(path, { run: "run_1" });
    log.append("run.started", { runId: "run_1", benchId: "b", problems: 0, host: "local", config: {} }, "orchestrator");
    log.append("run.finished", { runId: "run_1", attempted: 0, solved: 0, candidates: 0, usd: 0 }, "orchestrator");
    log.close();
    return path;
  }

  it("reports a fragment it drops, and keeps the chain", () => {
    const path = twoEvents(tempDir());
    const fragment = '{"v":1,"seq":2,"id":"evt_X","ts":"2026-10-21T0';
    appendFileSync(path, fragment);
    const reopened = EventLog.open(path, { run: "run_1" });
    assert.deepEqual(reopened.recovered, { action: "dropped", bytes: Buffer.byteLength(fragment), sha256: sha256Hex(fragment) });
    assert.equal(reopened.length, 2);
    reopened.append("run.resumed", { runId: "run_1", resumption: 1, tornTail: reopened.recovered!, spent: { usd: 0, inputTokens: 0, outputTokens: 0 }, interrupted: { attempts: 0, toolRuns: 0, tasks: 0 } }, "orchestrator");
    reopened.close();
    const events = readEvents(path);
    assert.equal(events.length, 3);
    assert.deepEqual(verifyChain(events), { ok: true });
    assert.equal(events[2]?.type, "run.resumed");
    assert.match(readFileSync(path, "utf8"), /\n$/);
  });

  it("takes the digest of the bytes it drops, also when the cut is inside a multi-byte character or the bytes are not UTF-8", () => {
    for (const bytes of [
      // A fragment cut in the middle of the three bytes of "∀".
      Buffer.concat([Buffer.from('{"v":1,"seq":2,"id":"evt_X","note":"', "utf8"), Buffer.from("∀", "utf8").subarray(0, 2)]),
      // Bytes that are not UTF-8 at all.
      Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0xc3]),
    ]) {
      const path = twoEvents(tempDir());
      appendFileSync(path, bytes);
      const reopened = EventLog.open(path, { run: "run_1" });
      assert.deepEqual(reopened.recovered, { action: "dropped", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      assert.notEqual(reopened.recovered?.sha256, sha256Hex(bytes.toString("utf8")), "the decoded string is not the dropped bytes");
      reopened.close();
      assert.deepEqual(verifyChain(readEvents(path)), { ok: true });
    }
  });

  it("keeps a whole event that lacks only its newline", () => {
    const path = twoEvents(tempDir());
    const text = readFileSync(path, "utf8");
    truncateSync(path, Buffer.byteLength(text) - 1);
    const reopened = EventLog.open(path, { run: "run_1" });
    assert.equal(reopened.recovered?.action, "completed");
    assert.equal(reopened.length, 2, "the event that was written whole is not lost");
    reopened.close();
    const events = readEvents(path);
    assert.equal(events.length, 2);
    assert.deepEqual(verifyChain(events), { ok: true });
    assert.equal(EventLog.open(path, { run: "run_1" }).recovered, undefined);
  });

  it("drops a last line that parses but does not belong to the chain", () => {
    const path = twoEvents(tempDir());
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    // The last event with its content changed: a whole line, but the hash no longer matches.
    writeFileSync(path, `${lines[0]}\n${(lines[1] as string).replace('"usd":0', '"usd":9')}`);
    const reopened = EventLog.open(path, { run: "run_1" });
    assert.equal(reopened.recovered?.action, "dropped");
    assert.equal(reopened.length, 1);
    reopened.close();
    assert.deepEqual(verifyChain(readEvents(path)), { ok: true });
  });

  it("opens a journal that ends cleanly without saying anything", () => {
    const path = twoEvents(tempDir());
    const reopened = EventLog.open(path, { run: "run_1" });
    assert.equal(reopened.recovered, undefined);
    reopened.close();
  });

  it("still refuses a journal that is damaged before its last line", () => {
    const path = twoEvents(tempDir());
    writeFileSync(path, readFileSync(path, "utf8").replace('"problems":0', '"problems":7'));
    assert.throws(() => EventLog.open(path, { run: "run_1" }), /corrupt at seq 0/);
  });
});

describe("ladder.escalated", () => {
  const rung = (extra: Record<string, unknown> = {}) => ({
    problemId: "prb_clm_1", from: 0, to: 1, lines: ["M18"], threshold: 0.3, sinceProgressUsd: 1.6, budgetUsd: 5, reason: "no Lean progress yet", ...extra,
  });

  it("is orchestrator-only, moves up from the rung the problem is on, and checks the spend against the threshold", () => {
    const dir = tempDir();
    try {
      const journal = Journal.open(dir, "run_ladder");
      seedProblem(journal);
      assert.throws(() => journal.emit("ladder.escalated", rung() as never, "line:M12"), /orchestrator/);
      assert.throws(() => journal.emit("ladder.escalated", rung({ problemId: "prb_x" }) as never, "orchestrator"), /unknown problem/);
      assert.throws(() => journal.emit("ladder.escalated", rung({ sinceProgressUsd: 1.4 }) as never, "orchestrator"), /under the threshold/);
      assert.throws(() => journal.emit("ladder.escalated", rung({ from: 1, to: 2 }) as never, "orchestrator"), /is on rung 0/);
      assert.throws(() => journal.emit("ladder.escalated", rung({ to: 0 }) as never, "orchestrator"), /moves up/);
      assert.throws(() => journal.emit("ladder.escalated", rung({ lines: [] }) as never, "orchestrator"), /made of lines/);
      journal.emit("ladder.escalated", rung() as never, "orchestrator");
      assert.equal(journal.projection.ladderRung("prb_clm_1"), 1);
      assert.throws(() => journal.emit("ladder.escalated", rung() as never, "orchestrator"), /is on rung 1/);
      journal.emit("ladder.escalated", rung({ from: 1, to: 3, lines: ["M15", "M16"], threshold: 0.6, sinceProgressUsd: 3.2 }) as never, "orchestrator");
      assert.deepEqual(journal.projection.ladder("prb_clm_1").map((r) => [r.from, r.to, r.lines]), [[0, 1, ["M18"]], [1, 3, ["M15", "M16"]]]);
      assert.equal(journal.projection.ladderRung("prb_other"), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
