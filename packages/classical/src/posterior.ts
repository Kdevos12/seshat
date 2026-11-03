import { type Beta, betaMean, betaUpdate, sample, UNIFORM } from "@seshat/fleet";
import type { RandomSource } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import { DOMAIN_TACTICS, type Domain } from "./router.ts";

/** How one try of the battery ended. `aborted` (another tactic won first) and `error` (Lean did not answer) tell nothing about the tactic. */
export type TryOutcome = "success" | "failed" | "timeout" | "error" | "aborted";

/** One tactic tried on a goal, as the node `battery_run` records it. */
export interface TryRecord {
  tactic: string;
  /** The router's primary domain for the goal: the posteriors are per (domain, tactic). */
  domain: string;
  outcome: TryOutcome;
  /** Lean's time for the try, in milliseconds. */
  timeMs: number;
  /** The tactic text Lean suggested (`Try this: ...`), when it did. */
  suggestion?: string;
}

/** The kind of the node a run of the battery writes, and the shape of its `data`. */
export const BATTERY_RUN = "battery_run";

export interface BatteryRunData {
  /** The goal's statement in signature form. */
  statement: string;
  /** The router's domains for it. */
  domains: string[];
  tries: TryRecord[];
  /** The tactic that closed the goal, and the proof text that was submitted. */
  solved?: { tactic: string; proof: string };
  /** What `validate` said about the submission. */
  submission?: { verdict: "valid" | "invalid"; status?: string; validationId?: string; reasons?: string[] };
  /** Lean time spent, in milliseconds. */
  cpuMs: number;
  /** The budget it ran under, in seconds. */
  budgetSec: number;
  [key: string]: unknown;
}

const key = (domain: string, tactic: string): string => `${domain}\u0000${tactic}`;

/** The counts of the journal: successes and failures per (domain, tactic). */
export class Posteriors {
  readonly #counts = new Map<string, { wins: number; losses: number }>();

  /** Reads every `battery_run` node of the memory: the posteriors are rebuilt from the journal, never kept elsewhere. */
  static from(memory: MemoryStore): Posteriors {
    const p = new Posteriors();
    for (const node of memory.nodes(BATTERY_RUN)) {
      const data = node.data as unknown as BatteryRunData;
      for (const t of data.tries ?? []) p.observe(t);
    }
    return p;
  }

  observe(t: TryRecord): void {
    if (t.outcome === "aborted" || t.outcome === "error") return;
    const k = key(t.domain, t.tactic);
    const c = this.#counts.get(k) ?? { wins: 0, losses: 0 };
    if (t.outcome === "success") c.wins++;
    else c.losses++;
    this.#counts.set(k, c);
  }

  /** The posterior: the router's prior for the domain, plus the counts. */
  beta(domain: string, tactic: string): Beta {
    const prior = priorFor(domain, tactic);
    const c = this.#counts.get(key(domain, tactic));
    return c === undefined ? prior : { alpha: prior.alpha + c.wins, beta: prior.beta + c.losses };
  }

  counts(domain: string, tactic: string): { wins: number; losses: number } {
    return this.#counts.get(key(domain, tactic)) ?? { wins: 0, losses: 0 };
  }
}

/**
 * What the router believes before any observation: the first tactic of a domain's list is likely, the
 * next two somewhat less, the rest of the list is a coin toss, and a tactic the domain does not name is
 * unlikely. A prior is a few pseudo-counts, so that a handful of tries outweighs it.
 */
export function priorFor(domain: string, tactic: string): Beta {
  const list = DOMAIN_TACTICS[domain as Domain];
  if (list === undefined || domain === "general") return UNIFORM;
  const base = tactic.split("@")[0] as string;
  const i = list.indexOf(base);
  if (i < 0) return { alpha: 1, beta: 2 };
  // The router's list is in order of preference, so the prior keeps that order: 3/4, 5/7, 2/3, then a coin toss.
  if (i <= 2) return { alpha: 3 - 0.5 * i, beta: 1 };
  return { alpha: 1.5, beta: 1.5 };
}

export interface OrderOptions {
  /** `thompson` draws from each posterior (the default, exploring); `mean` sorts by the posterior mean. */
  mode?: "thompson" | "mean";
  random?: RandomSource;
}

/**
 * The tactics in the order to try them: by the posterior of (domain, tactic), the draw of Thompson
 * sampling or the mean. Ties keep the order given, which lists the cheap procedures first.
 */
export function orderByPosterior<T extends { name: string }>(tactics: readonly T[], domain: string, posteriors: Posteriors, options: OrderOptions = {}): T[] {
  const mode = options.mode ?? "thompson";
  const random = options.random;
  if (mode === "thompson" && random === undefined) throw new TypeError("Thompson ordering needs a random source");
  const scored = tactics.map((t, i) => {
    const b = posteriors.beta(domain, t.name);
    return { t, i, score: mode === "mean" ? betaMean(b) : sample(random as RandomSource, b) };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.t);
}
