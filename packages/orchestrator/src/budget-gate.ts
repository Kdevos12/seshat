import { type EventDataMap, hash32, type Journal, seeded, TASK_WRITER } from "@seshat/core";
import { attemptWeights, DEFAULT_GAMMA, posteriorOf, sample, UNIFORM } from "@seshat/fleet";
import { type BudgetAnswer, type BudgetAsk, type Decide, isInterrupted } from "@seshat/lines";
import { type Attempt, failureDepth } from "@seshat/memory";
import {
  type GateAnswer,
  type GateQuery,
  type GateSite,
  type GateVerdict,
  gateRule,
  type GateState,
  type Progress,
  probeCapUsd,
  probeVerdict,
  progressed,
  PRIOR_SESSION_USD,
  type ResolvedGate,
  widenRule,
} from "@seshat/scheduler";
import type { Ledger } from "./budget.ts";

/** A failed check at this depth or deeper typed every step and left only goals: Lean got somewhere (documentation/scheduler.md, "The budget gate"). */
export const PROGRESS_DEPTH = 5;

/** The length, in model responses, of the session the mean cost (or the first guess) stands for: a task bounded in turns is priced in proportion (12 is M12's `holeTurns`). */
const USUAL_SESSION_TURNS = 12;

type Gated = EventDataMap["budget.gated"];

export interface BudgetGateOptions {
  settings: ResolvedGate;
  journal: Journal;
  problemId: string;
  claimId: string;
  /** The problem's ledger: what is left is its limit and its ancestors' less what they spent. */
  ledger: Ledger;
  /** Seeds the Thompson draws and the floor's: the same seed and the same journal make the same answers. */
  seed: string | number;
  /** The ladder rung the problem is on. */
  rung: () => number;
  /** The consortium turn in progress, when the run has turns: a problem the gate stopped is looked at again in a later turn. */
  turn?: () => number | undefined;
  /** The attempts the problem's provers made, for the depth of the probe's check. */
  attemptIds: () => readonly string[];
  /** The ladder's measure of Lean progress now (new subclaims proved, fewer holes), when the run has a memory. */
  leanProgress?: () => Progress;
  /** The weight of an attempt of an older epoch (`MemoryStore.weightOf`); absent: 1. */
  epochWeight?: (epoch: number) => number;
  /** Where the rule has no numbers; absent, or a site `off`: the rule alone. */
  decide?: Decide;
  log: (text: string) => void;
}

/** What the gate answered, as a launch decides on it. */
export interface GateOutcome {
  action: Gated["action"];
  by: Gated["by"];
  reason: string;
  verdict: GateVerdict;
  decisionId?: string;
}

/**
 * The budget gate of one problem (documentation/scheduler.md, "The budget gate"): the deterministic rule of `@seshat/scheduler`
 * with the numbers of this problem, a Thompson draw from the claim's Beta posterior, and the journal. Every answer is written as
 * `budget.gated` with its numbers. Where the rule has none (a cold start, a tie) `decide` is asked at `budget.wave` or `budget.line`
 * with a state of counts and dollars; if it fails, the rule's own answer stands.
 */
export class BudgetGate {
  private readonly o: BudgetGateOptions;
  /** The Lean progress at the start, which a later measure is compared with. */
  private baseline: Progress | undefined;

  constructor(options: BudgetGateOptions) {
    this.o = options;
  }

  /** The rows of this problem's gate answers, in order. */
  private rows(): Gated[] {
    return this.o.journal.projection.gates({ problemId: this.o.problemId }).map((g) => g.data);
  }

  /** The sessions a prover runs before the gate can end it. */
  get minSessions(): number {
    return this.o.settings.minSessions;
  }

  /**
   * Where the problem stands: no probe yet, probing, widened, or stopped after its probe. A stop is final within the turn it was given
   * in, and with the budget and the rung it was given at; a later turn, a new budget (what the team gave) or a ladder escalation puts
   * the problem back to `probing`, so the gate looks again with the draws of the new round (documentation/scheduler.md).
   */
  get stage(): "start" | "probing" | "wide" | "stopped" {
    const waves = this.rows().filter((g) => g.site === "wave");
    if (waves.some((g) => g.action === "widen")) return "wide";
    const stop = waves.filter((g) => g.action === "skip" && g.by !== "memory").at(-1);
    if (stop !== undefined) {
      const same = stop.turn === this.o.turn?.() && stop.rung === this.o.rung() && stop.budgetUsd === this.budgetUsd();
      return same ? "stopped" : "probing";
    }
    return waves.some((g) => g.action === "probe") ? "probing" : "start";
  }

  /** What the problem has left: the least of its own and its ancestors' limits less their spending. */
  remainingUsd(): number {
    let left = Number.POSITIVE_INFINITY;
    for (let ledger: Ledger | undefined = this.o.ledger; ledger !== undefined; ledger = ledger.parent) {
      if (ledger.limitUsd !== undefined) left = Math.min(left, ledger.limitUsd - ledger.usd);
    }
    return Math.max(0, left);
  }

  private budgetUsd(): number {
    return this.o.ledger.limitUsd ?? Math.max(this.remainingUsd(), Number.MIN_VALUE);
  }

  private state(): GateState {
    const remaining = this.remainingUsd();
    return { remainingUsd: Number.isFinite(remaining) ? remaining : this.budgetUsd(), budgetUsd: this.budgetUsd() };
  }

  /** The attempts of the claim as the fleet reads them: this run's and the earlier runs' of the chain, discounted per run. */
  private attempts(): Array<{ attempt: Attempt; usd: number | null }> {
    return this.o.journal.projection.attempts(this.o.claimId).map((row) => ({
      attempt: {
        attemptId: row.attempt_id,
        claimId: row.claim_id,
        prover: row.prover,
        iteration: row.iteration,
        model: row.model,
        ...(row.outcome !== null ? { outcome: row.outcome as Attempt["outcome"] } : {}),
        ...(row.failure_class !== null ? { failureClass: row.failure_class } : {}),
        epoch: row.epoch,
        runsAgo: row.runs_ago,
      } as Attempt,
      usd: row.finished_seq === null ? null : (row.usd ?? 0),
    }));
  }

  /** The success posterior of the claim, and how many attempts counted in it. */
  private posterior(): { beta: { alpha: number; beta: number }; counted: number } {
    const attempts = this.attempts().map((a) => a.attempt);
    const weigh = attemptWeights(attempts, { gamma: DEFAULT_GAMMA, epochWeight: this.o.epochWeight ?? (() => 1) });
    const p = posteriorOf(attempts, 0, weigh);
    return { beta: p.success, counted: p.attempts };
  }

  /** What a session of this problem costs: the mean of the sessions paid on the claim, else M12's first guess. */
  sessionUsd(): number {
    const paid = this.attempts().flatMap((a) => (a.usd === null ? [] : [a.usd]));
    return paid.length === 0 ? PRIOR_SESSION_USD : paid.reduce((sum, usd) => sum + usd, 0) / paid.length;
  }

  /**
   * What a task costs if it uses its sessions: the sessions times what a session costs. The chance of success is not in the price: the
   * rule weighs the price by it (`share x remaining x pSuccess`), and counting it here too would count it twice.
   */
  taskUsd(sessions: number, turns?: number): number {
    // A session that is bounded in turns costs in proportion to its bound: the mean (or the first guess) is for a session of the usual length.
    const scale = turns === undefined ? 1 : Math.max(1, turns) / USUAL_SESSION_TURNS;
    return this.sessionUsd() * Math.max(1, sessions) * scale;
  }

  /**
   * The numbers of the next answer. The draws come from a seeded source keyed by the request (the problem, the site and the prover and
   * session, or the task, or the round of the wave), not by the number of rows in the journal: provers that ask together read the same
   * row count, and the order they ask in is not the same from one execution to the next, but what each one asks is.
   */
  private draws(key: string): { pSuccess?: number; coldDraw: number; floorDraw: number } {
    const rng = seeded(hash32(`${String(this.o.seed)}\ngate\n${this.o.problemId}\n${key}`));
    const { beta, counted } = this.posterior();
    const thompson = sample(rng, beta);
    const coldDraw = sample(rng, UNIFORM);
    const floorDraw = rng();
    return { ...(counted > 0 ? { pSuccess: thompson } : {}), coldDraw, floorDraw };
  }

  private query(site: GateSite, estimateUsd: number, key: string, given?: number): GateQuery {
    const draws = this.draws(key);
    return {
      site,
      estimateUsd,
      ...(given !== undefined ? { pSuccess: given } : draws.pSuccess !== undefined ? { pSuccess: draws.pSuccess } : {}),
      coldDraw: draws.coldDraw,
      floorDraw: draws.floorDraw,
      rung: this.o.rung(),
    };
  }

  /** How many answers this problem holds for a site and a task already: the round of a request that is made more than once. */
  private round(site: GateSite, taskId?: string): number {
    return this.rows().filter((g) => g.site === site && g.taskId === taskId).length;
  }

  /** The state that a decision is asked about: counts and dollars, nothing of the mathematics. */
  private stateText(query: GateQuery, undecided: "cold_start" | "tie", threshold: number | undefined): string {
    const { counted } = this.posterior();
    const state = this.state();
    return [
      `site ${query.site}`,
      `why ${undecided === "cold_start" ? "no posterior yet" : "estimate within the margin of the threshold"}`,
      `attempts counted ${counted}`,
      `sessions paid ${this.attempts().filter((a) => a.usd !== null).length}`,
      `estimate ${query.estimateUsd.toFixed(4)} dollars`,
      `remaining ${state.remainingUsd.toFixed(4)} of ${state.budgetUsd.toFixed(4)} dollars`,
      ...(undecided === "tie" && threshold !== undefined ? [`threshold ${threshold.toFixed(4)} dollars`] : []),
      `rung ${query.rung}`,
    ].join("\n");
  }

  /** Breaks a cold start or a tie with `decide`, or keeps the rule's answer. */
  private async broken(answer: GateAnswer, query: GateQuery): Promise<{ verdict: GateVerdict; decisionId?: string }> {
    const { verdict, undecided } = answer;
    const decide = this.o.decide;
    const site = query.site === "wave" || query.site === "session" ? "budget.wave" : "budget.line";
    if (undecided === undefined || decide === undefined || decide.backendFor(site) === "off") return { verdict };
    try {
      const go = query.site === "wave" ? "widen" : "launch";
      const decision = await decide.decide({
        site,
        state: this.stateText(query, undecided, verdict.thresholdUsd),
        question: {
          type: "choice",
          instructions: "Is this launch worth its estimated price, given what is left of the budget? Answer launch or skip.",
          options: { launch: "pay the estimate and launch", skip: "do not launch" },
        },
        use: "order",
      });
      const action = decision.answer === "launch" ? go : decision.answer === "skip" ? "skip" : undefined;
      if (action === undefined) return { verdict };
      return {
        verdict: {
          ...verdict,
          action,
          by: "decide",
          exploration: false,
          reason: `${undecided === "cold_start" ? "no posterior" : "a tie within the margin"}: ${site} answered ${String(decision.answer)} (${decision.backend}); the rule alone said ${verdict.action}`,
        },
        decisionId: decision.decisionId,
      };
    } catch (error) {
      if (isInterrupted(error)) throw error;
      this.o.log(`gate: ${site} could not answer (${error instanceof Error ? error.message : String(error)}); the rule's answer stands`);
      return { verdict };
    }
  }

  private write(verdict: GateVerdict, where: { prover?: string; session?: number; taskId?: string }, decisionId?: string): GateOutcome {
    // The posterior the draw came from, so that the avoided spend can be audited from the journal.
    const { beta, counted } = this.posterior();
    const reason = verdict.pSuccess === undefined ? verdict.reason : `${verdict.reason} [posterior Beta(${beta.alpha.toFixed(2)}, ${beta.beta.toFixed(2)}) from ${counted} attempts]`;
    const data: Gated = {
      problemId: this.o.problemId,
      site: verdict.site,
      action: verdict.action,
      by: verdict.by,
      estimateUsd: verdict.estimateUsd,
      remainingUsd: verdict.remainingUsd,
      budgetUsd: verdict.budgetUsd,
      share: verdict.share,
      ...(verdict.pSuccess !== undefined ? { pSuccess: verdict.pSuccess } : {}),
      ...(verdict.thresholdUsd !== undefined ? { thresholdUsd: verdict.thresholdUsd } : {}),
      rung: verdict.rung,
      exploration: verdict.exploration,
      ...(verdict.progress !== undefined ? { progress: verdict.progress } : {}),
      ...(where.prover !== undefined ? { prover: where.prover } : {}),
      ...(where.session !== undefined ? { session: where.session } : {}),
      ...(where.taskId !== undefined ? { taskId: where.taskId } : {}),
      ...(decisionId !== undefined ? { decisionId } : {}),
      ...(verdict.floorDraw !== undefined ? { floorDraw: verdict.floorDraw } : {}),
      ...(verdict.floorFraction !== undefined ? { floorFraction: verdict.floorFraction } : {}),
      ...(this.o.turn?.() !== undefined ? { turn: this.o.turn() as number } : {}),
      reason,
    };
    this.o.journal.emit("budget.gated", data, TASK_WRITER);
    this.o.log(`gate: ${verdict.site} ${verdict.action} by ${verdict.by}: ${verdict.reason}`);
    return { action: data.action, by: data.by, reason: data.reason, verdict, ...(decisionId !== undefined ? { decisionId } : {}) };
  }

  /** The problem's first launch (PB2): one prover, one session, at most a tenth of its budget. Recorded once. */
  probe(): { capUsd: number } {
    const state = this.state();
    const capUsd = probeCapUsd(state.budgetUsd, this.o.settings);
    if (this.rows().some((g) => g.site === "wave" && g.action === "probe")) return { capUsd };
    this.write(probeVerdict({ estimateUsd: this.sessionUsd(), rung: this.o.rung() }, state, this.o.settings), { prover: "p1", session: 1 });
    return { capUsd };
  }

  /** The Lean progress since the problem began: the ladder's measure, else the depth of the probe's check. Undefined: none. */
  progress(): string | undefined {
    if (this.o.leanProgress !== undefined) {
      this.baseline ??= this.o.leanProgress();
      const why = progressed(this.baseline, this.o.leanProgress());
      if (why !== undefined) return why;
    }
    const projection = this.o.journal.projection;
    for (const id of this.o.attemptIds()) {
      const row = projection.attempt(id);
      if (row?.outcome === "valid") return "a proof passed the fast check";
      if (row?.outcome === "invalid" && failureDepth(row.failure_class ?? undefined) >= PROGRESS_DEPTH) {
        return `a check typed every step and left ${row.failure_class === "holes" ? "holes" : "goals"} (${row.failure_class})`;
      }
    }
    return undefined;
  }

  /** After the probe: whether the problem widens to `provers` provers (PB2). Only Lean progress widens, except for the floor's fraction. */
  async widen(provers: number): Promise<GateOutcome> {
    const why = this.progress();
    const estimate = Math.max(1, provers) * this.sessionUsd();
    const query = { ...this.query("wave", estimate, `wave:${this.rows().filter((g) => g.site === "wave").length}`), progress: why !== undefined };
    const answer = widenRule(query, this.state(), this.o.settings);
    const { verdict, decisionId } = await this.broken(answer, query);
    return this.write(why === undefined ? verdict : { ...verdict, reason: `${verdict.reason} (Lean progress: ${why})` }, { prover: "p1" }, decisionId);
  }

  /** Before a session of a widened prover. */
  async session(who: { prover: string; session: number }): Promise<GateOutcome> {
    const query = this.query("session", this.sessionUsd(), `session:${who.prover}:${who.session}`);
    const answer = gateRule(query, this.state(), this.o.settings);
    const { verdict, decisionId } = await this.broken(answer, query);
    return this.write(verdict, who, decisionId);
  }

  /** Before a line's task is worked (`budget.line` where there are no numbers). `sessions` is the task's budget in sessions, `turns` the bound of a session in model responses when it has one. */
  async task(who: { taskId: string; sessions?: number; turns?: number }): Promise<GateOutcome> {
    const query = this.query("task", this.taskUsd(who.sessions ?? 1, who.turns), `task:${who.taskId}:${this.round("task", who.taskId)}`);
    const answer = gateRule(query, this.state(), this.o.settings);
    const { verdict, decisionId } = await this.broken(answer, query);
    return this.write(verdict, { taskId: who.taskId }, decisionId);
  }

  /** The hook a line calls (`problem.budget.ask`, documentation/lines.md): the line gives the estimate and may give the chance of success. */
  async ask(request: BudgetAsk): Promise<BudgetAnswer> {
    if (!Number.isFinite(request.estimateUsd) || request.estimateUsd < 0) throw new RangeError(`the estimate of a launch is a non-negative number of dollars, got ${String(request.estimateUsd)}`);
    if (request.pSuccess !== undefined && !(Number.isFinite(request.pSuccess) && request.pSuccess >= 0 && request.pSuccess <= 1)) {
      throw new RangeError(`the chance of success of a launch is from 0 to 1, got ${String(request.pSuccess)}`);
    }
    const query = this.query(request.site, request.estimateUsd, `${request.site}:${request.taskId ?? ""}:${this.round(request.site, request.taskId)}`, request.pSuccess);
    const answer = gateRule(query, this.state(), this.o.settings);
    const { verdict, decisionId } = await this.broken(answer, query);
    const out = this.write(verdict, request.taskId !== undefined ? { taskId: request.taskId } : {}, decisionId);
    return {
      action: out.action === "launch" ? "launch" : "skip",
      by: out.by,
      reason: out.reason,
      exploration: out.verdict.exploration,
      ...(out.verdict.thresholdUsd !== undefined ? { thresholdUsd: out.verdict.thresholdUsd } : {}),
    };
  }

  /** A claim certified under the same environment is not relaunched (PB5). */
  memorySkip(reason: string): GateOutcome {
    const state = this.state();
    return this.write(
      {
        site: "wave",
        action: "skip",
        by: "memory" as const,
        // What the probe would have cost: a floor on what skipping the problem avoids.
        estimateUsd: this.sessionUsd(),
        remainingUsd: state.remainingUsd,
        budgetUsd: state.budgetUsd,
        share: this.o.settings.share.wave,
        rung: this.o.rung(),
        exploration: false,
        reason,
      },
      {},
    );
  }
}
