import { assertLeanSafe, isIdentifier, UnsafeText } from "./screen.ts";
import type { LeanChecker, RandomSource } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import { runBattery } from "./battery.ts";
import { type Premise, type PremiseSelector, mixSelectors, symbolSelector } from "./premises.ts";
import { Posteriors, type TryRecord } from "./posterior.ts";
import type { AtpOutput, SmtOutput } from "./solvers.ts";
import type { HostTactics, TacticSpec } from "./tactics.ts";
import { lower, Outside, toSmtLib, toTptp } from "./translate.ts";
import type { ClaimGoal } from "./solve.ts";

/** The two first-order tools, as functions; `null` when the host does not offer one. */
export interface Solvers {
  smt: ((input: { smtlib: string; timeoutSec: number }, signal?: AbortSignal) => Promise<SmtOutput>) | null;
  atp: ((input: { tptp: string; timeoutSec: number }, signal?: AbortSignal) => Promise<AtpOutput>) | null;
}

/** The solvers through the registry: each call is a tool run of `smt.z3` or `atp.vampire`. A tool the host does not offer is `null`. */
export function registrySolvers(registry: Registry, options: { actor: string; attemptId?: string }): Solvers {
  const call = <T>(capability: string) => async (input: object, signal?: AbortSignal): Promise<T> => {
    try {
      const { output } = await registry.invoke(capability, input as never, {
        actor: options.actor,
        ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      return output as unknown as T;
    } catch (error) {
      // A tool that is not there answers as an error the caller reads as "no evidence".
      if (error instanceof CapabilityError && error.code === "unavailable") throw new ToolMissing(capability);
      throw error;
    }
  };
  const offered = (id: string): boolean => {
    try {
      return registry.capability(id) !== undefined && registry.host.capabilities[id] !== undefined;
    } catch {
      return false;
    }
  };
  return {
    smt: offered("smt.z3") ? call<SmtOutput>("smt.z3") : null,
    atp: offered("atp.vampire") ? call<AtpOutput>("atp.vampire") : null,
  };
}

export class ToolMissing extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`${capability} is not available on this host`);
    this.capability = capability;
  }
}

/** The kind of the node an ATP or SMT run writes. */
export const FIRST_ORDER_RUN = "first_order_run";

export interface Evidence {
  tool: "smt.z3" | "atp.vampire";
  /** The premise cutoff of the call (0: no premises beyond the hypotheses). */
  cutoff: number;
  /** `unsat` for z3, the SZS status for Vampire. */
  answer: string;
  /** The hypotheses and premises of the unsat core or the proof, by their Lean names. */
  hypotheses: string[];
  premises: string[];
  elapsedMs: number;
}

export interface FirstOrderRunData {
  statement: string;
  cutoffs: number[];
  /** Why the goal was left out, when it was. */
  outside?: string;
  /** The tools that were not there. */
  missing: string[];
  evidence: Evidence[];
  /** The union of the premises of the successful calls. */
  union: string[];
  reconstruction: Array<{ tactic: string; outcome: string }>;
  solved?: { tactic: string; proof: string };
  submission?: { verdict: "valid" | "invalid"; status?: string; validationId?: string; reasons?: string[] };
  [key: string]: unknown;
}

export interface FirstOrderSettings {
  /** Premise cutoffs; with no index, only the hypotheses are used and the cutoffs collapse to one call. */
  cutoffs: readonly number[];
  timeoutSec: number;
  /** Lean time for the reconstruction attempts, in seconds. */
  reconstructBudgetSec: number;
  parallel: number;
  maxSubmissions: number;
}

export const DEFAULT_FIRST_ORDER: FirstOrderSettings = { cutoffs: [16, 64, 256], timeoutSec: 20, reconstructBudgetSec: 60, parallel: 4, maxSubmissions: 3 };

export interface FirstOrderContext {
  solvers: Solvers;
  checker: LeanChecker;
  memory: MemoryStore;
  validate: (request: ValidateRequest) => Promise<ValidateResult>;
  host: HostTactics;
  settings: FirstOrderSettings;
  /** The declarations to take premises from. Default: none. */
  index?: readonly Premise[];
  selector?: PremiseSelector;
  random: RandomSource;
  signal: AbortSignal;
  log: (text: string) => void;
}

export interface FirstOrderOutcome {
  /** Some solver proved the goal, and a Lean proof built from its premises was accepted by `validate`. */
  settled: boolean;
  evidence: Evidence[];
  outside?: string;
  nodeId: string;
}

/** The premises of a cutoff that lie in the fragment, each translated alone so that one outside does not drop the rest. */
function fragmentPremises(goal: string, chosen: readonly Premise[]): Premise[] {
  return chosen.filter((p) => {
    try {
      lower(goal, [p]);
      return true;
    } catch (error) {
      if (error instanceof Outside) return false;
      throw error;
    }
  });
}

/** Reconstruction tactics for a set of premises: the premises of the core or proof handed to `grind`, `aesop` and `hammer`. */
export function reconstructionTactics(premises: readonly string[], host: HostTactics): TacticSpec[] {
  for (const p of premises) if (!isIdentifier(p)) throw new UnsafeText(`the premise name ${JSON.stringify(p.slice(0, 60))} is refused: it is no Lean identifier`);
  const list = premises.join(", ");
  const specs: TacticSpec[] = [
    { name: `grind [${list}]`, script: `grind [${list}]`, kind: "search", timeoutSec: 30, cost: 2 },
    { name: `aesop ${premises.map((p) => `(add safe ${p})`).join(" ")}`, script: `aesop ${premises.map((p) => `(add safe ${p})`).join(" ")}`, kind: "search", timeoutSec: 30, cost: 2 },
  ];
  if (host.have.has("hammer")) specs.push({ name: `hammer [${list}]`, script: `hammer [${list}]`, kind: "hammer", timeoutSec: 60, needs: "hammer", suggests: true, cost: 3 });
  return specs;
}

/**
 * ATP and SMT with reconstruction (plan §15, step 5). The goal is translated at each premise cutoff
 * (the selector's choice mixed with a BM25 stream), z3 and Vampire run on every translation in
 * parallel, and the union of the successes is kept. An `unsat` or `Theorem` answer is evidence, a
 * node and no status. Only when the premises it used are handed to `grind`, `aesop` or `hammer` and
 * Lean accepts the result is a proof submitted through `validate`. Without a premise beyond the
 * goal's own hypotheses there is nothing new to hand over (the battery tried those tactics already),
 * and the evidence stays evidence.
 */
export async function solveFirstOrder(ctx: FirstOrderContext, goal: ClaimGoal): Promise<FirstOrderOutcome> {
  assertLeanSafe(goal.statement, "the statement");
  const data: FirstOrderRunData = { statement: goal.statement, cutoffs: [], missing: [], evidence: [], union: [], reconstruction: [] };
  const finish = (settled: boolean): FirstOrderOutcome => {
    const node = ctx.memory.recordNode({ kind: FIRST_ORDER_RUN, claimId: goal.claimId, data: data as never });
    return { settled, evidence: data.evidence, ...(data.outside !== undefined ? { outside: data.outside } : {}), nodeId: node.nodeId };
  };
  try {
    lower(goal.statement);
  } catch (error) {
    if (!(error instanceof Outside)) throw error;
    data.outside = error.message;
    return finish(false);
  }
  if (ctx.solvers.smt === null && ctx.solvers.atp === null) {
    data.missing.push("smt.z3", "atp.vampire");
    return finish(false);
  }
  const index = ctx.index ?? [];
  const select = ctx.selector ?? mixSelectors(symbolSelector);
  const cutoffs = index.length === 0 ? [0] : [...ctx.settings.cutoffs];
  data.cutoffs = cutoffs;

  const jobs = cutoffs.map(async (cutoff) => {
    const chosen = cutoff === 0 ? [] : fragmentPremises(goal.statement, select(goal.statement, index, cutoff));
    const problem = lower(goal.statement, chosen);
    const found: Evidence[] = [];
    const split = (named: Array<{ name: string; kind: string; lean: string }>, used: readonly string[]) => ({
      hypotheses: named.filter((n) => n.kind === "hypothesis" && used.includes(n.name)).map((n) => n.lean),
      premises: named.filter((n) => n.kind === "premise" && used.includes(n.name)).map((n) => n.lean),
    });
    const runs: Array<Promise<void>> = [];
    if (ctx.solvers.smt !== null) {
      const smt = ctx.solvers.smt;
      const script = toSmtLib(problem);
      runs.push(
        smt({ smtlib: script.text, timeoutSec: ctx.settings.timeoutSec }, ctx.signal).then(
          (out) => {
            if (out.status === "unsat") found.push({ tool: "smt.z3", cutoff, answer: "unsat", elapsedMs: out.elapsedMs, ...split(script.named, out.core ?? script.named.map((n) => n.name)) });
          },
          (error) => missing(error, "smt.z3"),
        ),
      );
    }
    if (ctx.solvers.atp !== null) {
      const atp = ctx.solvers.atp;
      const text = toTptp(problem);
      runs.push(
        atp({ tptp: text.text, timeoutSec: ctx.settings.timeoutSec }, ctx.signal).then(
          (out) => {
            if (out.result === "theorem") found.push({ tool: "atp.vampire", cutoff, answer: out.szs, elapsedMs: out.elapsedMs, ...split(text.named, out.used.length > 0 ? out.used : text.named.map((n) => n.name)) });
          },
          (error) => missing(error, "atp.vampire"),
        ),
      );
    }
    await Promise.all(runs);
    return found;
  });
  const missing = (error: unknown, tool: string): void => {
    if (error instanceof ToolMissing) {
      if (!data.missing.includes(tool)) data.missing.push(tool);
      return;
    }
    if (ctx.signal.aborted) return;
    throw error;
  };
  for (const found of await Promise.all(jobs)) data.evidence.push(...found);
  data.union = [...new Set(data.evidence.flatMap((e) => e.premises))];
  if (data.evidence.length === 0 || ctx.signal.aborted) return finish(false);
  ctx.log(`M10: ${data.evidence.map((e) => `${e.tool}@${e.cutoff}`).join(", ")} proved the goal in the encoded theory; reconstructing in Lean`);

  // Premise sets to try: each call's own (smallest first), then the union of all.
  const sets: string[][] = [];
  for (const e of [...data.evidence].sort((a, b) => a.premises.length - b.premises.length)) {
    if (e.premises.length > 0 && !sets.some((s) => s.join() === e.premises.join())) sets.push(e.premises);
  }
  if (data.union.length > 0 && !sets.some((s) => s.join() === data.union.join())) sets.push(data.union);
  if (sets.length === 0) {
    ctx.log("M10: the proof uses no premise beyond the hypotheses, which the battery's grind and aesop have tried: the evidence stays evidence");
    return finish(false);
  }
  let refusals = 0;
  for (const premises of sets) {
    if (ctx.signal.aborted || refusals > ctx.settings.maxSubmissions) break;
    const tactics = reconstructionTactics(premises, ctx.host);
    const result = await runBattery({
      checker: ctx.checker,
      goal,
      tactics,
      domain: "first_order_reconstruction",
      posteriors: new Posteriors(),
      order: { mode: "mean" },
      parallel: ctx.settings.parallel,
      cpuBudgetSec: ctx.settings.reconstructBudgetSec,
      signal: ctx.signal,
    });
    data.reconstruction.push(...result.tries.map((t: TryRecord) => ({ tactic: t.tactic, outcome: t.outcome })));
    if (result.winner === undefined) continue;
    const verdict = await ctx.validate({ claimId: goal.claimId, proof: result.winner.proof });
    data.submission = { verdict: verdict.verdict, status: verdict.status, ...(verdict.validationId !== undefined ? { validationId: verdict.validationId } : {}), reasons: verdict.reasons };
    if (verdict.verdict === "valid") {
      data.solved = { tactic: result.winner.tactic, proof: result.winner.proof };
      return finish(true);
    }
    refusals++;
  }
  return finish(false);
}
