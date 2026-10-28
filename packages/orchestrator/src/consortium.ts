import { type HarnessEvent, type Journal, readEvents, type TokenCost } from "@seshat/core";
import { type ConsortiumConfig, nextLimit, Turn, type TurnEnd, type TurnLimit, turnRecords } from "./turns.ts";

/**
 * The turns of a consortium run as the orchestrator writes them (documentation/human.md): a turn
 * begins when the run starts or is resumed, and ends once, with `turn.ended`, when the run is over or
 * waits for the team.
 */

/** The run's spend as the event records it. */
function costOf(spend: { usd: number; inputTokens: number; outputTokens: number }): TokenCost {
  return { usd: spend.usd, inputTokens: spend.inputTokens, outputTokens: spend.outputTokens };
}

function minus(a: TokenCost, b: TokenCost): TokenCost {
  return { usd: Math.max(0, a.usd - b.usd), inputTokens: Math.max(0, a.inputTokens - b.inputTokens), outputTokens: Math.max(0, a.outputTokens - b.outputTokens) };
}

/**
 * Ends a turn that the process before left open (it ended without writing `turn.ended`): the turn's
 * account is then of what the journal holds. Returns its number, or undefined when none was open.
 */
export function closeOpenTurn(journal: Journal): number | undefined {
  const turns = journal.projection.turns();
  if (turns.started <= turns.ended) return undefined;
  const record = turnRecords(readEvents(journal.log.path)).find((t) => t.turn === turns.started);
  const total = costOf(journal.projection.totalSpend());
  journal.emit(
    "turn.ended",
    {
      runId: journal.log.run,
      turn: turns.started,
      reason: "interrupted",
      detail: "the process that worked this turn ended without closing it (a kill, a crash or a usage limit)",
      spent: { turn: record === undefined ? total : minus(total, record.startSpend), run: total },
      minutes: 0,
      waiting: waitingProblems(journal),
    },
    "orchestrator",
  );
  return turns.started;
}

/** The problems that have no outcome yet. */
export function waitingProblems(journal: Journal, all?: readonly { id: string }[]): string[] {
  const done = new Set(journal.projection.problems().filter((row) => row.finished_seq !== null).map((row) => row.problem_id));
  return (all ?? journal.projection.problems().map((row) => ({ id: row.problem_id }))).map((p) => p.id).filter((id) => !done.has(id));
}

/**
 * Begins the next turn: closes one the process before left open, finds the limit (a flag of this
 * resumption, the team's steer, the turn before's, the run's), and writes `turn.started`.
 */
export function beginTurn(journal: Journal, o: { consortium: ConsortiumConfig; flag?: TurnLimit; now?: () => number }): Turn {
  closeOpenTurn(journal);
  const events = readEvents(journal.log.path);
  const { limit, source } = nextLimit(events, o.consortium, o.flag);
  const number = journal.projection.turns().started + 1;
  const startSpend = costOf(journal.projection.totalSpend());
  journal.emit("turn.started", { runId: journal.log.run, turn: number, limit, source, startSpend }, "orchestrator");
  return new Turn({ number, limit, source, startSpend, ...(o.now !== undefined ? { now: o.now } : {}) });
}

/** What ends a turn in the journal. */
export interface TurnClosing {
  /** The turn's end when it ended itself (a limit or a breakpoint), else the reason the run is over. */
  reason: string;
  detail: string;
  breakpoint?: TurnEnd["breakpoint"];
  waiting: string[];
  narrative?: { hash?: string; rejected?: string };
}

/** Writes `turn.ended` for the open turn, with what it spent and what the run has. */
export function closeTurn(journal: Journal, turn: Turn, closing: TurnClosing): void {
  const total = costOf(journal.projection.totalSpend());
  journal.emit(
    "turn.ended",
    {
      runId: journal.log.run,
      turn: turn.number,
      reason: closing.reason,
      detail: closing.detail,
      spent: { turn: minus(total, turn.startSpend), run: total },
      minutes: Math.round(turn.minutes * 1000) / 1000,
      waiting: closing.waiting,
      ...(closing.breakpoint !== undefined ? { breakpoint: closing.breakpoint } : {}),
      ...(closing.narrative !== undefined ? { narrative: closing.narrative } : {}),
    },
    "orchestrator",
  );
}

/** The consortium configuration a journal's `run.started` recorded, or undefined for an ordinary run. */
export function consortiumOf(events: readonly HarnessEvent[]): ConsortiumConfig | undefined {
  const started = events.find((event) => event.type === "run.started");
  const config = started?.type === "run.started" ? started.data.config : undefined;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  return readConsortium(config.consortium);
}

/** Reads a recorded consortium configuration back. */
export function readConsortium(recorded: unknown): ConsortiumConfig | undefined {
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) return undefined;
  const r = recorded as Record<string, unknown>;
  const limit = (typeof r.limit === "object" && r.limit !== null ? r.limit : {}) as Record<string, unknown>;
  const impasse = (typeof r.impasse === "object" && r.impasse !== null ? r.impasse : {}) as Record<string, unknown>;
  return {
    limit: {
      ...(typeof limit.tokens === "number" ? { tokens: limit.tokens } : {}),
      ...(typeof limit.usd === "number" ? { usd: limit.usd } : {}),
      ...(typeof limit.minutes === "number" ? { minutes: limit.minutes } : {}),
    },
    impasse: {
      posteriorBelow: typeof impasse.posteriorBelow === "number" ? impasse.posteriorBelow : 0.1,
      minAttempts: typeof impasse.minAttempts === "number" ? impasse.minAttempts : 8,
    },
    narrative: r.narrative === true,
  };
}
