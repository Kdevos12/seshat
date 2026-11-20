import type { Json } from "@seshat/core";
import type { Attempt, MemoryNode } from "@seshat/memory";

/**
 * Restart in another mode after a Lean stall (option `switchOnStall`, documentation/fleet.md, "Switching after a
 * stall"): which values of the session's `mode` and `thinking` the next draw leaves out.
 *
 * Called by `fleet.ts` before the settings are sampled; `sampleSettings` applies what it returns. It is two small
 * readings of the journal's own facts, and never decides on its own: it asks no model which mode to use, switches
 * nothing inside a session, and changes no claim's status.
 */

/** The values a draw leaves out: the ones the stalled attempt had. */
export interface Excluded {
  mode?: string;
  thinking?: string;
}

/**
 * The attempts M6's repeat rule stopped, from the `drift` nodes of the claim: the rule records a `repeated_failure`
 * finding with the action `stopped_session` and the attempt (`recordDrift` of `@seshat/guards`). The attempt record
 * itself keeps only `stoppedBy: "line:M6"`, which the other detectors share, so the finding is what says which cause.
 */
export function repeatStopped(drift: readonly MemoryNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of drift) {
    const data = node.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    if (data.kind === "repeated_failure" && data.action === "stopped_session" && typeof data.attemptId === "string") ids.add(data.attemptId);
  }
  return ids;
}

const text = (value: Json | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The values to leave out of the prover's next session: those of its last finished attempt on the claim, when M6's
 * repeat rule stopped that attempt (`stopped`) or the claim stagnates (`stagnant`). None otherwise, and none when the
 * prover has no finished attempt.
 */
export function excludedAfterStall(attempts: readonly Attempt[], prover: string, stopped: ReadonlySet<string>, stagnant: boolean): Excluded | undefined {
  const last = attempts
    .filter((attempt) => attempt.prover === prover && attempt.outcome !== undefined && attempt.finishedSeq !== undefined)
    .sort((a, b) => (a.finishedSeq ?? 0) - (b.finishedSeq ?? 0))
    .at(-1);
  if (last === undefined || !(stagnant || stopped.has(last.attemptId))) return undefined;
  const mode = text(last.settings?.mode);
  const thinking = text(last.settings?.thinking);
  if (mode === undefined && thinking === undefined) return undefined;
  return { ...(mode !== undefined ? { mode } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}
