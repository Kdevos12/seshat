import type { AttemptRow, TokenCost } from "@seshat/core";
import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { priceUsage } from "@seshat/registry";
import type { PriceBook } from "./prices.ts";

/**
 * Spending of a run, of one problem, or of one session. A charge counts in every ancestor, and a
 * ledger is exhausted as soon as it or an ancestor has reached its limit.
 */
export class Ledger {
  readonly limitUsd: number | undefined;
  readonly parent: Ledger | undefined;
  usd = 0;
  inputTokens = 0;
  outputTokens = 0;
  requests = 0;
  private readonly listeners: Array<() => void> = [];
  private readonly observers: Array<(cost: TokenCost) => void> = [];
  private announced = false;

  constructor(limitUsd?: number, parent?: Ledger) {
    if (limitUsd !== undefined && !(limitUsd >= 0)) throw new Error(`budget must be a non-negative number, got ${limitUsd}`);
    this.limitUsd = limitUsd;
    this.parent = parent;
    parent?.onExhausted(() => this.announce());
  }

  child(limitUsd?: number): Ledger {
    return new Ledger(limitUsd, this);
  }

  /**
   * Sets what this ledger has already spent, from the journal's account of it, when a run is
   * resumed (documentation/ledger.md, "Resume"). It sets this ledger's own counters and does not
   * charge its ancestors, whose accounts are the journal's too. A ledger that this spend exhausts
   * is exhausted at once.
   */
  seed(spent: { usd: number; inputTokens: number; outputTokens: number; requests: number }): void {
    this.usd = spent.usd;
    this.inputTokens = spent.inputTokens;
    this.outputTokens = spent.outputTokens;
    this.requests = spent.requests;
    if (this.exhausted) this.announce();
  }

  charge(cost: TokenCost): void {
    for (const observer of this.observers) observer(cost);
    this.usd += cost.usd;
    this.inputTokens += cost.inputTokens;
    this.outputTokens += cost.outputTokens;
    this.requests += 1;
    this.parent?.charge(cost);
    if (this.exhausted) this.announce();
  }

  /**
   * Told of every charge to this ledger, which is every charge to it or to a ledger below it. The
   * run's ledger is told of all the spending of the run: a turn counts its limit with it.
   */
  observe(observer: (cost: TokenCost) => void): void {
    this.observers.push(observer);
  }

  get exhausted(): boolean {
    return (this.limitUsd !== undefined && this.usd >= this.limitUsd) || (this.parent?.exhausted ?? false);
  }

  /** Whether a charge of `usd` would leave this ledger or an ancestor exhausted: true for one that already is. */
  wouldExhaust(usd: number): boolean {
    return (this.limitUsd !== undefined && this.usd + usd >= this.limitUsd) || (this.parent?.wouldExhaust(usd) ?? false);
  }

  /** Called once, when this ledger or an ancestor becomes exhausted. */
  onExhausted(listener: () => void): void {
    if (this.announced) listener();
    else this.listeners.push(listener);
  }

  private announce(): void {
    if (this.announced) return;
    this.announced = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

/**
 * The cost of one model response. With the host's prices for the model (`prices`), the dollars are the
 * table's: cache-hit, cache-miss and output tokens at their own prices, times the off-peak multiplier when the
 * instant is off-peak (documentation/m0-loop.md, "Prices"). Without them, the cost the provider reported, or else the one computed from
 * pi-ai's prices for the model (some adapters report no cost). Input tokens include cache reads and writes; the
 * cache reads are also given apart, when there are some, as `cachedInputTokens`, with the dollars they saved
 * against a price with no cache as `savedUsd`.
 */
export function messageCost(model: Model<Api>, message: AssistantMessage, prices?: PriceBook): TokenCost {
  const usage = message.usage;
  const pricing = prices?.pricingOf(model);
  let usd: number;
  let savedUsd: number;
  let offPeak = false;
  if (pricing !== undefined) {
    const priced = priceUsage(pricing, usage, prices?.now() ?? Date.now());
    usd = priced.usd;
    savedUsd = priced.savedUsd;
    offPeak = priced.offPeak;
  } else {
    usd = usage.cost.total > 0 ? usage.cost.total : calculateCost(model, structuredClone(usage)).total;
    // pi-ai's table: a cache read costs `cacheRead` per million where a miss costs `input`.
    // Net of the write premium, as the table's.
    savedUsd = (usage.cacheRead * (model.cost.input - model.cost.cacheRead) - usage.cacheWrite * (model.cost.cacheWrite - model.cost.input)) / 1e6;
  }
  return {
    usd,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cachedInputTokens: usage.cacheRead } : {}),
    ...(savedUsd !== 0 ? { savedUsd } : {}),
    ...(offPeak && usd > 0 ? { offPeakUsd: usd } : {}),
    // The table wins over a reported cost, so that a corrected price is the price; the difference is kept for the report.
    ...(pricing !== undefined && usage.cost.total > usd + 1e-12 ? { unchargedUsd: usage.cost.total - usd } : {}),
  };
}

/** Prompt size of the request that produced `message`, in tokens. */
export function contextTokens(message: AssistantMessage): number {
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

/**
 * What an attempt has been charged so far, as the totals of its `attempt.finished`: the sums of its
 * `attempt.charged` events. The end of a session that did not finish (the process ended, or the
 * harness failed in it) is written at these totals, so that what it spent stays counted. An attempt
 * the journal does not know has been charged nothing.
 */
export function chargedTotals(attempt: Pick<AttemptRow, "charged_usd" | "charged_input_tokens" | "charged_output_tokens" | "charged_requests"> | undefined): {
  turns: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
} {
  return {
    turns: attempt?.charged_requests ?? 0,
    usd: attempt?.charged_usd ?? 0,
    inputTokens: attempt?.charged_input_tokens ?? 0,
    outputTokens: attempt?.charged_output_tokens ?? 0,
  };
}
