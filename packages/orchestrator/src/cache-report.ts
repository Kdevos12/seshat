import type { HarnessEvent } from "@seshat/core";

/**
 * The prompt cache, read from the journal alone (documentation/m0-loop.md, "Prices"): of the input tokens, the
 * share the provider read from its cache, `cacheRead / (cacheRead + miss)`, and the dollars the cache saved against
 * a price with no cache. A cache write counts as a miss, since the journal does not keep it apart.
 */
export interface CacheStat {
  /** Model responses counted. */
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** `cachedInputTokens / inputTokens`; absent when there was no input. */
  ratio?: number;
  /** Dollars the cache saved: the cache reads at the miss price, less the cache-hit price they were charged. */
  savedUsd: number;
  usd: number;
}

export interface CacheReport {
  total: CacheStat;
  /** Each prover session (an attempt), in the order they ended. */
  sessions: Array<CacheStat & { attemptId: string; problemId?: string }>;
  /** By line: the lines' one-shot calls under the line's id, the provers' sessions under `prover`. */
  byLine: Record<string, CacheStat>;
  /** By ladder rung (PE4), when the run had any; a problem is at rung 0 until a `ladder.escalated` event moves it. */
  byRung?: Record<string, CacheStat>;
}

type Acc = { calls: number; inputTokens: number; cachedInputTokens: number; savedUsd: number; usd: number };
const blank = (): Acc => ({ calls: 0, inputTokens: 0, cachedInputTokens: 0, savedUsd: 0, usd: 0 });

function add(into: Acc, from: Partial<Acc>): void {
  into.calls += from.calls ?? 0;
  into.inputTokens += from.inputTokens ?? 0;
  into.cachedInputTokens += from.cachedInputTokens ?? 0;
  into.savedUsd += from.savedUsd ?? 0;
  into.usd += from.usd ?? 0;
}

function stat(a: Acc): CacheStat {
  return { ...a, ...(a.inputTokens > 0 ? { ratio: a.cachedInputTokens / a.inputTokens } : {}) };
}

/** The cache report of a journal, or undefined when no response was charged. */
export function cacheReport(events: readonly HarnessEvent[]): CacheReport | undefined {
  const total = blank();
  const byLine = new Map<string, Acc>();
  const byRung = new Map<string, Acc>();
  const sessions: CacheReport["sessions"] = [];
  const taskProblem = new Map<string, string>();
  const attemptProblem = new Map<string, string>();
  const rungs = new Map<string, number>();
  // The charges of an attempt: its totals, when it finished, are the sum of the same charges; a finished attempt
  // written from the charges carries no cached sum, so the larger of the two figures is the attempt's.
  const charged = new Map<string, Acc>();
  let rungsOn = false;
  const into = (map: Map<string, Acc>, key: string): Acc => {
    const found = map.get(key) ?? blank();
    map.set(key, found);
    return found;
  };
  const rungOf = (problemId: string | undefined): string => String(problemId === undefined ? 0 : (rungs.get(problemId) ?? 0));
  const count = (line: string, problemId: string | undefined, part: Acc, attemptId?: string): void => {
    add(total, part);
    add(into(byLine, line), part);
    add(into(byRung, rungOf(problemId)), part);
    if (attemptId !== undefined) sessions.push({ attemptId, ...(problemId !== undefined ? { problemId } : {}), ...stat(part) });
  };
  for (const event of events) {
    switch (event.type) {
      case "task.created":
        if (event.data.problemId !== undefined) taskProblem.set(event.data.taskId, event.data.problemId);
        break;
      case "attempt.started": {
        const problemId = event.data.taskId === undefined ? undefined : taskProblem.get(event.data.taskId);
        if (problemId !== undefined) attemptProblem.set(event.data.attemptId, problemId);
        break;
      }
      case "ladder.escalated":
        rungsOn = true;
        rungs.set(event.data.problemId, event.data.to);
        break;
      case "attempt.charged": {
        const d = event.data;
        add(into(charged, d.attemptId), { calls: 1, inputTokens: d.inputTokens, cachedInputTokens: d.cachedInputTokens ?? 0, savedUsd: d.savedUsd ?? 0, usd: d.usd });
        break;
      }
      case "attempt.finished": {
        const d = event.data;
        const sum = charged.get(d.attemptId) ?? blank();
        charged.delete(d.attemptId);
        count(
          "prover",
          attemptProblem.get(d.attemptId),
          {
            calls: Math.max(d.turns ?? 0, sum.calls),
            inputTokens: d.inputTokens,
            cachedInputTokens: Math.max(d.cachedInputTokens ?? 0, sum.cachedInputTokens),
            savedUsd: Math.max(d.savedUsd ?? 0, sum.savedUsd),
            usd: d.usd,
          },
          d.attemptId,
        );
        break;
      }
      case "model_call.finished": {
        const d = event.data;
        const problemId = d.problemId ?? (d.attemptId === undefined ? undefined : attemptProblem.get(d.attemptId));
        // A call a session made is in the session's totals already.
        if (d.attemptId !== undefined) break;
        count(d.line, problemId, { calls: 1, inputTokens: d.inputTokens, cachedInputTokens: d.cachedInputTokens ?? 0, savedUsd: d.savedUsd ?? 0, usd: d.usd });
        break;
      }
      default:
        break;
    }
  }
  // Sessions that never finished: their charges are all the journal has.
  for (const [attemptId, sum] of charged) count("prover", attemptProblem.get(attemptId), sum, attemptId);
  if (total.calls === 0) return undefined;
  const view = (map: Map<string, Acc>): Record<string, CacheStat> =>
    Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, acc]) => [key, stat(acc)]));
  return { total: stat(total), sessions, byLine: view(byLine), ...(rungsOn ? { byRung: view(byRung) } : {}) };
}
