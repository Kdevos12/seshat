import { assertLeanSafe } from "./screen.ts";
import type { LeanChecker } from "@seshat/core";
import { type Goal, snippetFor, succeeded, suggestion, type TacticSpec } from "./tactics.ts";
import { orderByPosterior, type OrderOptions, type Posteriors, type TryRecord } from "./posterior.ts";

/** The tactic that closed a goal and the proof text to submit for it. */
export interface Winner {
  tactic: string;
  /** What `validate` takes as the proof: the suggestion Lean printed, else the tactic. */
  proof: string;
}

export interface BatteryResult {
  /** The tries that ran, in the order they finished. */
  tries: TryRecord[];
  /** The first tactic that closed the goal. */
  winner?: Winner;
  /** Lean time spent, in milliseconds. */
  cpuMs: number;
  /** Tactics that were not tried because the budget was spent or the battery stopped. */
  skipped: string[];
  budgetExhausted: boolean;
}

export interface BatteryOptions {
  checker: LeanChecker;
  goal: Goal;
  /** The tactics to try: the ones the host has. */
  tactics: readonly TacticSpec[];
  /** The router's primary domain: the posteriors are per (domain, tactic). */
  domain: string;
  posteriors: Posteriors;
  order?: OrderOptions;
  /** At most this many Lean checks at once. Default 4. */
  parallel?: number;
  /** The most Lean time the battery may spend, in seconds, summed over its parallel tries. */
  cpuBudgetSec: number;
  /** Tactics left out (a proof of theirs was refused by `validate`). */
  exclude?: ReadonlySet<string>;
  signal?: AbortSignal;
}

const MIN_TRY_MS = 1000;

/**
 * The battery on one goal (plan §15, step 4): the tactics in the order of their posteriors, a few at
 * a time, each with a short time limit, until one closes the goal or the CPU budget is spent. The
 * first success stops the others (their Lean checks are aborted and recorded as `aborted`, which
 * tells the posteriors nothing). The checks are tool runs of `lean.check` when the checker is the
 * registry's. A success is no proof yet: the caller submits it through `validate`.
 */
export async function runBattery(options: BatteryOptions): Promise<BatteryResult> {
  assertLeanSafe(options.goal.statement, "the statement");
  const tactics = options.tactics.filter((t) => !options.exclude?.has(t.name));
  const queue = orderByPosterior(tactics, options.domain, options.posteriors, options.order);
  const budgetMs = options.cpuBudgetSec * 1000;
  const parallel = Math.max(1, options.parallel ?? 4);
  const stop = new AbortController();
  const onOuterAbort = (): void => stop.abort();
  if (options.signal?.aborted) stop.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const tries: TryRecord[] = [];
  let winner: Winner | undefined;
  let spentMs = 0;
  let reservedMs = 0;
  let next = 0;
  let exhausted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop.signal.aborted || winner !== undefined) return;
      const spec = queue[next];
      if (spec === undefined) return;
      const remainingMs = budgetMs - spentMs - reservedMs;
      if (remainingMs < MIN_TRY_MS) {
        // Reserved time may still come back unspent, so wait for the other workers before giving up.
        if (reservedMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        exhausted = true;
        return;
      }
      next++;
      const timeoutSec = Math.max(1, Math.min(spec.timeoutSec, Math.floor(remainingMs / 1000)));
      reservedMs += timeoutSec * 1000;
      const started = Date.now();
      let record: TryRecord;
      try {
        const [result] = await options.checker.check([{ id: `m10:${spec.name}`, code: snippetFor(options.goal, spec.script) }], { timeoutSec, signal: stop.signal });
        const used = Math.max(result?.timeMs ?? 0, 0);
        const text = result === undefined ? undefined : suggestion(result);
        let outcome: TryRecord["outcome"];
        if (result === undefined || stop.signal.aborted && !succeeded(result)) outcome = "aborted";
        else if (succeeded(result)) outcome = "success";
        else if (result.status === "timeout") outcome = "timeout";
        else if (result.status === "server_error" || result.status === "repl_error") outcome = "error";
        else outcome = "failed";
        record = { tactic: spec.name, domain: options.domain, outcome, timeMs: used > 0 ? used : Date.now() - started, ...(outcome === "success" && spec.suggests && text !== undefined ? { suggestion: text } : {}) };
      } catch (error) {
        if (!stop.signal.aborted) throw error;
        record = { tactic: spec.name, domain: options.domain, outcome: "aborted", timeMs: Date.now() - started };
      }
      reservedMs -= timeoutSec * 1000;
      spentMs += record.timeMs;
      tries.push(record);
      if (record.outcome === "success" && winner === undefined) {
        winner = { tactic: spec.name, proof: record.suggestion ?? spec.script };
        stop.abort();
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
  const tried = new Set(tries.map((t) => t.tactic));
  return {
    tries,
    ...(winner !== undefined ? { winner } : {}),
    cpuMs: spentMs,
    skipped: queue.filter((t) => !tried.has(t.name)).map((t) => t.name),
    budgetExhausted: exhausted && winner === undefined,
  };
}
