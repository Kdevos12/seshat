import type { HarnessEvent, Json } from "@seshat/core";
import { BUILTIN_CARDS } from "./builtin.ts";
import { type HeuristicCard, strategyOfCard } from "./card.ts";

/**
 * What the statistics read of a session: the settings the fleet recorded (`heuristic`, `heuristicRule`,
 * `heuristicFamily`, `heuristicBucket`), its outcome, and the strategy M1 classified from what it submitted.
 * `Attempt` of `@seshat/memory` is one; the report builds them from the journal's events.
 */
export interface CardSession {
  settings?: { readonly [key: string]: Json } | undefined;
  outcome?: string | undefined;
  strategy?: string | undefined;
}

/** One card, or one family, against the control of the buckets it was drawn in. */
export interface CardLine {
  /** The card id, or the family. */
  id: string;
  family: string;
  /** Finished sessions that were given it, and how many of them Lean accepted (`valid`). */
  sessions: number;
  valid: number;
  /** The finished control sessions (no card, drawn so) of the buckets it was drawn in, and how many were valid. */
  controlSessions: number;
  controlValid: number;
  /**
   * For a tactic card whose family maps to a strategy label: of its sessions that M1 classified, how many
   * went the card's way (the strategy matches). Absent for a strategy card, a family without a label, or a
   * card the bank no longer has.
   */
  compliance?: { classified: number; matching: number; strategy: string };
}

export interface HeuristicStats {
  /** Finished sessions with a recorded draw (a card, the control, or none applicable). */
  sessions: number;
  control: { sessions: number; valid: number };
  /** Finished sessions no card applied to: not the control, counted apart. */
  noneApplicable: number;
  cards: CardLine[];
  families: CardLine[];
}

const text = (value: Json | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The bank's statistics over finished sessions (plan change HB5): counts only, no model, no test of
 * significance. A card is set against the control of its own buckets, never against the run's average:
 * the fleet draws cards by bucket, so the control is what the same kind of statement did without a card.
 * `bank` gives each card's level, for compliance; without it, compliance is left out.
 */
export function heuristicStats(sessions: readonly CardSession[], bank: readonly HeuristicCard[] = []): HeuristicStats {
  const byId = new Map(bank.map((card) => [card.id, card]));
  const finished = sessions.filter((s) => s.outcome !== undefined && text(s.settings?.heuristic) !== undefined);
  const control = new Map<string, { sessions: number; valid: number }>();
  let noneApplicable = 0;
  const cardBuckets = new Map<string, Set<string>>();
  const familyBuckets = new Map<string, Set<string>>();
  const cards = new Map<string, CardLine>();
  const families = new Map<string, CardLine>();
  const line = (lines: Map<string, CardLine>, id: string, family: string): CardLine => {
    let found = lines.get(id);
    if (found === undefined) {
      found = { id, family, sessions: 0, valid: 0, controlSessions: 0, controlValid: 0 };
      lines.set(id, found);
    }
    return found;
  };
  for (const s of finished) {
    const id = text(s.settings?.heuristic) as string;
    const bucket = text(s.settings?.heuristicBucket) ?? "unknown";
    const valid = s.outcome === "valid" ? 1 : 0;
    if (id === "none") {
      if (text(s.settings?.heuristicRule) === "control") {
        const c = control.get(bucket) ?? { sessions: 0, valid: 0 };
        c.sessions += 1;
        c.valid += valid;
        control.set(bucket, c);
      } else noneApplicable += 1;
      continue;
    }
    const family = text(s.settings?.heuristicFamily) ?? byId.get(id)?.family ?? "unknown";
    for (const [lines, key, buckets] of [[cards, id, cardBuckets], [families, family, familyBuckets]] as const) {
      const l = line(lines, key, family);
      l.sessions += 1;
      l.valid += valid;
      const set = buckets.get(key) ?? new Set<string>();
      set.add(bucket);
      buckets.set(key, set);
    }
    const card = byId.get(id);
    const strategy = card === undefined ? undefined : strategyOfCard(card);
    if (strategy !== undefined) {
      const l = line(cards, id, family);
      l.compliance ??= { classified: 0, matching: 0, strategy };
      if (s.strategy !== undefined) {
        l.compliance.classified += 1;
        if (s.strategy === strategy) l.compliance.matching += 1;
      }
    }
  }
  const withControl = (lines: Map<string, CardLine>, buckets: Map<string, Set<string>>): CardLine[] =>
    [...lines.values()]
      .map((l) => {
        for (const bucket of buckets.get(l.id) ?? []) {
          l.controlSessions += control.get(bucket)?.sessions ?? 0;
          l.controlValid += control.get(bucket)?.valid ?? 0;
        }
        return l;
      })
      .sort((a, b) => b.sessions - a.sessions || (a.id < b.id ? -1 : 1));
  const all = [...control.values()].reduce((sum, c) => ({ sessions: sum.sessions + c.sessions, valid: sum.valid + c.valid }), { sessions: 0, valid: 0 });
  return { sessions: finished.length, control: all, noneApplicable, cards: withControl(cards, cardBuckets), families: withControl(families, familyBuckets) };
}

/** Under this many sessions, a line says that it is too few to read anything from. */
export const FEW_SESSIONS = 10;

const share = (n: number, d: number): string => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);

/** One line of the statistics, as the report and `harness heuristics stats` print it. */
export function renderCardLine(l: CardLine): string {
  const compliance =
    l.compliance === undefined ? "" : `; went the card's way (${l.compliance.strategy}) in ${l.compliance.matching} of ${l.compliance.classified} classified`;
  const few = l.sessions < FEW_SESSIONS || l.controlSessions < FEW_SESSIONS ? " (too few to read)" : "";
  return `${l.id}: ${l.valid} of ${l.sessions} valid (${share(l.valid, l.sessions)}), control of its buckets ${l.controlValid} of ${l.controlSessions} (${share(l.controlValid, l.controlSessions)})${compliance}${few}`;
}

/**
 * The bank's statistics of a run, from its journal: the sessions whose `attempt.started` recorded a draw,
 * with the outcome and the classified strategy of their `attempt.finished`. Compliance is read for the
 * built-in cards (a pack's card's level is in the pack, not in the journal). Undefined when no session
 * recorded a draw: the run had the bank off.
 */
export function heuristicReport(events: readonly HarnessEvent[], bank: readonly HeuristicCard[] = BUILTIN_CARDS): HeuristicStats | undefined {
  const sessions = new Map<string, CardSession>();
  for (const event of events) {
    if (event.type === "attempt.started") {
      const settings = event.data.settings;
      if (settings !== undefined && typeof settings.heuristic === "string") sessions.set(event.data.attemptId, { settings });
    } else if (event.type === "attempt.finished") {
      const s = sessions.get(event.data.attemptId);
      if (s !== undefined) {
        s.outcome = event.data.outcome;
        s.strategy = event.data.strategy;
      }
    }
  }
  if (sessions.size === 0) return undefined;
  return heuristicStats([...sessions.values()], bank);
}

/** The report's paragraph: the control, then each family against the control of its buckets. */
export function renderHeuristicReport(stats: HeuristicStats): string {
  const families = stats.families.map(renderCardLine).join("; ");
  const none = stats.noneApplicable > 0 ? ` ${stats.noneApplicable} session(s) had no card that applied.` : "";
  return (
    `Heuristic cards: ${stats.sessions} finished session(s) with a draw; the control (no card) ${stats.control.valid} of ${stats.control.sessions} valid.${none} ` +
    `By family, each against the control of the buckets it was drawn in: ${families || "none"}. ` +
    "Counts only: no test of significance, and a family is read against its own buckets, never the run's average (harness heuristics stats gives each card)."
  );
}
