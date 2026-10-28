import type { ConfigClass } from "@seshat/core";
import { attemptClass, type ClassDifference, classKey, compareClass, describeDifference, type ModelRanking } from "./classes.ts";
import type { Attempt } from "./store.ts";

/** What was tried with one strategy on a claim and its equivalents. */
export interface TriedStrategy {
  /** A label of `STRATEGIES`. */
  strategy: string;
  /** Finished attempts with this label: the accepted ones and the failed ones. */
  attempts: number;
  /** Attempts whose proof passed the fast check. */
  accepted: number;
  /** The failed attempts by failure class, the most frequent first. */
  failures: Array<{ class: string; count: number }>;
  /** The last failed attempt: its class and its typed detail. */
  last?: { attemptId: string; class: string; detail?: string };
  /**
   * Set when `triedStrategies` was given the configuration of the session: the configuration of
   * these attempts (`FAMILY@BUDGET_CLASS`) and how it compares with the session's. Absent: the
   * attempts are not grouped by configuration.
   */
  configClass?: string;
  difference?: ClassDifference;
}

/** The configuration a briefing is made for, and the ranking that says whether another one was weaker (PE3). */
export interface TriedView {
  /** The configuration of the session that reads the summary. */
  current: ConfigClass;
  ranking: ModelRanking;
}

/**
 * Groups attempts by the strategy they were classified with. Only finished attempts that were
 * accepted or failed and carry a label count: a session that submitted nothing, or that was cut
 * (aborted, out of budget, a harness error), says nothing about its strategy. Most attempts first,
 * then the most recent, then by label.
 */
export function triedStrategies(attempts: readonly Attempt[], view?: TriedView): TriedStrategy[] {
  const groups = new Map<string, { strategy: string; klass?: ConfigClass; attempts: number; accepted: number; failures: Map<string, number>; lastSeq: number; last?: Attempt }>();
  for (const attempt of attempts) {
    if (attempt.strategy === undefined || (attempt.outcome !== "valid" && attempt.outcome !== "invalid")) continue;
    // With a view, the same strategy under another configuration is another line: a failure of a smaller model is soft evidence.
    const klass = view === undefined ? undefined : attemptClass(attempt, view.ranking.budgetClass);
    const key = klass === undefined ? attempt.strategy : `${attempt.strategy}\u0000${classKey(klass)}`;
    const group = groups.get(key) ?? { strategy: attempt.strategy, ...(klass !== undefined ? { klass } : {}), attempts: 0, accepted: 0, failures: new Map<string, number>(), lastSeq: -1 };
    groups.set(key, group);
    group.attempts += 1;
    group.lastSeq = Math.max(group.lastSeq, attempt.finishedSeq ?? attempt.startedSeq);
    if (attempt.outcome === "valid") {
      group.accepted += 1;
      continue;
    }
    const cls = attempt.failureClass ?? "other";
    group.failures.set(cls, (group.failures.get(cls) ?? 0) + 1);
    if (group.last === undefined || (attempt.finishedSeq ?? 0) >= (group.last.finishedSeq ?? 0)) group.last = attempt;
  }
  const difference = (group: { klass?: ConfigClass }): ClassDifference | undefined =>
    view === undefined || group.klass === undefined ? undefined : compareClass(view.ranking, group.klass, view.current);
  // The lines of the session's own configuration come first, then the others: what it did itself weighs more.
  const foreign = (group: { klass?: ConfigClass }): number => (difference(group)?.relation === "same" || difference(group) === undefined ? 0 : 1);
  return [...groups]
    .sort(([a, x], [b, y]) => foreign(x) - foreign(y) || y.attempts - x.attempts || y.lastSeq - x.lastSeq || (a < b ? -1 : 1))
    .map(([, group]) => ({
      strategy: group.strategy,
      ...(group.klass !== undefined ? { configClass: classKey(group.klass), difference: difference(group) as ClassDifference } : {}),
      attempts: group.attempts,
      accepted: group.accepted,
      failures: [...group.failures].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([cls, count]) => ({ class: cls, count })),
      ...(group.last !== undefined
        ? { last: { attemptId: group.last.attemptId, class: group.last.failureClass ?? "other", ...(group.last.failureDetail !== undefined ? { detail: group.last.failureDetail } : {}) } }
        : {}),
    }));
}

function words(cls: string): string {
  return cls.replace(/_/g, " ");
}

/**
 * One typed line: `induction: 3 attempts, unsolved goals at case succ`. The failures that share a
 * class show the last one's detail; several classes show their counts, then the last detail.
 * Nothing of an attempt's text is in it, only the label, counts, classes and typed details.
 */
export function describeTried(entry: TriedStrategy): string {
  const parts = [`${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}`];
  if (entry.accepted > 0) parts.push(`${entry.accepted} accepted`);
  const [only, ...more] = entry.failures;
  if (only !== undefined && more.length === 0) {
    parts.push(entry.last?.detail ?? words(only.class));
  } else if (only !== undefined) {
    parts.push([only, ...more].map((f) => `${f.count} ${words(f.class)}`).join(", ") + (entry.last?.detail !== undefined ? `; last: ${entry.last.detail}` : ""));
  }
  // A line from another configuration says so: its failures say less about this session's model and budget.
  const other = entry.difference !== undefined && entry.difference.relation !== "same" ? ` (with ${describeDifference(entry.difference)})` : "";
  return `${entry.strategy}: ${parts.join(", ")}${other}`;
}

/**
 * The "already tried" lines of a briefing: a sentence that says what they are, then one line per
 * strategy, cut at `maxLines` lines in all with a last line that counts the strategies left out.
 * No line when nothing was tried, or when `maxLines` is under 2.
 */
export function renderTried(entries: readonly TriedStrategy[], options: { maxLines: number }): string[] {
  const max = Math.floor(options.maxLines);
  if (entries.length === 0 || max < 2) return [];
  const intro = "Typed summaries of the attempts on this statement or an equivalent one, by you and the other provers (their text is not kept):";
  if (entries.length <= max - 1) return [intro, ...entries.map(describeTried)];
  const shown = entries.slice(0, Math.max(max - 2, 0));
  const left = entries.length - shown.length;
  return [intro, ...shown.map(describeTried), `... and ${left} more strateg${left === 1 ? "y" : "ies"}`];
}
