import type { ValidationReport } from "@seshat/core";
import { classifyFailure, type FailureClass, type FailureContext } from "./failures.ts";
import type { Attempt } from "./store.ts";

/**
 * How far Lean got with a file, from the class of the check's failure: the deeper the failure, the
 * more of the proof Lean accepted. A parse error says Lean read nothing; unsolved goals say every
 * step typed and only goals are left; holes say the sketch compiles; a valid file is the end.
 * Classes that say nothing about the proof itself (the check was refused or never ran, it timed
 * out, the lemma restates the target, the statement changed) are depth 0.
 */
export const FAILURE_DEPTH: Readonly<Record<FailureClass, number>> = {
  refused: 0,
  lean_unavailable: 0,
  timeout: 0,
  other: 0,
  restates_target: 0,
  statement_changed: 0,
  syntax: 1,
  unknown_identifier: 2,
  type_mismatch: 3,
  tactic_failed: 4,
  unsolved_goals: 5,
  holes: 6,
  axioms: 7,
};

/** The depth of a valid check: the proof passed. */
export const VALID_DEPTH = 8;

/** The depth of a failure class, or 0 for a class this version does not know. */
export function failureDepth(failureClass: string | undefined): number {
  return failureClass !== undefined && failureClass in FAILURE_DEPTH ? FAILURE_DEPTH[failureClass as FailureClass] : 0;
}

/** What one check says about the proof: how deep Lean got, how many errors and how many holes are left. */
export interface LeanState {
  depth: number;
  errors: number;
  holes: number;
}

/** The state a check's report puts the file in. `context` is the one `classifyFailure` takes. */
export function leanState(report: ValidationReport, context: FailureContext = {}): LeanState {
  const failure = classifyFailure(report, context);
  return {
    depth: failure === undefined ? VALID_DEPTH : failureDepth(failure.class),
    errors: report.messages.filter((m) => m.severity === "error").length,
    holes: report.sorries.length > 0 ? report.sorries.length : report.holes ? 1 : 0,
  };
}

/**
 * Whether `now` is strictly better than `best`: deeper, or at the same depth with fewer errors, or
 * with as many errors and fewer holes (a closed subgoal). With no `best`, anything is progress.
 */
export function improves(now: LeanState, best: LeanState | undefined): boolean {
  if (best === undefined) return true;
  if (now.depth !== best.depth) return now.depth > best.depth;
  if (now.errors !== best.errors) return now.errors < best.errors;
  return now.holes < best.holes;
}

/** The better of two states, the first one when neither is better. */
export function betterOf(a: LeanState, b: LeanState | undefined): LeanState {
  return b === undefined || improves(a, b) ? a : b;
}

/**
 * How far a finished attempt got: `VALID_DEPTH` for an accepted one, the depth of its failure class
 * for a failed one, undefined for one that says nothing (no submission, cut short, harness error).
 */
export function attemptDepth(attempt: Pick<Attempt, "outcome" | "failureClass">): number | undefined {
  if (attempt.outcome === "valid") return VALID_DEPTH;
  if (attempt.outcome === "invalid") return failureDepth(attempt.failureClass);
  return undefined;
}
