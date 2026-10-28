import { type Beta, betaUpdate, sample, UNIFORM, type RandomSource } from "@seshat/fleet";
import type { SessionRecord } from "./records.ts";

/** What an inner session costs when none has been seen: a guess to start from, replaced by the average as sessions are paid. */
export const PRIOR_SESSION_USD = 0.05;

/**
 * What the problem's inner sessions say about the cost of a proof: the Beta posterior of a session being
 * accepted by Lean (flat until one is seen) and the mean cost of a session.
 */
export interface PriceBook {
  rate: Beta;
  sessionUsd: number;
}

export function priceBook(records: readonly Pick<SessionRecord, "ok" | "usd">[], priorUsd = PRIOR_SESSION_USD): PriceBook {
  let rate: Beta = UNIFORM;
  let total = 0;
  for (const record of records) {
    rate = betaUpdate(rate, record.ok ? 1 : 0);
    total += record.usd;
  }
  return { rate, sessionUsd: records.length === 0 ? priorUsd : total / records.length };
}

/**
 * The price of proving a claim directly, in dollars: the sessions it is expected to take (one over the
 * success rate, drawn from the posterior by Thompson sampling so that a rate nobody has seen is tried, and
 * at most the task's sessions) times what a session costs. The draw is the run's seeded source's.
 */
export function leafPrice(book: PriceBook, random: RandomSource, sessions: number): number {
  const rate = Math.max(sample(random, book.rate), 0.02);
  return book.sessionUsd * Math.min(1 / rate, sessions);
}

/** The weight of a task for the age/weight selection: its price over one plus the value of its lemma (documentation/scheduler.md, "Weight"). */
export function taskWeight(price: number, value: number): number {
  return price / (1 + Math.max(value, 0));
}
