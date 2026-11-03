import type { Journal } from "@seshat/core";
import type { PriceBook } from "./prices.ts";

/**
 * The off-peak option (`--offpeak`, documentation/human.md, "Off-peak"): a turn or a session starts only when
 * the host's pricing calendar says the model's prices are at their off-peak rate, and otherwise waits for the next
 * window. `--offpeak-max-wait` bounds a wait, after which the work runs anyway at the price of the hour. Every wait
 * is a `turn.deferred` event written before it begins.
 */
export interface OffPeakOptions {
  runId: string;
  journal: Journal;
  prices: PriceBook;
  /** `provider/id` of the run's model: its calendar is the one read. */
  model: string;
  /** The longest wait, in minutes; absent: the work waits for the window, however far. */
  maxWaitMinutes?: number;
  /** Waits `ms` milliseconds, or less when the signal aborts. Default: a timer. A test advances its clock here. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

/** What waits. */
export interface OffPeakWait {
  scope: "turn" | "session";
  turn?: number;
  problemId?: string;
  prover?: string;
}

export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class OffPeakGate {
  private readonly o: OffPeakOptions;
  /** The wait in progress, which the sessions that ask meanwhile share. */
  private waiting: { until: number; done: Promise<void> } | undefined;
  /** When a wait ended at the limit: peak prices are accepted until this instant, the next off-peak window. */
  private acceptedUntil = -Infinity;

  constructor(options: OffPeakOptions) {
    this.o = options;
  }

  /** Resolves when the work may start: now when the model's prices are off-peak, else after the wait. */
  async wait(what: OffPeakWait, signal?: AbortSignal): Promise<void> {
    const { prices, model } = this.o;
    const now = prices.now();
    const next = prices.nextOffPeak(model, now);
    // No off-peak instant to wait for, or the run has already accepted this peak: nothing to wait for.
    if (next === undefined || next <= now || now < this.acceptedUntil) return;
    if (this.waiting !== undefined && now < this.waiting.until) return await this.waiting.done;
    const limit = this.o.maxWaitMinutes === undefined ? Infinity : now + this.o.maxWaitMinutes * 60_000;
    const bounded = limit < next;
    const until = bounded ? limit : next;
    this.o.journal.emit(
      "turn.deferred",
      {
        runId: this.o.runId,
        scope: what.scope,
        ...(what.turn !== undefined ? { turn: what.turn } : {}),
        ...(what.problemId !== undefined ? { problemId: what.problemId } : {}),
        ...(what.prover !== undefined ? { prover: what.prover } : {}),
        from: new Date(now).toISOString(),
        nextStart: new Date(next).toISOString(),
        until: new Date(until).toISOString(),
        bounded,
      },
      "orchestrator",
    );
    this.o.log?.(
      `off-peak: the ${what.scope}${what.prover !== undefined ? ` of ${what.prover}` : ""} waits ${((until - now) / 60_000).toFixed(0)} minutes` +
        `${bounded ? ` (the wait limit; the next off-peak window starts at ${new Date(next).toISOString()})` : ` for the window that starts at ${new Date(next).toISOString()}`}`,
    );
    const done = (this.o.sleep ?? sleepFor)(until - now, signal).then(() => {
      if (bounded && signal?.aborted !== true) this.acceptedUntil = next;
      if (this.waiting?.done === done) this.waiting = undefined;
    });
    this.waiting = { until, done };
    await done;
  }
}
