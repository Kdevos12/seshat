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
