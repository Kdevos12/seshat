import { type LeanChecker, type RandomSource, seeded } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { type BatteryResult, runBattery } from "./battery.ts";
import { BATTERY_RUN, type BatteryRunData, Posteriors, type TryRecord } from "./posterior.ts";
import { primaryDomain, routeStatement } from "./router.ts";
import { availableTactics, type Goal, type HostTactics, hammerAt, type TacticSpec } from "./tactics.ts";

/** A goal that is a claim of the memory: it has an id, so a success can be submitted. */
export interface ClaimGoal extends Goal {
  claimId: string;
}

export interface SolveSettings {
  /** Lean checks at once. */
  parallel: number;
  /** Lean time for the whole battery on a goal, in seconds. */
  cpuBudgetSec: number;
  /** How many wins `validate` may refuse before the battery gives the goal up. */
  maxSubmissions: number;
  /** `thompson` or `mean`. */
  order: "thompson" | "mean";
  /** Premise cutoffs of the hammer (plan change PC6 item 2). Empty: only the plain `hammer`. */
  hammerCutoffs: readonly number[];
  /** Restrict the battery to these tactics (names). */
  only?: readonly string[];
}

export const DEFAULT_SETTINGS: SolveSettings = { parallel: 4, cpuBudgetSec: 60, maxSubmissions: 3, order: "thompson", hammerCutoffs: [16, 64, 256] };

export interface SolveContext {
  checker: LeanChecker;
  memory: MemoryStore;
  validate: (request: ValidateRequest) => Promise<ValidateResult>;
  host: HostTactics;
  settings: SolveSettings;
  /** Seeds the Thompson draws; the run's seed. */
  random: RandomSource;
  signal: AbortSignal;
  log: (text: string) => void;
  attemptId?: string;
}

export interface SolveOutcome {
  /** Some tactic closed the goal and `validate` accepted its proof. */
  settled: boolean;
  /** `validate` accepted a proof, which is `computed` until the certifier replays it. */
  submission?: ValidateResult;
  winner?: { tactic: string; proof: string };
  tries: TryRecord[];
  cpuMs: number;
  domains: string[];
  /** The node that records the run. */
  nodeId: string;
  budgetExhausted: boolean;
}

/** The tactics of a run: what the host has, the hammer at each cutoff in place of the plain one when there are cutoffs. */
export function tacticsFor(host: HostTactics, settings: Pick<SolveSettings, "hammerCutoffs" | "only">): TacticSpec[] {
  const base = availableTactics(host, settings.only === undefined ? undefined : settings.only.map((n) => n.split("@")[0] as string));
  const out: TacticSpec[] = [];
  for (const t of base) {
    if (t.name === "hammer" && settings.hammerCutoffs.length > 0) {
      out.push(t, ...settings.hammerCutoffs.map(hammerAt));
    } else {
      out.push(t);
    }
  }
  return out;
}

/** A seeded random source for a goal, so that the Thompson draws of a run replay. */
export function randomFor(seed: string | number | undefined, salt: string): RandomSource {
  let h = 2166136261;
  for (const c of `${seed ?? ""}\u0000${salt}`) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return seeded(h);
}

/**
 * The battery on a claim (plan §15, steps 3 and 4): the router names the goal's domain, the tactics
 * the host has run in the order of their posteriors under the CPU budget, and a success is submitted
 * through `validate` (never a status of its own). A proof `validate` refuses puts that tactic out and
 * the battery goes on, up to `maxSubmissions` refusals. The run is recorded as a node `battery_run`,
 * which later runs read the posteriors from.
 */
export async function solveGoal(ctx: SolveContext, goal: ClaimGoal): Promise<SolveOutcome> {
  const route = routeStatement(goal.statement);
  const domain = primaryDomain(route);
  const posteriors = Posteriors.from(ctx.memory);
  const tactics = tacticsFor(ctx.host, ctx.settings);
  const tries: TryRecord[] = [];
  const refused = new Set<string>();
  let cpuMs = 0;
  let winner: { tactic: string; proof: string } | undefined;
  let submission: ValidateResult | undefined;
  let last: BatteryResult | undefined;
  let rounds = 0;

  while (rounds < ctx.settings.maxSubmissions + 1 && !ctx.signal.aborted) {
    rounds++;
    const remaining = ctx.settings.cpuBudgetSec - cpuMs / 1000;
    if (remaining < 1) break;
    // The tactics of the router's list that the host has are tried in the posterior order; the router's list is the prior.
    last = await runBattery({
      checker: ctx.checker,
      goal,
      tactics,
      domain,
      posteriors,
      order: { mode: ctx.settings.order, random: ctx.random },
      parallel: ctx.settings.parallel,
      cpuBudgetSec: remaining,
      exclude: new Set([...refused, ...tries.filter((t) => t.outcome === "failed" || t.outcome === "timeout").map((t) => t.tactic)]),
      signal: ctx.signal,
    });
    tries.push(...last.tries);
    cpuMs += last.cpuMs;
    if (last.winner === undefined) break;
    const result = await ctx.validate({ claimId: goal.claimId, proof: last.winner.proof, ...(ctx.attemptId !== undefined ? { attemptId: ctx.attemptId } : {}) });
    if (result.verdict === "valid") {
      winner = last.winner;
      submission = result;
      break;
    }
    ctx.log(`M10: ${last.winner.tactic} closed the goal in Lean but validate refused the proof (${result.reasons[0] ?? "no reason"})`);
    refused.add(last.winner.tactic);
    submission = result;
    winner = undefined;
  }

  const data: BatteryRunData = {
    statement: goal.statement,
    domains: route.domains,
    tries,
    ...(winner !== undefined ? { solved: { tactic: winner.tactic, proof: winner.proof } } : {}),
    ...(submission !== undefined ? { submission: { verdict: submission.verdict, status: submission.status, ...(submission.validationId !== undefined ? { validationId: submission.validationId } : {}), reasons: submission.reasons } } : {}),
    cpuMs,
    budgetSec: ctx.settings.cpuBudgetSec,
  };
  const node = ctx.memory.recordNode({ kind: BATTERY_RUN, claimId: goal.claimId, data: data as never });
  return {
    settled: winner !== undefined,
    ...(submission !== undefined ? { submission } : {}),
    ...(winner !== undefined ? { winner } : {}),
    tries,
    cpuMs,
    domains: route.domains,
    nodeId: node.nodeId,
    budgetExhausted: last?.budgetExhausted ?? false,
  };
}
