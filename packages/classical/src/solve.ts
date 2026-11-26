import { type LeanChecker, type RandomSource, seeded } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { type BatteryResult, runBattery } from "./battery.ts";
import { applicableCertificates, type CertificateNote, type CertificateSettings, runCertificates } from "./certificates.ts";
import type { ComputeTool } from "./compute.ts";
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
  /**
   * The certificate stage (plan change CX4, `certificates.ts`) after the tactics, on a goal the router tags E6;
   * absent: no stage. Its tries share the budget, the submissions and the `battery_run` node with the tactics'.
   */
  certificates?: CertificateSettings;
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
  /** The host's compute tool, for the certificate stage's (b) and (c); absent: they are skipped and say so. */
  compute?: ComputeTool;
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
  /** Absent when an abort cut the run short: nothing is recorded, so that a resumed run does the goal again. */
  nodeId?: string;
  budgetExhausted: boolean;
  /** Why each certificate method gave nothing, when the stage ran. */
  certificates?: CertificateNote[];
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
 * the battery goes on, up to `maxSubmissions` refusals. On a goal the router tags E6, with `certificates`
 * set, the certificate stage (plan change CX4) follows the tactics under the same budget; when one of its
 * methods can take the goal (`applicableCertificates`), it keeps `reserveSec` (at most half) for itself, and
 * what it leaves of it goes back to the tactics the reserve cut short. Its candidates reach `validate` the
 * same way. The run is recorded as a node `battery_run`, which later runs read the posteriors from.
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
  /** Proofs handed to `validate`, the tactics' and the stage's: at most `maxSubmissions + 1`. */
  let submitted = 0;
  const certificates = ctx.settings.certificates !== undefined && route.moves.includes("E6") ? ctx.settings.certificates : undefined;
  // The reserve is kept only for a goal some method can take: a pure test of the goal's shape, with no compute call.
  const reserved = certificates !== undefined && applicableCertificates(goal.statement, certificates.methods, ctx.compute !== undefined).length > 0;
  const reserveSec = reserved ? Math.min(certificates.reserveSec, ctx.settings.cpuBudgetSec / 2) : 0;

  /** Battery rounds until a success `validate` accepts, a refusal too many, or `budgetSec` of the run's time is spent. */
  const tacticRounds = async (budgetSec: number): Promise<void> => {
    while (submitted < ctx.settings.maxSubmissions + 1 && !ctx.signal.aborted) {
      const remaining = budgetSec - cpuMs / 1000;
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
      submitted++;
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
  };
  await tacticRounds(ctx.settings.cpuBudgetSec - reserveSec);
  const cutByReserve = reserveSec > 0 && last?.budgetExhausted === true;

  let notes: CertificateNote[] | undefined;
  if (certificates !== undefined && winner === undefined && !ctx.signal.aborted) {
    // Every refusal so far was a tactic's; the stage may submit what is left of `maxSubmissions + 1`.
    const stage = await runCertificates({
      checker: ctx.checker,
      goal,
      domain,
      settings: certificates,
      ...(ctx.compute !== undefined ? { compute: ctx.compute } : {}),
      budgetSec: ctx.settings.cpuBudgetSec - cpuMs / 1000,
      maxSubmissions: ctx.settings.maxSubmissions + 1 - submitted,
      signal: ctx.signal,
      submit: async (proof, method) => {
        const result = await ctx.validate({ claimId: goal.claimId, proof, ...(ctx.attemptId !== undefined ? { attemptId: ctx.attemptId } : {}) });
        submission = result;
        if (result.verdict !== "valid") ctx.log(`M10: Lean accepted a certificate (${method}) but validate refused the proof (${result.reasons[0] ?? "no reason"})`);
        return result.verdict === "valid";
      },
    });
    tries.push(...stage.tries);
    cpuMs += stage.cpuMs;
    notes = stage.notes;
    submitted += stage.submissions;
    if (stage.winner !== undefined) winner = stage.winner;
    for (const n of stage.notes) ctx.log(`M10: certificate ${n.method}: ${n.note}`);
    // What the stage left of its reserve goes to the tactics it had cut short (those not tried yet).
    if (winner === undefined && cutByReserve && !ctx.signal.aborted) {
      await tacticRounds(ctx.settings.cpuBudgetSec);
    }
  }

  const data: BatteryRunData = {
    statement: goal.statement,
    domains: route.domains,
    moves: route.moves,
    tries,
    ...(winner !== undefined ? { solved: { tactic: winner.tactic, proof: winner.proof } } : {}),
    ...(submission !== undefined ? { submission: { verdict: submission.verdict, status: submission.status, ...(submission.validationId !== undefined ? { validationId: submission.validationId } : {}), reasons: submission.reasons } } : {}),
    cpuMs,
    budgetSec: ctx.settings.cpuBudgetSec,
    ...(notes !== undefined ? { certificates: notes } : {}),
  };
  const cut = winner === undefined && ctx.signal.aborted;
  const node = cut ? undefined : ctx.memory.recordNode({ kind: BATTERY_RUN, claimId: goal.claimId, data: data as never });
  return {
    settled: winner !== undefined,
    ...(submission !== undefined ? { submission } : {}),
    ...(winner !== undefined ? { winner } : {}),
    tries,
    cpuMs,
    domains: route.domains,
    ...(node !== undefined ? { nodeId: node.nodeId } : {}),
    budgetExhausted: last?.budgetExhausted ?? false,
    ...(notes !== undefined ? { certificates: notes } : {}),
  };
}
