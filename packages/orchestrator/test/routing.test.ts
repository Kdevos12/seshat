import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Journal, type HarnessEvent, ROUTE_ACTIONS, ROUTE_SIGNAL_TYPES } from "@seshat/core";
import { DRIFT_KINDS } from "@seshat/guards";
import { FAILURE_CLASSES } from "@seshat/memory";
import { TaskLedger } from "@seshat/scheduler";
import { DRIFT_ROUTES, FAILURE_ROUTES, ROUTED_DRIFT_ACTIONS, Router, routeOf, SUBGOAL_REFUTED_ROUTE } from "../src/routing.ts";
import { check, demoRun, ofType, say, tempDir } from "./m0-helpers.ts";

/** The routing decisions of a run, in order, as [action, signal type, signal value]. */
function decisions(events: readonly HarnessEvent[]) {
  return ofType(events, "task.routed").map((e) => [e.data.action, e.data.signal.type, e.data.signal.value]);
}

const M6_ONLY = { lines: ["M6"] };

describe("the routing table", () => {
  it("routes every failure class of M1 and every kind of drift of M6, and nothing else", () => {
    assert.deepEqual(Object.keys(FAILURE_ROUTES).sort(), [...FAILURE_CLASSES].sort());
    assert.deepEqual(Object.keys(DRIFT_ROUTES).sort(), [...DRIFT_KINDS].sort());
    for (const route of [...Object.values(FAILURE_ROUTES), ...Object.values(DRIFT_ROUTES), SUBGOAL_REFUTED_ROUTE]) {
      assert.ok(ROUTE_ACTIONS.includes(route.action));
      assert.ok(route.reason.length > 20, "every route says why");
    }
    assert.deepEqual([...ROUTE_SIGNAL_TYPES].sort(), ["drift_kind", "failure_class", "subgoal_refuted"]);
  });

  it("gives the cases of the plan: local errors a fresh session, wrong foundations a reset, stuck work a branch", () => {
    for (const cls of ["syntax", "type_mismatch", "timeout"] as const) assert.equal(routeOf({ type: "failure_class", value: cls }).action, "retry_fresh", cls);
    for (const cls of ["statement_changed", "restates_target"] as const) assert.equal(routeOf({ type: "failure_class", value: cls }).action, "reset_upstream", cls);
    assert.equal(routeOf({ type: "subgoal_refuted", value: "clm_x" }).action, "reset_upstream");
    for (const kind of ["strategy_loop", "session_loop"] as const) assert.equal(routeOf({ type: "drift_kind", value: kind }).action, "branch", kind);
    for (const kind of ["statement_drift", "restated_target"] as const) assert.equal(routeOf({ type: "drift_kind", value: kind }).action, "reset_upstream", kind);
    // Three actions are in the table, and it has no other: `retry_stronger` is not a route of a signal, the Router takes it in the place of a `branch`.
    const used = new Set([...Object.values(FAILURE_ROUTES), ...Object.values(DRIFT_ROUTES), SUBGOAL_REFUTED_ROUTE].map((r) => r.action));
    assert.deepEqual([...used].sort(), ROUTE_ACTIONS.filter((action) => action !== "retry_stronger").sort());
  });

  it("routes only the findings that stopped a session or restarted a prover", () => {
    assert.deepEqual([...ROUTED_DRIFT_ACTIONS].sort(), ["restarted", "stopped_session"]);
  });
});

describe("routing in a run", () => {
  it("records the decision for the class of each failed check, with its reason, and changes no status", async () => {
    const { result, events } = await demoRun({
      config: { sessions: 3 },
      responses: [check("bad"), say("NOTES: bad is not a lemma."), check("have h : 1 = 1 := rfl\nsorry"), say("NOTES: fill the hole."), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(decisions(events), [
      ["retry_fresh", "failure_class", "unknown_identifier"],
      ["retry_fresh", "failure_class", "holes"],
    ]);
    const [task] = ofType(events, "task.created");
    const attempts = ofType(events, "attempt.finished");
    const routed = ofType(events, "task.routed");
    assert.deepEqual(routed.map((r) => r.data.taskId), [task?.data.taskId, task?.data.taskId]);
    assert.deepEqual(routed.map((r) => r.data.attemptId), [attempts[0]?.data.attemptId, attempts[1]?.data.attemptId]);
    assert.ok(routed.every((r) => r.actor === "orchestrator"));
    assert.match(routed[0]?.data.reason ?? "", /^the last check failed as unknown_identifier: a name that does not exist, a local error/);
    // A decision follows the end of its attempt and comes before the next one starts.
    const index = (e: HarnessEvent) => events.indexOf(e);
    const starts = ofType(events, "attempt.started");
    assert.ok(index(attempts[0] as HarnessEvent) < index(routed[0] as HarnessEvent) && index(routed[0] as HarnessEvent) < index(starts[1] as HarnessEvent));
    // Routing writes no status: the task's moves are the prover's, the claim's the validator's.
    assert.deepEqual(ofType(events, "task.status_changed").map((m) => m.data.to), ["ready", "running", "done"]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("routes an attempt that restates the target back up, and one that is valid nowhere", async () => {
    const { events } = await demoRun({
      config: { sessions: 2 },
      responses: [
        check("exact aux_main n", "theorem aux_main (n : ℕ) : n + 0 = n := by\n  sorry"),
        say("NOTES: the lemma was the theorem."),
        check("exact trivial_proof"),
      ],
    });
    assert.deepEqual(decisions(events), [["reset_upstream", "failure_class", "restates_target"]]);
    assert.match(ofType(events, "task.routed")[0]?.data.reason ?? "", /^the last check failed as restates_target: an auxiliary lemma states the target again/);
  });

  it("makes no decision for an attempt without a failed check", async () => {
    const solved = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.deepEqual(decisions(solved.events), []);
    const silent = await demoRun({ config: { sessions: 1 }, responses: [say("I have nothing.")] });
    assert.deepEqual(ofType(silent.events, "attempt.finished").map((a) => a.data.outcome), ["no_submission"]);
    assert.deepEqual(decisions(silent.events), []);
  });

  it("routes a drift that stopped a session to a branch, linked to the node and the attempt", async () => {
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), check("exact trivial_proof")],
    });
    const node = ofType(events, "node.recorded").find((e) => e.data.kind === "drift");
    const attempt = ofType(events, "attempt.finished")[0];
    const routed = ofType(events, "task.routed");
    assert.deepEqual(decisions(events), [
      ["retry_fresh", "failure_class", "unsolved_goals"],
      ["branch", "drift_kind", "strategy_loop"],
    ]);
    const branch = routed.find((r) => r.data.action === "branch");
    assert.equal(branch?.data.nodeId, node?.data.nodeId);
    assert.equal(branch?.data.attemptId, attempt?.data.attemptId);
    assert.match(branch?.data.reason ?? "", /^a guard found strategy_loop \(stopped_session\): 3 checks in a row with the strategy automation, and Lean got no further: checks repeat one strategy/);
    // The routing is a decision and nothing else: the task and the claim moved as they would have.
    assert.deepEqual(ofType(events, "task.status_changed").map((m) => m.data.to), ["ready", "running", "done"]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("routes a restarted prover and a lemma that restates the target from the guard's findings", async () => {
    const restating = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [check("exact aux_main n", "theorem aux_main (n : ℕ) : n + 0 = n := by\n  sorry"), check("exact trivial_proof")],
    });
    assert.deepEqual(decisions(restating.events), [
      ["reset_upstream", "failure_class", "restates_target"],
      ["reset_upstream", "drift_kind", "restated_target"],
    ]);

    const looping = await demoRun({
      config: { ...M6_ONLY, sessions: 4, lineOptions: { M6: { sessionRepeats: 2 } } },
      responses: [check("omega"), say("notes one"), check("linarith"), say("notes two"), check("simp"), say("notes three"), say("done")],
    });
    const branch = ofType(looping.events, "task.routed").filter((r) => r.data.signal.type === "drift_kind");
    assert.deepEqual(branch.map((r) => [r.data.action, r.data.signal.value]), [["branch", "session_loop"]]);
    const third = ofType(looping.events, "attempt.finished")[2];
    assert.equal(branch[0]?.data.attemptId, third?.data.attemptId, "the restart is about the third session");
  });

  it("leaves a finding the guard dealt with in place to the drift node alone", async () => {
    const { events } = await demoRun({
      config: M6_ONLY,
      responses: [check("-- this is a well-known result\nexact trivial_proof"), check("exact trivial_proof")],
    });
    const drift = ofType(events, "node.recorded").filter((e) => e.data.kind === "drift");
    assert.equal(drift.length, 1);
    assert.equal((drift[0]?.data.data as { action: string }).action, "rejected_call");
    assert.deepEqual(decisions(events), []);
  });
});

describe("Router", () => {
  /** A claim with a task and an attempt, and a decomposition into two parts. */
  function setup() {
    const journal = Journal.open(tempDir(), "run_1");
    const o = "orchestrator";
    for (const [claimId, statement] of [["clm_1", ": A"], ["clm_2", ": B"], ["clm_3", ": C"]] as const) {
      journal.emit("claim.created", { claimId, statementId: `st0_${claimId}`, statement, origin: "bench", status: "open" }, o);
    }
    journal.emit("problem.registered", { problemId: "prb_1", claimId: "clm_1", target: "t", source: { repo: "r", rev: "v", path: "X.lean" }, domain: [] }, o);
    const tasks = new TaskLedger(journal);
    const taskId = tasks.create({
      kind: "prove",
      problemId: "prb_1",
      claimId: "clm_1",
      owner: "prover:p1",
      acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" },
    });
    tasks.markReady(taskId, "no dependencies");
    tasks.start(taskId, "the prover starts");
    journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model: "m", taskId }, "prover:p1");
    journal.emit("edge.added", { edgeId: "edg_1", kind: "decomposes_into", from: "clm_1", to: ["clm_2", "clm_3"], status: "proposed" }, "test");
    return { journal, tasks, taskId, router: new Router(journal, tasks) };
  }

  function refute(journal: Journal, claimId: string): void {
    journal.emit(
      "validation.finished",
      { validationId: `val_${claimId}`, claimId, method: "kernel_replay", verdict: "valid", reasons: [], axioms: [], submissionHash: "h", negation: true },
      "kernel",
    );
    journal.emit("claim.status_changed", { claimId, from: "open", to: "refuted", reason: "certified", validationId: `val_${claimId}` }, "orchestrator");
  }

  it("sends the task back up when a part of its claim's decomposition is refuted, once", () => {
    const { journal, router, taskId } = setup();
    assert.deepEqual(router.attemptEnded({ attemptId: "att_1", taskId, claimId: "clm_1" }), [], "nothing is refuted yet");
    refute(journal, "clm_3");
    const [decision] = router.attemptEnded({ attemptId: "att_1", taskId, claimId: "clm_1" });
    assert.deepEqual([decision?.action, decision?.signal], ["reset_upstream", { type: "subgoal_refuted", value: "clm_3" }]);
    assert.match(decision?.reason ?? "", /^part clm_3 of a decomposition of the claim was refuted: a part of the claim's decomposition was refuted/);
    assert.deepEqual(router.attemptEnded({ attemptId: "att_1", taskId, claimId: "clm_1" }), [], "the same refutation is not routed twice");
    const routes = journal.projection.taskRoutes(taskId);
    assert.deepEqual(routes.map((r) => [r.action, r.signal_type, r.signal_value, r.attempt_id]), [["reset_upstream", "subgoal_refuted", "clm_3", "att_1"]]);
    // A decision changes no status.
    assert.equal(journal.projection.task(taskId)?.status, "running");
    assert.equal(journal.projection.claim("clm_1")?.status, "open");
    assert.equal(journal.projection.claim("clm_3")?.status, "refuted", "the refutation was the certifier's, not the router's");
    journal.close();
  });

  it("routes the failure class of an attempt, and only the orchestrator may write it", () => {
    const { journal, router, taskId } = setup();
    const [decision] = router.attemptEnded({ attemptId: "att_1", taskId, claimId: "clm_1", failureClass: "statement_changed" });
    assert.deepEqual([decision?.action, decision?.signal.value], ["reset_upstream", "statement_changed"]);
    assert.throws(
      () =>
        journal.emit(
          "task.routed",
          { taskId, action: "branch", signal: { type: "drift_kind", value: "strategy_loop" }, reason: "a line wants it" },
          "line:M6",
        ),
      /written by the orchestrator only, not by line:M6/,
    );
    assert.equal(journal.projection.taskRoutes(taskId).length, 1);
    journal.close();
  });
});
