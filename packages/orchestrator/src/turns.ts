import type { HarnessEvent, TokenCost, TurnLimit } from "@seshat/core";
import { latestSteer } from "./team.ts";

/**
 * Consortium mode, turns (documentation/human.md): a run that stops by itself when a limit is reached
 * or at a breakpoint, writes an account of where it stands, and spends nothing until the research
 * team has answered and resumed it. This file is the part of the orchestrator that counts a turn's
 * spend, says when it is over, and reads turns back from a journal.
 */

export type { TurnLimit };

/** How a run is told to be a consortium run, recorded in `run.started` (only when it is one). */
export interface ConsortiumConfig {
  /** The limit of the first turn; empty: no limit, only the breakpoints end a turn. */
  limit: TurnLimit;
  /** When a problem's posterior is an impasse. */
  impasse: ImpasseSettings;
  /** A model writes a short narrative of each turn, marked as model-written, with its ids checked. */
  narrative: boolean;
}

/** A problem is at an impasse when, after `minAttempts` finished attempts, the mean of its success posterior is below `posteriorBelow`. */
export interface ImpasseSettings {
  posteriorBelow: number;
  minAttempts: number;
}

export const DEFAULT_IMPASSE: ImpasseSettings = { posteriorBelow: 0.1, minAttempts: 8 };

/** The faults of a consortium configuration, or an empty list when it is sound. */
export function checkConsortium(c: ConsortiumConfig): string[] {
  const faults: string[] = [];
  for (const [name, value] of Object.entries(c.limit)) {
    if (!(name === "tokens" || name === "usd" || name === "minutes")) faults.push(`a turn limit is tokens, usd or minutes, not ${name}`);
    else if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) faults.push(`the turn limit ${name} must be a positive number, got ${String(value)}`);
  }
  if (!(c.impasse.posteriorBelow > 0 && c.impasse.posteriorBelow < 1)) faults.push(`the impasse threshold must be between 0 and 1, got ${c.impasse.posteriorBelow}`);
  if (!Number.isInteger(c.impasse.minAttempts) || c.impasse.minAttempts < 1) faults.push(`the impasse needs a whole number of attempts of at least 1, got ${c.impasse.minAttempts}`);
  return faults;
}

/**
 * A turn limit and the human breakpoints change what the models see (a session is cut, a run waits for
 * a person), so a run that measures lines against each other (an ablation) has neither. Returns the
 * reason a configuration is refused, or undefined. `harness run --ablation` calls it, and so must
 * `harness ablate` for every config it runs.
 */
export function ablationRefusal(config: { consortium?: ConsortiumConfig | undefined }): string | undefined {
  return config.consortium === undefined
    ? undefined
    : "a turn limit or --human cannot go with an ablation: a turn boundary changes what the models see, so the configs would no longer differ by their lines alone";
}

export type TurnReason = "tokens" | "usd" | "minutes" | "impasse" | "settled" | "disagreement";

/** Why a turn is over. */
export interface TurnEnd {
  reason: TurnReason;
  detail: string;
  breakpoint?: { kind: string; problemId?: string; nodeId?: string };
}

/** Thrown to whoever asks to send a model call after the turn ended: no model call is sent. */
export class TurnEndedError extends Error {
  readonly end: TurnEnd;

  constructor(end: TurnEnd) {
    super(`the turn is over (${end.detail}): no more model calls until the team has answered`);
    this.end = end;
  }
}

/** Whether a failure is the turn's end, however many layers of lines wrapped it. */
export function isTurnEnded(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof TurnEndedError) return true;
  }
  return false;
}

export interface TurnOptions {
  number: number;
  limit: TurnLimit;
  /** Where the limit came from, for the record. */
  source: string;
  /** What the run had spent when the turn began. */
  startSpend: TokenCost;
  /** Milliseconds, as `performance.now()` gives them. A test sets its own clock. */
  now?: () => number;
}

/**
 * One turn, counted in the process that works it. Every model response of the run is told to `charge`
 * (a prover's session or a line's one-shot call: the run's ledger passes them all), and the turn is
 * over the moment a limit is reached or a breakpoint is struck. It is a gate that is only read:
 * `ended` is what the sessions, the provers, the lines' calls and the run's queue ask before they
 * start anything, and nothing here stops a call that is already in flight.
 */
export class Turn {
  readonly number: number;
  readonly limit: TurnLimit;
  readonly source: string;
  readonly startSpend: TokenCost;
  tokens = 0;
  usd = 0;
  private readonly now: () => number;
  private readonly started: number;
  private over: TurnEnd | undefined;

  constructor(o: TurnOptions) {
    this.number = o.number;
    this.limit = o.limit;
    this.source = o.source;
    this.startSpend = o.startSpend;
    this.now = o.now ?? (() => performance.now());
    this.started = this.now();
  }

  /** Counts a model response, then looks at the limits. */
  charge(cost: Pick<TokenCost, "usd" | "inputTokens" | "outputTokens">): void {
    this.tokens += cost.inputTokens + cost.outputTokens;
    this.usd += cost.usd;
    void this.ended;
  }

  /** Minutes since the turn began. */
  get minutes(): number {
    return (this.now() - this.started) / 60_000;
  }

  /** Why the turn is over, or undefined while it is not. The first limit or breakpoint to strike decides. */
  get ended(): TurnEnd | undefined {
    if (this.over !== undefined) return this.over;
    const { tokens, usd, minutes } = this.limit;
    if (tokens !== undefined && this.tokens >= tokens) {
      this.over = { reason: "tokens", detail: `${this.tokens} tokens were spent in the turn, whose limit is ${tokens}` };
    } else if (usd !== undefined && this.usd >= usd) {
      this.over = { reason: "usd", detail: `$${this.usd.toFixed(4)} was spent in the turn, whose limit is $${usd}` };
    } else if (minutes !== undefined && this.minutes >= minutes) {
      this.over = { reason: "minutes", detail: `the turn has lasted ${this.minutes.toFixed(1)} minutes, and its limit is ${minutes}` };
    }
    return this.over;
  }

  /** A breakpoint ends the turn too, unless it is over already. */
  strike(end: TurnEnd): void {
    this.over ??= end;
  }
}

/** The turns a journal records, in order. */
export interface TurnRecord {
  turn: number;
  startedSeq: number;
  limit: TurnLimit;
  source: string;
  startSpend: TokenCost;
  endedSeq?: number;
  end?: Extract<HarnessEvent, { type: "turn.ended" }>["data"];
}

export function turnRecords(events: readonly HarnessEvent[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const event of events) {
    if (event.type === "turn.started") {
      turns.push({ turn: event.data.turn, startedSeq: event.seq, limit: event.data.limit, source: event.data.source, startSpend: event.data.startSpend });
    } else if (event.type === "turn.ended") {
      const open = turns.find((t) => t.turn === event.data.turn);
      if (open !== undefined) {
        open.endedSeq = event.seq;
        open.end = event.data;
      }
    }
  }
  return turns;
}

/** The limit of the turn that begins now: a flag of the resumption, else the team's newest steer since the last turn ended, else the turn before's, else the run's. */
export function nextLimit(events: readonly HarnessEvent[], run: ConsortiumConfig, flag?: TurnLimit): { limit: TurnLimit; source: string } {
  if (flag !== undefined && Object.keys(flag).length > 0) return { limit: flag, source: "a flag of the resumption" };
  const turns = turnRecords(events);
  const last = turns.at(-1);
  const since = last?.endedSeq ?? last?.startedSeq ?? -1;
  const steer = latestSteer(events, "turn_limit", since);
  if (steer !== undefined && steer.data.action === "turn_limit") {
    return { limit: steer.data.limit, source: `a steer by ${steer.data.by}` };
  }
  if (last !== undefined) return { limit: last.limit, source: `carried over from turn ${last.turn}` };
  return { limit: run.limit, source: "the run's option" };
}
