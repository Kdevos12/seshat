/**
 * The verdict of a hole session (plan change CA11, documentation/scheduler.md, "Hole sessions and verdicts"). A verdict is a fact about a
 * session, recorded as a memory node of kind `hole_verdict` with `data.verdict`; it is never a claim's status. The loop telemetry reads the
 * nodes of this kind to report the share of proposed holes that turned out false.
 */
export const HOLE_VERDICT_KIND = "hole_verdict";
/** The verdict that a hole is false. It makes a negation `computed` only when a Lean-checked proof of the negation went through `validate`. */
export const HOLE_FALSE_VERDICT = "statement_wrong";
export const HOLE_VERDICTS = ["proved", HOLE_FALSE_VERDICT, "too_hard"] as const;
export type HoleVerdict = (typeof HOLE_VERDICTS)[number];
/** The evidence node a `statement_wrong` verdict without a Lean-checked negation leaves on the claim: a suspicion, never a status. */
export const SUSPECT_FALSE_KIND = "suspect_false";

/**
 * The reason a hole's task ends with when its work is done on stubs and its claim waits for its dependencies. The task API has no ending that fits (`blocked`
 * needs done tasks as blockers), so the task is `failed` with this reason and every reader that shows tasks says such a task is waiting, not failed.
 */
export const HOLE_WAITING_REASON = "the work on the hole is done on stubs; its claim waits for its dependencies and is validated when they are accepted";

/** Whether a task ended as a waiting hole (see `HOLE_WAITING_REASON`). */
export function isWaitingHoleTask(task: { status: string; reason: string | null }): boolean {
  return task.status === "failed" && task.reason === HOLE_WAITING_REASON;
}
