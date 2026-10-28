/**
 * A model call that was not sent because the run was told to pause (the end of a consortium turn,
 * documentation/human.md, "Turns") is not a failure of the line that asked for it. The harness throws an
 * `InterruptedError` from `problem.llm` and from the other things it hands to a line; a line that catches
 * errors from them lets this one through, or notices it with `isInterrupted`, and then
 *
 * - records nothing as an end, a failure or an exhaustion: the work is not over, it is interrupted;
 * - leaves its durable state (nodes, edges, claims) as it was, so that a run resumed from the journal
 *   rebuilds the work from what the journal holds, and does it again from where it was;
 * - does not retry (the next call would be refused too).
 *
 * `soft` mechanisms that only log a failure may log it. The contract is in documentation/lines.md.
 */
export class InterruptedError extends Error {
  constructor(message = "the run was interrupted: no more model calls until it resumes") {
    super(message);
    this.name = "InterruptedError";
  }
}

/** Whether a failure is an interruption, however many layers of code wrapped it. */
export function isInterrupted(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof InterruptedError) return true;
  }
  return false;
}
