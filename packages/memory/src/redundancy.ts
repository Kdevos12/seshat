import type { HarnessEvent } from "@seshat/core";

/** The plan's "redundant attempts" (§6): attempts that repeat an earlier failure. */
export interface Redundancy {
  /** Finished attempts that were accepted or failed, with a strategy label. */
  attempts: number;
  /**
   * Failed attempts on a claim, or on one equivalent to it, that an earlier attempt had already
   * failed in the same way: the same strategy, the same failure class and the same typed detail.
   */
  redundant: number;
  /** `redundant / attempts`. */
  share: number;
}

/**
 * The share of attempts that were already tried and failed the same way, read from a run's events
 * alone. An attempt counts as redundant when an attempt that finished before it, on its claim or
 * on a claim that was `lean_checked` equivalent by then, has its strategy, failure class and
 * failure detail. Attempts with no strategy label (a run without the M1 line, a session that
 * submitted nothing) are not counted at all; the result is undefined when none is.
 */
export function redundancy(events: readonly HarnessEvent[]): Redundancy | undefined {
  const claimOf = new Map<string, string>();
  const edges = new Map<string, { from: string; to: string }>();
  const parent = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  const find = (id: string): string => {
    let root = id;
    for (let up = parent.get(root); up !== undefined; up = parent.get(root)) root = up;
    return root;
  };
  const union = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)];
    if (x === y) return;
    parent.set(y, x);
    const merged = seen.get(x) ?? new Set<string>();
    for (const key of seen.get(y) ?? []) merged.add(key);
    seen.set(x, merged);
    seen.delete(y);
  };
  let attempts = 0;
  let redundant = 0;
  for (const event of events) {
    switch (event.type) {
      case "attempt.started":
        claimOf.set(event.data.attemptId, event.data.claimId);
        break;
      case "edge.added":
        if (event.data.kind !== "equiv") break;
        edges.set(event.data.edgeId, { from: event.data.from, to: event.data.to[0] as string });
        if (event.data.status === "lean_checked") union(event.data.from, event.data.to[0] as string);
        break;
      case "edge.status_changed": {
        const edge = edges.get(event.data.edgeId);
        if (edge !== undefined && event.data.to === "lean_checked") union(edge.from, edge.to);
        break;
      }
      case "attempt.finished": {
        const d = event.data;
        const claimId = claimOf.get(d.attemptId);
        if (claimId === undefined || d.strategy === undefined || (d.outcome !== "valid" && d.outcome !== "invalid")) break;
        attempts += 1;
        if (d.outcome === "valid") break;
        const root = find(claimId);
        const known = seen.get(root) ?? new Set<string>();
        seen.set(root, known);
        const key = JSON.stringify([d.strategy, d.failureClass ?? null, d.failureDetail ?? null]);
        if (known.has(key)) redundant += 1;
        known.add(key);
        break;
      }
      default:
        break;
    }
  }
  return attempts === 0 ? undefined : { attempts, redundant, share: redundant / attempts };
}
