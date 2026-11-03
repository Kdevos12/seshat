import type { LeanChecker } from "@seshat/core";
import { runBattery } from "./battery.ts";
import { Posteriors } from "./posterior.ts";
import { primaryDomain, routeStatement } from "./router.ts";
import { availableTactics, type Goal, type HostTactics } from "./tactics.ts";

export interface TrivialityOptions {
  /** Lean time the cheap tactics may spend together, in seconds. Default 10. */
  cpuBudgetSec?: number;
  /** What the host's Lean has; the cheapest tactics need nothing extra. */
  host?: HostTactics;
  parallel?: number;
  signal?: AbortSignal;
}

export interface Triviality {
  /** The cheapest tactics close the goal within the budget. */
  trivial: boolean;
  /** The tactic that did, with the proof text it would be submitted as. */
  tactic?: string;
  proof?: string;
  cpuMs: number;
}

/**
 * The non-triviality test (Ruling 25): do the battery's cheapest tactics (cost class 1: `decide`,
 * `omega`, `norm_num`, `simp`, `ring`, `linarith`, `positivity`) close this goal within this CPU
 * budget? Tasks 9 and 13 call it without line M10 being on: it needs only a Lean checker. It
 * submits nothing and records nothing, and it never says a goal is hard, only that these did not
 * close it in time.
 */
export async function closesWithCheapTactics(checker: LeanChecker, goal: Goal, options: TrivialityOptions = {}): Promise<Triviality> {
  const tactics = availableTactics(options.host ?? { have: new Set() }).filter((t) => t.cost === 1);
  const domain = primaryDomain(routeStatement(goal.statement));
  const result = await runBattery({
    checker,
    goal,
    tactics,
    domain,
    posteriors: new Posteriors(),
    order: { mode: "mean" },
    parallel: options.parallel ?? 4,
    cpuBudgetSec: options.cpuBudgetSec ?? 10,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return result.winner === undefined
    ? { trivial: false, cpuMs: result.cpuMs }
    : { trivial: true, tactic: result.winner.tactic, proof: result.winner.proof, cpuMs: result.cpuMs };
}
