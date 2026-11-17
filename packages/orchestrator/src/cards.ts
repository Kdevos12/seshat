import type { HarnessEvent, Json } from "@seshat/core";
import { eligibleCards, heuristicSection, packCardsOf } from "@seshat/fleet";
import { type BankCard, bankOf, bucketOf, statementFeatures } from "@seshat/heuristics";

/**
 * Heuristic cards in `solve` (plan change PA7, documentation/heuristics.md, "Cards in solve"): once per problem, before the first outer session, the
 * harness picks at most `max` cards of the bank from the statement's model-free features, and the outer prover's first briefing carries each as the
 * fleet's sessions do (`heuristicSection`). No model call, no draw: the control is the arm without cards.
 */
export interface CardsConfig {
  /** The most cards shown to the first session of a problem; default 1. */
  max?: number;
}

export const DEFAULT_MAX_CARDS = 1;

export const MAX_CARDS = 5;

export function checkCards(config: CardsConfig): string[] {
  const max = config.max ?? DEFAULT_MAX_CARDS;
  return Number.isInteger(max) && max >= 1 && max <= MAX_CARDS ? [] : [`cards.max must be a whole number from 1 to ${MAX_CARDS}, got ${String(config.max)}`];
}

export interface SolveCards {
  cards: BankCard[];
  /** The sections of the first briefing, one for each card. */
  sections: Array<{ title: string; text: string }>;
  /** What the session's `attempt.started` records, as the fleet records a card shown: `heuristic`, `heuristicRule`, `heuristicBucket`, `heuristicFamily`. */
  settings: { [key: string]: Json };
}

/**
 * The cards of a statement: the bank's cards that key on the statement's features and whose condition holds, the best match first, at most `max`. Undefined when none applies (the session gets no card and records none).
 */
export function solveCards(registry: unknown, statement: string, domains: readonly string[], config: CardsConfig): SolveCards | undefined {
  const bank = bankOf(packCardsOf(registry));
  const features = statementFeatures(statement);
  // Cards that key on the statement's features (a card with no such condition holds for every statement and says nothing of this one), the one that
  // matches the most features first, then the bank's order.
  const keyed = (card: BankCard): number => (card.when?.features?.length ?? 0) + (card.when?.anyFeatures?.filter((f) => features.includes(f)).length ?? 0);
  const picked = eligibleCards(bank, { domains, features, attempts: 0, depthStuck: 0, mode: "standard" }, undefined)
    .filter((card) => keyed(card) > 0)
    .map((card, order) => ({ card, order, score: keyed(card) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.card)
    .slice(0, config.max ?? DEFAULT_MAX_CARDS);
  const first = picked[0];
  if (first === undefined) return undefined;
  return {
    cards: picked,
    sections: picked.map((card) => heuristicSection(card)),
    settings: {
      heuristic: first.id,
      heuristicRule: "solve",
      heuristicBucket: bucketOf(domains, features),
      heuristicFamily: first.family,
      ...(picked.length > 1 ? { heuristicCards: picked.map((card) => card.id) } : {}),
    },
  };
}

/** What a run with `RunConfig.cards` showed, and how the problems with and without a card ended (read by the report, from the journal alone). */
export interface CardsShown {
  /** Cards shown in first briefings. */
  shown: number;
  /** Problems whose first session carried a card, and how many of them were certified (`proved` or `refuted`). */
  withCard: { problems: number; certified: number };
  /** The other problems of the run, and how many were certified. */
  withoutCard: { problems: number; certified: number };
}

/** The cards a run showed in `solve` (`heuristicRule: "solve"` on a session), or undefined when it showed none and had the option off. */
export function cardsShown(events: readonly HarnessEvent[]): CardsShown | undefined {
  const started = events.find((e) => e.type === "run.started");
  const on = started?.type === "run.started" && typeof (started.data.config as { cards?: unknown } | null)?.cards === "object";
  const problemOfClaim = new Map<string, string>();
  const claimStatus = new Map<string, string>();
  const carded = new Set<string>();
  let shown = 0;
  for (const e of events) {
    if (e.type === "problem.registered") problemOfClaim.set(e.data.claimId, e.data.problemId);
    else if (e.type === "claim.status_changed") claimStatus.set(e.data.claimId, e.data.to);
  }
  for (const e of events) {
    if (e.type !== "attempt.started" || e.data.settings?.heuristicRule !== "solve") continue;
    const list = e.data.settings.heuristicCards;
    shown += Array.isArray(list) ? list.length : 1;
    const problemId = problemOfClaim.get(e.data.claimId);
    if (problemId !== undefined) carded.add(problemId);
  }
  if (!on && shown === 0) return undefined;
  const tally = (withCard: boolean) => {
    const ids = [...problemOfClaim].filter(([, problemId]) => carded.has(problemId) === withCard);
    return { problems: ids.length, certified: ids.filter(([claimId]) => ["proved", "refuted"].includes(claimStatus.get(claimId) ?? "")).length };
  };
  return { shown, withCard: tally(true), withoutCard: tally(false) };
}

export function renderCardsShown(c: CardsShown): string {
  return `Cards in solve: ${c.shown} shown; problems with a card: ${c.withCard.certified} of ${c.withCard.problems} certified; without: ${c.withoutCard.certified} of ${c.withoutCard.problems}. (A card is a method of reasoning, never a status.)`;
}
