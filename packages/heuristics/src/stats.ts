import type { HarnessEvent, Json } from "@seshat/core";
import { armOf, type DeactivationRule, effectOf, type ItemEffect, shouldDeactivate } from "@seshat/memory";
import { BUILTIN_CARDS } from "./builtin.ts";
import { type HeuristicCard, strategyOfCard } from "./card.ts";

/**
 * What the statistics read of a session: the settings the fleet recorded (`heuristic`, `heuristicRule`,
 * `heuristicFamily`, `heuristicBucket`), its outcome, and the strategy M1 classified from what it submitted.
 * `Attempt` of `@seshat/memory` is one; the report builds them from the journal's events.
 */
export interface CardSession {
  attemptId?: string | undefined;
  settings?: { readonly [key: string]: Json } | undefined;
  outcome?: string | undefined;
  strategy?: string | undefined;
}

/** One card, or one family, against the control of the buckets it was drawn in. */
export interface CardLine {
  /** The card id, or the family. */
  id: string;
  family: string;
  /** The bucket, for a line of one card in one bucket. */
  bucket?: string;
  /** Sessions that were given it and said something (a proof Lean accepted, or a failed check), and how many were `valid`. */
  sessions: number;
  valid: number;
  /**
   * The control sessions (no card, drawn so) of the buckets it was drawn in, and the valid ones standardized to
   * the card's own mix of buckets (each bucket's control rate weighs as the card's sessions there do), so it can be
   * fractional. The effect uses these, and only the card's sessions in buckets that have a control.
   */
  controlSessions: number;
  controlValid: number;
  /** PE2's effect (`effectOf` of `@seshat/memory`): the two Beta posteriors, their difference and P(effect < 0). */
  effect: ItemEffect;
  /** M5's rule on that effect (`shouldDeactivate`): the fleet no longer draws the card in such a bucket. */
  deactivated: boolean;
  /**
   * For a tactic card whose family maps to a strategy label: of its sessions that M1 classified, how many
   * went the card's way (the strategy matches). Absent for a strategy card, a family without a label, or a
   * card the bank no longer has.
   */
  compliance?: { classified: number; matching: number; strategy: string };
}

export interface HeuristicStats {
  /** Sessions with a recorded draw (a card, the control, or none applicable) that said something. */
  sessions: number;
  control: { sessions: number; valid: number };
  /** Finished sessions no card applied to: not the control, counted apart. */
  noneApplicable: number;
  cards: CardLine[];
  families: CardLine[];
  /** Each card in each bucket it was drawn in, against that bucket's control. */
  buckets: CardLine[];
  /**
   * Accepted proofs of sessions given a tactic card whose classified strategy is not the card's (HB5 item 2):
   * the card was drawn, the proof went another way. Listed for a person to read; nothing is inferred from them.
   */
  unexplained: Array<{ attemptId?: string; card: string; bucket: string; strategy: string; expected: string }>;
}

/** M5's defaults (`minObservations` of the lessons, and the threshold of `shouldDeactivate`). */
export const CARD_DEACTIVATION: DeactivationRule = { minObservations: 8, threshold: 0.9 };

const text = (value: Json | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The bank's statistics (plan change HB3 and HB5 items 1 to 3), with no model. A card is set against the
 * control of its own buckets, never against the run's average: the fleet draws cards by bucket, so the
 * control is what the same kind of statement did without a card. The effect is PE2's (two Beta posteriors and
 * P(effect < 0)) and the deactivation M5's rule, the ones the fleet applies; as in PE2, only a proof Lean
 * accepted or a failed check says something. `bank` gives each card's level, for compliance. Unlike the fleet's draw,
 * every session counts once here, with no discount, probation or weight for another model.
 */
export function heuristicStats(sessions: readonly CardSession[], bank: readonly HeuristicCard[] = [], rule: DeactivationRule = CARD_DEACTIVATION): HeuristicStats {
  const byId = new Map(bank.map((card) => [card.id, card]));
  const finished = sessions.filter((s) => (s.outcome === "valid" || s.outcome === "invalid") && text(s.settings?.heuristic) !== undefined);
  // The control sessions of each bucket, with the cards each could have been given (absent: recorded without the list).
  const control = new Map<string, Array<{ valid: number; eligible?: readonly string[] }>>();
  let noneApplicable = 0;
  type Tally = { kind: "card" | "family"; id: string; family: string; bucket?: string; sessions: number; valid: number; buckets: Map<string, { sessions: number; valid: number }>; compliance?: CardLine["compliance"] };
  const cards = new Map<string, Tally>();
  const families = new Map<string, Tally>();
  const perBucket = new Map<string, Tally>();
  const unexplained: HeuristicStats["unexplained"] = [];
  const familyOfSeen = new Map<string, string>();
  const tally = (lines: Map<string, Tally>, key: string, kind: Tally["kind"], id: string, family: string, bucket?: string): Tally => {
    let found = lines.get(key);
    if (found === undefined) {
      found = { kind, id, family, ...(bucket !== undefined ? { bucket } : {}), sessions: 0, valid: 0, buckets: new Map() };
      lines.set(key, found);
    }
    return found;
  };
  for (const s of finished) {
    const id = text(s.settings?.heuristic) as string;
    const bucket = text(s.settings?.heuristicBucket) ?? "unknown";
    const valid = s.outcome === "valid" ? 1 : 0;
    if (id === "none") {
      if (text(s.settings?.heuristicRule) === "control") {
        const list = control.get(bucket) ?? [];
        const eligible = s.settings?.heuristicEligible;
        list.push({ valid, ...(Array.isArray(eligible) ? { eligible: eligible.filter((x): x is string => typeof x === "string") } : {}) });
        control.set(bucket, list);
      } else noneApplicable += 1;
      continue;
    }
    const family = text(s.settings?.heuristicFamily) ?? byId.get(id)?.family ?? "unknown";
    familyOfSeen.set(id, family);
    for (const t of [tally(cards, id, "card", id, family), tally(families, family, "family", family, family), tally(perBucket, `${id}\u0000${bucket}`, "card", id, family, bucket)]) {
      t.sessions += 1;
      t.valid += valid;
      const b = t.buckets.get(bucket) ?? { sessions: 0, valid: 0 };
      b.sessions += 1;
      b.valid += valid;
      t.buckets.set(bucket, b);
    }
    const card = byId.get(id);
    const strategy = card === undefined ? undefined : strategyOfCard(card);
    if (strategy !== undefined) {
      const t = cards.get(id) as Tally;
      t.compliance ??= { classified: 0, matching: 0, strategy };
      if (s.strategy !== undefined) {
        t.compliance.classified += 1;
        if (s.strategy === strategy) t.compliance.matching += 1;
        else if (valid === 1) unexplained.push({ ...(s.attemptId !== undefined ? { attemptId: s.attemptId } : {}), card: id, bucket, strategy: s.strategy, expected: strategy });
      }
    }
  }
  const lines = (tallies: Map<string, Tally>): CardLine[] =>
    [...tallies.values()]
      .map((t): CardLine => {
        // The control is standardized to the card's own mix of buckets: each bucket's control rate weighs as the card's
        // sessions there do, and the control keeps its number of observations. Pooling the control sessions of every bucket
        // instead would set a card drawn mostly in hard buckets against the easy buckets' control. Buckets with no control
        // session say nothing of the effect and are left out of both arms.
        // A control session counts for a card only when the card was among those it could have been given (the same
        // eligibility terms), and for a family when one of the family's cards was.
        const counts = (bucket: string): { sessions: number; valid: number } => {
          const list = (control.get(bucket) ?? []).filter(
            (c) => c.eligible === undefined || (t.kind === "card" ? c.eligible.includes(t.id) : c.eligible.some((x) => (byId.get(x)?.family ?? familyOfSeen.get(x)) === t.id)),
          );
          return { sessions: list.length, valid: list.reduce((n, c) => n + c.valid, 0) };
        };
        let controlSessions = 0;
        let controlValid = 0;
        let compared = 0;
        let comparedValid = 0;
        const covered = [...t.buckets].map(([bucket, b]) => ({ b, c: counts(bucket) })).filter(({ c }) => c.sessions > 0);
        for (const { b, c } of covered) {
          controlSessions += c.sessions;
          compared += b.sessions;
          comparedValid += b.valid;
        }
        for (const { b, c } of covered) controlValid += (b.sessions / compared) * (c.valid / c.sessions) * controlSessions;
        const effect = effectOf(
          t.id,
          {},
          armOf(comparedValid, compared - comparedValid, compared),
          armOf(controlValid, controlSessions - controlValid, controlSessions),
        );
        return {
          id: t.id,
          family: t.family,
          ...(t.bucket !== undefined ? { bucket: t.bucket } : {}),
          sessions: t.sessions,
          valid: t.valid,
          controlSessions,
          controlValid: Math.round(controlValid * 100) / 100,
          effect,
          deactivated: shouldDeactivate(effect, rule),
          ...(t.compliance !== undefined ? { compliance: t.compliance } : {}),
        };
      })
      .sort((a, b) => b.sessions - a.sessions || (a.id < b.id ? -1 : a.id > b.id ? 1 : (a.bucket ?? "") < (b.bucket ?? "") ? -1 : 1));
  const controls = [...control.values()].flat();
  const all = { sessions: controls.length, valid: controls.reduce((n, c) => n + c.valid, 0) };
  return { sessions: finished.length, control: all, noneApplicable, cards: lines(cards), families: lines(families), buckets: lines(perBucket), unexplained };
}

/** Under this many sessions, a line says that it is too few to read anything from. */
export const FEW_SESSIONS = 10;

const share = (n: number, d: number): string => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);

/** One line of the statistics, as the report and `harness heuristics stats` print it. */
export function renderCardLine(l: CardLine): string {
  const compliance =
    l.compliance === undefined ? "" : `; went the card's way (${l.compliance.strategy}) in ${l.compliance.matching} of ${l.compliance.classified} classified`;
  const few = l.sessions < FEW_SESSIONS || l.controlSessions < FEW_SESSIONS ? " (too few to read)" : "";
  const off = l.deactivated ? "; deactivated (P(effect < 0) above 0.9)" : "";
  const where = l.bucket !== undefined ? ` in ${l.bucket}` : "";
  return (
    `${l.id}${where}: ${l.valid} of ${l.sessions} valid (${share(l.valid, l.sessions)}), control of its buckets ${l.controlValid} of ${l.controlSessions} ` +
    `(${share(l.controlValid, l.controlSessions)}), P(effect < 0) ${l.effect.pNegative.toFixed(2)}${compliance}${off}${few}`
  );
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
      if (settings !== undefined && typeof settings.heuristic === "string") sessions.set(event.data.attemptId, { attemptId: event.data.attemptId, settings });
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
    `Heuristic cards: ${stats.sessions} session(s) with a draw and a verdict; the control (no card) ${stats.control.valid} of ${stats.control.sessions} valid.${none} ` +
    `By family, each against the control of the buckets it was drawn in: ${families || "none"}. ` +
    "The effect is PE2's (P(effect < 0) from two Beta posteriors) and a family is read against its own buckets, never the run's average; " +
    "at a 30% base rate a 10-point effect needs about 350 sessions per arm (harness heuristics stats gives each card, harness heuristics mine the proposals)."
  );
}

/** A change to the bank that the statistics suggest (HB5 item 1), for a person to make or not. */
export interface BankProposal {
  kind: "retire" | "when_not" | "no_effect";
  card: string;
  /** The bucket a `when_not` is about (`msc:11|forall_nat+inequality`). */
  bucket?: string;
  reason: string;
  difference: number;
  pNegative: number;
  sessions: number;
  controlSessions: number;
}

/** A card with this many times the minimum of observations on each side whose P(effect < 0) stays near one half has shown no effect. */
export const NO_EFFECT_FACTOR = 4;

/**
 * What `harness heuristics mine` proposes, from the statistics alone and with no model (HB5 item 1): retire a
 * card deactivated across its buckets; add a `whenNot` for a bucket where the card is deactivated while it is not
 * elsewhere; mark a card that has shown no effect after many observations. A proposal changes nothing: a person
 * edits the card (built in, through a reviewed commit; from a pack, through a new version of the pack).
 */
export function bankProposals(stats: HeuristicStats, rule: DeactivationRule = CARD_DEACTIVATION): BankProposal[] {
  const numbers = (l: CardLine) => ({ difference: Math.round(l.effect.difference * 1000) / 1000, pNegative: Math.round(l.effect.pNegative * 1000) / 1000, sessions: l.sessions, controlSessions: l.controlSessions });
  const proposals: BankProposal[] = [];
  const retired = new Set<string>();
  for (const l of stats.cards) {
    if (l.deactivated) {
      retired.add(l.id);
      proposals.push({ kind: "retire", card: l.id, reason: "P(effect < 0) above the threshold across its buckets: the fleet no longer draws it", ...numbers(l) });
    } else if (l.sessions >= NO_EFFECT_FACTOR * rule.minObservations && l.controlSessions >= NO_EFFECT_FACTOR * rule.minObservations && l.effect.pNegative > 0.4 && l.effect.pNegative < 0.6) {
      proposals.push({ kind: "no_effect", card: l.id, reason: `no measurable effect after ${l.sessions} sessions against ${l.controlSessions} in the control`, ...numbers(l) });
    }
  }
  for (const l of stats.buckets) {
    if (!l.deactivated || retired.has(l.id) || l.bucket === undefined) continue;
    proposals.push({ kind: "when_not", card: l.id, bucket: l.bucket, reason: `it loses against the control in ${l.bucket} only: a whenNot on that domain or those features`, ...numbers(l) });
  }
  return proposals;
}
