import type { AttemptOutcome, Journal, RouteAction } from "@seshat/core";
import { type DriftAction, type DriftKind, isDriftData } from "@seshat/guards";
import { type FailureClass, type ModelRanking, onlyWeakerFailures } from "@seshat/memory";
import type { TaskLedger } from "@seshat/scheduler";

/**
 * Typed error routing (documentation/ledger.md, "Routing decisions"): what a task that met a typed
 * signal calls for. The signals are the failure classes of a check (M1, `FAILURE_CLASSES`), the
 * kinds of drift a guard found (M6, `DRIFT_KINDS`) and a subgoal that was refuted. The actions are
 * three:
 *
 * - `retry_fresh`: a new session on the same task. The error is local: the next session reads what
 *   Lean said and fixes it.
 * - `retry_stronger`: a new session on the same task with the strongest model configured. It takes
 *   the place of `branch` when every failure of the claim ran under a weaker configuration than the
 *   strongest one (plan change PE3): a stalled claim is first tried with the model that has not been
 *   tried on it, and only then with other constraints.
 * - `reset_upstream`: go back to the planning above the task and re-decompose the parent. The error
 *   is in what the task rests on (its statement, its decomposition), not in its proof.
 * - `branch`: open an alternative task under other constraints. The task is stuck: more of the same
 *   would not get further.
 *
 * A decision is an event with its reason (`task.routed`) and changes no status, neither the task's
 * nor any claim's. The orchestrator records it; `retry_fresh` is what the prover's loop does next in
 * any case, and the lines that plan work (M12; M7 and M14 for `branch`) read the decisions through
 * `TaskApi.routings` and propose the tasks that follow.
 */
export interface Route {
  action: RouteAction;
  /** Why the signal calls for this action. It is part of the decision's reason. */
  reason: string;
}

const retry = (reason: string): Route => ({ action: "retry_fresh", reason });
const reset = (reason: string): Route => ({ action: "reset_upstream", reason });
const branch = (reason: string): Route => ({ action: "branch", reason });

/**
 * The failure classes of M1, each with its action. Typed over `FailureClass`, so that a class added
 * to M1 does not compile until it is routed here. The classes about Lean's errors are local to a
 * proof and a fresh session fixes them; the two that say the proof is about the wrong statement go
 * back up.
 */
export const FAILURE_ROUTES: Readonly<Record<FailureClass, Route>> = {
  refused: retry("the submission never reached Lean (a forbidden token or a marker line); the next session reads the rule and submits again"),
  lean_unavailable: retry("Lean could not be reached, so nothing was checked about the proof; the task tries again in a fresh session"),
  timeout: retry("Lean's time or heartbeat limit was reached; a fresh session tries a lighter proof"),
  syntax: retry("Lean could not parse the proof, a local error; a fresh session writes it again"),
  unknown_identifier: retry("a name that does not exist, a local error; a fresh session looks for the right one"),
  type_mismatch: retry("a typing error in one step, a local error; a fresh session mends the step"),
  tactic_failed: retry("a tactic could not do its job, a local error; a fresh session uses another"),
  unsolved_goals: retry("the proof ends with goals left, the usual state of a proof in progress; a fresh session goes on from the file"),
  holes: retry("no error, but a sorry is left; a fresh session fills it"),
  axioms: retry("the proof depends on an axiom outside the allowed ones; a fresh session proves it without"),
  statement_changed: reset("the statement no longer elaborates to the original type, so the work above the task is wrong, not the proof; go back to the parent"),
  restates_target: reset("an auxiliary lemma states the target again, so it decomposes nothing; go back to the parent and decompose it differently"),
  other: retry("an error the classes do not name; the cheapest action is a fresh session on the same task"),
};

/**
 * The kinds of drift of M6, each with its action. Typed over `DriftKind`. A session that loops on
 * one strategy, or sessions that do, are stuck, and another strategy under other constraints is the
 * way out; a file that drifts from the statement or restates the target has lost the premise of the
 * task. The kinds a guard handles in place are routed to a fresh session, the cheapest action, in
 * case a later guard stops a session for one.
 */
export const DRIFT_ROUTES: Readonly<Record<DriftKind, Route>> = {
  strategy_loop: branch("checks repeat one strategy and Lean gets no further; open an alternative task under other constraints, with another strategy"),
  session_loop: branch("sessions repeat one strategy and Lean gets no further, which is stagnation; open an alternative task under other constraints"),
  statement_drift: reset("the file drifted from the target's statement, so what the task rests on is lost; go back to the parent"),
  restated_target: reset("an auxiliary lemma restates the target, so it decomposes nothing; go back to the parent and decompose it differently"),
  length_growth: retry("the file grows and no subgoal closes; a fresh session starts again from the file and the notes, told to simplify"),
  unresolved_citation: retry("a reference resolved to nothing known; a fresh session cites only what it was given"),
  sorry_as_known: retry("a sorry was presented as a known result; a fresh session proves the step or drops the claim"),
  raw_error_text: retry("Lean's raw output was in a text; a fresh session works from the typed summary"),
  unanchored_revision: retry("a check revised nothing that Lean had said; a fresh session revises what Lean reported"),
  non_neutral_framing: retry("a briefing asked to prove what may be an open conjecture; a fresh session reads the neutral question"),
};

/** A subgoal of the task's claim was refuted: the decomposition is dead, so the parent is decomposed again. */
export const SUBGOAL_REFUTED_ROUTE: Route = reset(
  "a part of the claim's decomposition was refuted, so the decomposition cannot prove the claim; go back to the parent and decompose it differently",
);

/** What a task met. */
export type RouteSignal =
  | { type: "failure_class"; value: FailureClass }
  | { type: "drift_kind"; value: DriftKind }
  /** `value` is the refuted subgoal's claim id. */
  | { type: "subgoal_refuted"; value: string };

/** The action and the reason the table gives a signal. */
export function routeOf(signal: RouteSignal): Route {
  switch (signal.type) {
    case "failure_class":
      return FAILURE_ROUTES[signal.value];
    case "drift_kind":
      return DRIFT_ROUTES[signal.value];
    case "subgoal_refuted":
      return SUBGOAL_REFUTED_ROUTE;
  }
}

/**
 * The drift actions that end or restart work: a session was stopped, or the prover starts afresh.
 * Only these are signals for the task. The others (`rejected_call`, `removed_text`,
 * `dropped_section`, `noted`) are findings the guard dealt with in place: nothing failed, and the
 * `drift` node holds them.
 */
export const ROUTED_DRIFT_ACTIONS: readonly DriftAction[] = ["stopped_session", "restarted"];

/** An attempt that ended, as the router needs it. */
export interface EndedAttempt {
  attemptId: string;
  /** The task the attempt worked for. */
  taskId: string;
  claimId: string;
  /** The class of its last check, when it ended `invalid`. */
  failureClass?: FailureClass;
}

/** A decision taken, as it was recorded. */
export interface Decision {
  taskId: string;
  action: RouteAction;
  signal: RouteSignal;
  reason: string;
  attemptId?: string;
  nodeId?: string;
}

/**
 * Takes the routing decisions that follow an attempt: one for the class of its failed check, one for
 * each drift node a guard recorded for it that stopped the session or restarted the prover, one for
 * each refuted part of a decomposition of its claim that was not routed yet. It writes
 * `task.routed` events and nothing else.
 */
export class Router {
  private readonly journal: Journal;
  private readonly tasks: TaskLedger;
  private readonly ranking: ModelRanking | undefined;

  /** `ranking`: the run's models, weakest first, and its budget class; without it nothing is routed to `retry_stronger`. */
  constructor(journal: Journal, tasks: TaskLedger, ranking?: ModelRanking) {
    this.journal = journal;
    this.tasks = tasks;
    this.ranking = ranking;
  }

  /**
   * `branch` becomes `retry_stronger` when every failure of the claim, this attempt's included,
   * ran under a weaker configuration than the strongest one configured. Otherwise the route stands.
   */
  private stronger(route: Route, claimId: string): Route {
    if (route.action !== "branch" || this.ranking === undefined) return route;
    const attempts = this.journal.projection.attempts(claimId).map((row) => ({
      model: row.model,
      ...(row.outcome !== null ? { outcome: row.outcome as AttemptOutcome } : {}),
      ...(row.provenance !== null ? { provenance: row.provenance } : {}),
    }));
    if (!onlyWeakerFailures(attempts, this.ranking)) return route;
    const strongest = this.ranking.order.at(-1);
    return {
      action: "retry_stronger",
      reason: `every failure of the claim ran under a weaker configuration than the strongest one configured (${strongest}); try that first, before ${route.reason}`,
    };
  }

  attemptEnded(attempt: EndedAttempt): Decision[] {
    const p = this.journal.projection;
    const decisions: Decision[] = [];
    const decide = (signal: RouteSignal, said: string, ids: { nodeId?: string } = {}) => {
      const route = this.stronger(routeOf(signal), attempt.claimId);
      const decision: Decision = {
        taskId: attempt.taskId,
        action: route.action,
        signal,
        reason: `${said}: ${route.reason}`,
        attemptId: attempt.attemptId,
        ...(ids.nodeId !== undefined ? { nodeId: ids.nodeId } : {}),
      };
      this.tasks.route({
        taskId: decision.taskId,
        action: decision.action,
        signal,
        reason: decision.reason,
        attemptId: attempt.attemptId,
        ...(ids.nodeId !== undefined ? { nodeId: ids.nodeId } : {}),
      });
      decisions.push(decision);
    };

    if (attempt.failureClass !== undefined) {
      decide({ type: "failure_class", value: attempt.failureClass }, `the last check failed as ${attempt.failureClass}`);
    }

    const routed = p.taskRoutes(attempt.taskId);
    for (const node of p.nodes("drift", attempt.claimId)) {
      const data = node.data;
      if (!isDriftData(data) || data.attemptId !== attempt.attemptId || !ROUTED_DRIFT_ACTIONS.includes(data.action)) continue;
      if (routed.some((r) => r.node_id === node.node_id)) continue;
      decide({ type: "drift_kind", value: data.kind }, `a guard found ${data.kind} (${data.action}): ${data.detail}`, { nodeId: node.node_id });
    }

    for (const edge of p.edges({ from: attempt.claimId, kinds: ["decomposes_into"] })) {
      for (const part of edge.to) {
        if (p.claim(part)?.status !== "refuted") continue;
        if (routed.some((r) => r.signal_type === "subgoal_refuted" && r.signal_value === part)) continue;
        if (decisions.some((d) => d.signal.type === "subgoal_refuted" && d.signal.value === part)) continue;
        decide({ type: "subgoal_refuted", value: part }, `part ${part} of a decomposition of the claim was refuted`);
      }
    }
    return decisions;
  }
}
