import type { Submission, ValidationReport } from "@seshat/core";
import { classifyFailure } from "@seshat/memory";
import { normalizeSubmission } from "./text.ts";

/**
 * What M6 remembers of the last check of a prover's file (plan §9, "anchored revisions"): the file
 * as Lean read it, and whether the answer gave the prover anything to revise from.
 */
export interface LastCheck {
  /** The file's code in both regions, comments and spacing out (`normalizeSubmission`). */
  code: string;
  /** Whether Lean (or the harness's refusal) said something about the file. False when Lean was not reached. */
  signal: boolean;
  /** Whether sending the same file again can give another answer: Lean was not reached, or timed out. */
  retry: boolean;
}

/**
 * Whether a check's answer is an external signal. Lean's errors, goals and holes are; so is a
 * refusal before Lean, which says why; an answer that never came (Lean could not be reached) is not.
 */
export function hasSignal(report: ValidationReport): boolean {
  return classifyFailure(report)?.class !== "lean_unavailable";
}

/** What to remember of a check. */
export function lastCheckOf(submission: Submission, report: ValidationReport): LastCheck {
  const cls = classifyFailure(report)?.class;
  return { code: normalizeSubmission(submission), signal: cls !== "lean_unavailable", retry: cls === "lean_unavailable" || cls === "timeout" };
}

export type RevisionProblemKind = "identical" | "unanchored";

export interface RevisionProblem {
  kind: RevisionProblemKind;
  /** What the prover is told: in words it can act on, and made of this page's wording only. */
  message: string;
}

/**
 * A revision is a file that differs from the one last checked. It follows an external signal when
 * the last check said something about the file; it cannot when that check never reached Lean. The
 * same file sent again is no revision and no new check: Lean answers a file the same way twice,
 * unless the first answer never came or ran out of time. Returns undefined when the call is fine.
 */
export function revisionProblem(last: LastCheck | undefined, proposal: Submission): RevisionProblem | undefined {
  if (last === undefined) return undefined;
  const same = normalizeSubmission(proposal) === last.code;
  if (same && !last.retry) {
    return {
      kind: "identical",
      message:
        "This file is the one you checked last, apart from comments and spacing, and Lean's answer to it is already in front of you. " +
        "Change the file in answer to what Lean said, then check it.",
    };
  }
  if (!same && !last.signal) {
    return {
      kind: "unanchored",
      message:
        "Your last check never reached Lean, so it said nothing about the file and there is nothing to revise from. " +
        "Send the same file again; revise it once a check has answered.",
    };
  }
  return undefined;
}
