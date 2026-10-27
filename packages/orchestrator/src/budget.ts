import type { TokenCost } from "@seshat/core";
import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

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
    this.usd += cost.usd;
    this.inputTokens += cost.inputTokens;
    this.outputTokens += cost.outputTokens;
    this.requests += 1;
    this.parent?.charge(cost);
    if (this.exhausted) this.announce();
  }

  get exhausted(): boolean {
    return (this.limitUsd !== undefined && this.usd >= this.limitUsd) || (this.parent?.exhausted ?? false);
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
 * The cost of one model response: the cost the provider reported, or else the one computed from
 * the model's prices (some adapters report no cost). Input tokens include cache reads and writes.
 */
export function messageCost(model: Model<Api>, message: AssistantMessage): TokenCost {
  const usage = message.usage;
  const usd = usage.cost.total > 0 ? usage.cost.total : calculateCost(model, structuredClone(usage)).total;
  return { usd, inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output };
}

/** Prompt size of the request that produced `message`, in tokens. */
export function contextTokens(message: AssistantMessage): number {
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}
