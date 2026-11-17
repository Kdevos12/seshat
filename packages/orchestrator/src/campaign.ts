import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HarnessEvent, Journal, Projection, readEvents } from "@seshat/core";
import { frontier, type FrontierOptions, frontierScore, MemoryStore } from "@seshat/memory";
import { type CampaignConfig, DEFAULT_SPIRAL_TURNS, readCampaignConfig } from "./campaign-config.ts";
import { type DigestContext, renderDigest, scoresByTurn, writeDigest } from "./campaign-digest.ts";
import { acquireLock, backoffMinutes, beat } from "./campaign-watch.ts";
import { DEFAULT_DEAD_ENDS } from "./dossier.ts";
import { retirementOf } from "./dossier-build.ts";
import { decidePlateau, modeOfTurn, type PlateauContext, spiralOf } from "./plateau.ts";
import { writeResult } from "./result.ts";
import { sleepFor } from "./offpeak.ts";
import { usageLimitError } from "./provider-errors.ts";
import { consortiumOf } from "./consortium.ts";
import { frontierOptionsOfEvents } from "./frontier-view.ts";
import type { RunResult } from "./run.ts";
import { answersSince, turnRecords, type TurnLimit } from "./turns.ts";
import { latestSteer } from "./team.ts";

/**
 * The supervisor of a campaign (`harness campaign`, documentation/campaign.md): a loop of consortium turns that do not wait. After each turn it
 * rebuilds the digest from the journal, decides from the journal alone whether the campaign is over, and starts the next turn by the path
 * `harness resume` uses. It holds no state of its own that the journal does not: a supervisor that dies is replaced by another that reads the
 * run and goes on.
 *
 * Trust: a campaign ends `settled` only when a claim of the run is `proved` or `refuted`, which only the certifier's kernel replay makes; every
 * other end is a stop, with the frontier. Nothing here writes a claim's status, and what a person answers changes what the sessions are told
 * and the order of the work, never a status.
 */

export type CampaignStop = "settled" | "allowance" | "until" | "spiral" | "ended" | "aborted";

/** How a campaign ended: what the journal records in `campaign.stopped`. */
export interface CampaignEnd {
  /** `not_started`: the first turn was not run (the person did not sign), so there is no run. */
  reason: CampaignStop | "not_started";
  detail: string;
  /** Turns that have ended in the run, and its spend. */
  turns: number;
  usd: number;
  digest?: string;
}

export interface CampaignOptions {
  /** The run directory. */
  dir: string;
  /** Begins the run and works its first turn; called only when the directory holds no journal. `undefined`: nothing began. */
  first?: () => Promise<RunResult | undefined>;
  /** Works the next turn of the run (`resumeBench`), with the limit the supervisor computed (absent: the run's own). */
  next: (turn: { limit: TurnLimit | undefined }) => Promise<RunResult>;
  /** The settings of a campaign whose journal does not exist yet; afterwards the ones `run.started` recorded are read. */
  settings?: CampaignConfig;
  /** Stops the supervisor between turns (and the turn in progress, if `next` honours the signal): the campaign ends `aborted`. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Wall-clock milliseconds, for the day's cap and the end time. Default `Date.now`; a test injects its own (and the same one into the turns' `wallClock`). */
  clock?: () => number;
  /** Waits `ms`, or less when the signal aborts. Default a timer; a test advances its clock here. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The process's id for the lock (default `process.pid`) and how a lock's process is found alive (default `kill(pid, 0)`): a test injects both. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** How often the heartbeat is rewritten besides each turn (default one minute). */
  heartbeatMs?: number;
}

/** A campaign's state, read from its journal. */
export interface CampaignView {
  events: readonly HarnessEvent[];
  p: Projection;
  runId: string;
  settings: CampaignConfig;
  runUsd: number | undefined;
  finished: boolean;
  frontierOptions: FrontierOptions;
  /** Whether the run waits for the off-peak window (its recorded `offpeak` setting). */
  offPeak: boolean;
  close: () => void;
  /** The journal itself, when it could be opened to write (not when a crash cut its last line). */
  journal?: Journal;
}

/** Reads the run of `dir`: through its journal when it opens, else (a crash cut its last line) by replaying the events whole. */
export function readCampaign(dir: string): CampaignView | undefined {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) return undefined;
  const events = readEvents(path);
  const started = events.find((e) => e.type === "run.started");
  if (started === undefined || started.type !== "run.started") return undefined;
  const config = (typeof started.data.config === "object" && started.data.config !== null && !Array.isArray(started.data.config) ? started.data.config : {}) as Record<string, unknown>;
  const budget = (typeof config.budget === "object" && config.budget !== null ? config.budget : {}) as Record<string, unknown>;
  const base = {
    runId: started.data.runId,
    settings: readCampaignConfig(config.campaign) ?? {},
    runUsd: typeof budget.runUsd === "number" ? budget.runUsd : undefined,
    frontierOptions: frontierOptionsOfEvents(events) ?? {},
    offPeak: typeof config.offpeak === "object" && config.offpeak !== null,
  };
  const finished = events.findLastIndex((e) => e.type === "run.finished") > events.findLastIndex((e) => e.type === "run.resumed");
  let journal: Journal | undefined;
  try {
    journal = Journal.open(dir, base.runId, { deferRepair: true });
    if (journal.log.recovered !== undefined) {
      journal.close();
      journal = undefined;
    }
  } catch {
    journal = undefined;
  }
  if (journal !== undefined) {
    const open = journal;
    return { ...base, events: readEvents(path), p: open.projection, finished, journal: open, close: () => open.close() };
  }
  const p = Projection.inMemory();
  for (const event of events) p.apply(event);
  return { ...base, events, p, finished, close: () => p.close() };
}

/** What the journal says about the end of the campaign, or `undefined` when it goes on. */
export function endOf(view: CampaignView, o: { now: number }): { reason: CampaignStop; detail: string } | undefined {
  const { p, events } = view;
  const settled = p.problems().find((row) => ["proved", "refuted"].includes(p.claim(row.claim_id)?.status ?? "open"));
  if (settled !== undefined && view.finished) {
    return { reason: "settled", detail: `${settled.target} is ${p.claim(settled.claim_id)?.status}: the certifier's kernel replay settled it` };
  }
  const total = p.totalSpend().usd;
  if (view.runUsd !== undefined && total >= view.runUsd - 1e-9) return { reason: "allowance", detail: `the run has spent $${total.toFixed(4)} of its allowance of $${view.runUsd}` };
  const finish = events.findLast((e) => e.type === "run.finished");
  if (view.finished && finish?.type === "run.finished") {
    if (finish.data.stopped === "budget_exhausted") return { reason: "allowance", detail: "the run's budget is spent" };
    if (finish.data.stopped === "aborted") return { reason: "aborted", detail: "the run was stopped" };
    return { reason: "ended", detail: finish.data.stopped !== undefined ? `the run finished: ${finish.data.stopped}` : "the run finished without settling the target" };
  }
  const until = view.settings.until;
  if (until !== undefined && o.now >= Date.parse(until)) return { reason: "until", detail: `the wall-clock end ${until} has come` };
  const spiral = view.settings.spiralTurns ?? DEFAULT_SPIRAL_TURNS;
  const scores = scoresByTurn(events, p, view.frontierOptions);
  // LH6: two full cycles of the plateau modes spent without the frontier growing.
  const cycles = spiralOf(events, scores);
  if (cycles !== undefined) {
    return { reason: "spiral", detail: `the ${cycles.turns} turns of two full cycles of the five modes spent $${cycles.usd.toFixed(4)} and the frontier did not grow: out of reach at this budget, here is what is established` };
  }
  let count = 0;
  for (let i = scores.length - 1; i >= 0; i--) {
    const now = scores[i] as (typeof scores)[number];
    if (!(now.usd > 0)) continue;
    // A turn in a plateau mode belongs to the LH6 guard above: this one keeps its meaning for a campaign without modes.
    if (modeOfTurn(events, now.turn) !== undefined) break;
    const before = scores.slice(0, i).at(-1)?.score ?? 0;
    if (now.score > before) break;
    count += 1;
  }
  if (count >= spiral) return { reason: "spiral", detail: `${count} turns in a row spent money and the frontier did not grow: out of reach at this budget, here is what is established` };
  return undefined;
}

/** What decides whether a plateau mode applies, read from the run's recorded configuration and journal. */
export function plateauContext(view: CampaignView): PlateauContext {
  const started = view.events.find((e) => e.type === "run.started");
  const config = (started?.type === "run.started" && typeof started.data.config === "object" && started.data.config !== null && !Array.isArray(started.data.config) ? started.data.config : {}) as Record<string, unknown>;
  const row = view.p.problems()[0];
  const intake = typeof config.intake === "object" && config.intake !== null && !Array.isArray(config.intake) ? (config.intake as Record<string, unknown>) : {};
  return {
    statement: row === undefined ? "" : (view.p.claim(row.claim_id)?.statement ?? row.target),
    lines: Array.isArray(config.lines) ? config.lines.filter((l): l is string => typeof l === "string") : [],
    private: config.private === true,
    literature: intake.literature === true && view.events.some((e) => e.type === "intake.consented" && e.data.allowed === true),
  };
}

/** The limit of the turn that begins: the team's steer, else the run's option, never the turn before's (a daily cap shrinks that one). */
export function baseLimit(events: readonly HarnessEvent[]): TurnLimit {
  const consortium = consortiumOf(events);
  const last = turnRecords(events).at(-1);
  const steer = latestSteer(events, "turn_limit", answersSince(last));
  if (steer !== undefined && steer.data.action === "turn_limit") return steer.data.limit;
  return consortium?.limit ?? {};
}

/** The score and entry count of the frontier of every problem of the run. */
export function frontierSummary(view: CampaignView): { score: number; entries: number } {
  const store = MemoryStore.readOnly(view.p);
  const entries = view.p.problems().flatMap((row) => frontier(store, row.claim_id, view.frontierOptions).entries);
  return { score: frontierScore(entries, view.frontierOptions), entries: entries.length };
}

/** Writes events between turns, when the journal opens; the ones it cannot write (a crash cut its last line) wait for the next chance. */
class Pending {
  private queue: Array<(journal: Journal) => void> = [];
  add(write: (journal: Journal) => void): void {
    this.queue.push(write);
  }
  flush(view: CampaignView | undefined): void {
    if (view?.journal === undefined || this.queue.length === 0) return;
    for (const write of this.queue) write(view.journal);
    this.queue = [];
  }
}

/** The UTC day of an instant, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The first instant of the UTC day after the one `ms` is in. */
export const nextUtcDay = (ms: number): number => Date.parse(`${utcDay(ms)}T00:00:00Z`) + 86_400_000;

/**
 * The dollars the turns that began on a UTC day have spent, from the journal: each turn's spend (`turn.ended.spent.turn`; for a turn that is still
 * open, the run's spend since it began) on the day of its start (`turn.started.at`, else the event's own time).
 */
export function daySpendUsd(events: readonly HarnessEvent[], totalUsd: number, day: string): number {
  let spent = 0;
  const ended = new Map<number, number>();
  for (const e of events) if (e.type === "turn.ended") ended.set(e.data.turn, e.data.spent.turn.usd);
  for (const e of events) {
    if (e.type !== "turn.started" || utcDay(Date.parse(e.data.at ?? e.ts)) !== day) continue;
    spent += ended.get(e.data.turn) ?? Math.max(0, totalUsd - e.data.startSpend.usd);
  }
  return spent;
}

/** The consecutive usage-limit endings at the end of the journal's turns: how many times in a row the provider's limit stopped a turn. */
function usageLimitStreak(events: readonly HarnessEvent[]): number {
  let streak = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as HarnessEvent;
    if (e.type === "turn.ended") {
      if (e.data.reason !== "usage_limit") break;
      streak += 1;
    }
  }
  return streak;
}

/** Runs the campaign until it ends. */
export async function runCampaign(o: CampaignOptions): Promise<CampaignEnd> {
  const log = o.log ?? (() => {});
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? sleepFor;
  const pid = o.pid ?? process.pid;
  const pending = new Pending();
  let digest: string | undefined;
  const release = acquireLock(o.dir, { pid, now: clock, ...(o.isAlive !== undefined ? { isAlive: o.isAlive } : {}) });
  let ended = 0;
  const heartbeat = setInterval(() => beat(o.dir, { pid, now: clock(), turn: ended }), o.heartbeatMs ?? 60_000);
  heartbeat.unref();
  const pulse = (): void => beat(o.dir, { pid, now: clock(), turn: ended });
  pulse();
  try {
    return await loop();
  } finally {
    clearInterval(heartbeat);
    release();
  }

  function stop(view: CampaignView, end: { reason: CampaignStop; detail: string }): CampaignEnd {
    const f = frontierSummary(view);
    const turns = view.p.turns().ended;
    const usd = view.p.totalSpend().usd;
    pending.add((journal) => journal.emit("campaign.stopped", { runId: view.runId, reason: end.reason, detail: end.detail, turns, usd, frontier: f }, "orchestrator"));
    pending.flush(view);
    digest = writeDigest(o.dir, renderDigest(view.events, view.p, context(view, end.reason)));
    // A spiral's honest report goes into RESULT.md too, now that the journal holds `campaign.stopped`.
    if (end.reason === "spiral" && view.journal !== undefined) {
      try {
        writeResult(o.dir);
      } catch (error) {
        log(`RESULT.md could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`campaign ${end.reason === "settled" ? "settled" : `stopped (${end.reason})`}: ${end.detail}`);
    return { reason: end.reason, detail: end.detail, turns, usd, ...(digest !== undefined ? { digest } : {}) };
  }

  function context(view: CampaignView, state: string, extra: { waiting?: string } = {}): DigestContext {
    const settings = { ...o.settings, ...view.settings };
    const day = utcDay(clock());
    return {
      state,
      ...(settings.usdPerDay !== undefined ? { usdPerDay: settings.usdPerDay, today: { day, usd: daySpendUsd(view.events, view.p.totalSpend().usd, day) } } : {}),
      ...(settings.until !== undefined ? { until: settings.until } : {}),
      ...(view.runUsd !== undefined ? { allowanceUsd: view.runUsd } : {}),
      ...(extra.waiting !== undefined ? { waiting: extra.waiting } : {}),
      frontierOptions: view.frontierOptions,
    };
  }

  /** Records that the campaign waits, and waits. The journal's view is closed first: nothing is held while the campaign sleeps. */
  async function wait(view: CampaignView, w: { reason: "daily_cap" | "usage_limit"; from: number; until: number; detail: string }): Promise<void> {
    const now = w.from;
    pending.add((journal) =>
      journal.emit("campaign.waiting", { runId: view.runId, reason: w.reason, from: new Date(now).toISOString(), until: new Date(w.until).toISOString(), detail: w.detail }, "orchestrator"),
    );
    pending.flush(view);
    digest = writeDigest(o.dir, renderDigest(view.events, view.p, context(view, "working", { waiting: w.detail })));
    view.close();
    log(`campaign waits: ${w.detail}`);
    pulse();
    await sleep(Math.max(0, w.until - now), o.signal);
    pulse();
  }

  async function loop(): Promise<CampaignEnd> {
    let announced = false;
    let thrown = 0;
    const announce = (view: CampaignView, resumed: boolean): void => {
      if (announced) return;
      announced = true;
      const settings = { ...o.settings, ...view.settings };
      const supervision = view.events.filter((e) => e.type === "campaign.started").length + 1;
      pending.add((journal) =>
        journal.emit(
          "campaign.started",
          { runId: view.runId, supervision, pid, ...(settings.usdPerDay !== undefined ? { usdPerDay: settings.usdPerDay } : {}), ...(settings.until !== undefined ? { until: settings.until } : {}), offPeak: view.offPeak, resumed },
          "orchestrator",
        ),
      );
    };
    for (;;) {
      let view = readCampaign(o.dir);
      if (view === undefined) {
        if (o.first === undefined) throw new Error(`${o.dir} holds no run to continue`);
        const result = await o.first();
        if (result === undefined) return { reason: "not_started", detail: "no run was begun", turns: 0, usd: 0 };
        view = readCampaign(o.dir);
        if (view === undefined) throw new Error("the first turn wrote no journal");
        announce(view, false);
        log(`campaign: turn ${result.turn?.number ?? 1} ended${result.turn !== undefined ? `: ${result.turn.reason}` : ""}`);
      } else {
        announce(view, true);
        const settings = { ...o.settings, ...view.settings };
        const now = clock();
        if (o.signal?.aborted === true) {
          const done = stop(view, { reason: "aborted", detail: "the supervisor was stopped" });
          view.close();
          return done;
        }
        const end = endOf(view, { now });
        if (end !== undefined) {
          const done = stop(view, end);
          view.close();
          return done;
        }
        // The provider's usage limit stopped the last turn: back off 1, 2, 4, ... up to 60 minutes before the next.
        const streak = usageLimitStreak(view.events);
        const waited = view.events.findLastIndex((e) => e.type === "campaign.waiting" && e.data.reason === "usage_limit") > view.events.findLastIndex((e) => e.type === "turn.ended");
        if (streak > 0 && !waited) {
          const minutes = backoffMinutes(streak);
          await wait(view, { reason: "usage_limit", from: now, until: now + minutes * 60_000, detail: `the provider's usage limit stopped the last turn; the next starts in ${minutes} minute(s)` });
          continue;
        }
        // The day's cap: a turn ends when the day's spend reaches it, and the next one waits for the next UTC day.
        const baseline = baseLimit(view.events);
        let limit: TurnLimit = { ...baseline };
        if (settings.usdPerDay !== undefined) {
          const left = settings.usdPerDay - daySpendUsd(view.events, view.p.totalSpend().usd, utcDay(now));
          if (left <= 1e-9) {
            const until = nextUtcDay(now);
            const stopAt = settings.until !== undefined ? Date.parse(settings.until) : Infinity;
            await wait(view, { reason: "daily_cap", from: now, until: Math.min(until, stopAt), detail: `the day's cap of $${settings.usdPerDay} is spent; the next turn starts ${stopAt < until ? `at the end ${settings.until}` : `on ${utcDay(until)}`}` });
            continue;
          }
          limit = { ...limit, usd: Math.min(limit.usd ?? Infinity, left) };
        }
        if (settings.until !== undefined) {
          const minutes = (Date.parse(settings.until) - now) / 60_000;
          if (minutes > 0) limit = { ...limit, minutes: Math.min(limit.minutes ?? Infinity, minutes) };
        }
        pending.flush(view);
        view.close();
        let result: RunResult;
        try {
          result = await o.next({ limit: Object.keys(limit).length > 0 ? limit : undefined });
          thrown = 0;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!usageLimitError(message)) throw error;
          thrown += 1;
          const again = readCampaign(o.dir);
          if (again === undefined) throw error;
          const minutes = backoffMinutes(thrown);
          const at = clock();
          await wait(again, { reason: "usage_limit", from: at, until: at + minutes * 60_000, detail: `the model provider's usage limit was reached (${message.slice(0, 120)}); the next turn starts in ${minutes} minute(s)` });
          continue;
        }
        log(`campaign: turn ${result.turn?.number ?? "?"} ended${result.turn !== undefined ? `: ${result.turn.reason}` : ""}`);
        view = readCampaign(o.dir);
        if (view === undefined) throw new Error("the run lost its journal");
      }
      ended = view.p.turns().ended;
      pulse();
      // The turn is over: the impasse is a change of mode, the digest is rebuilt, and the end is decided from the journal.
      const last = turnRecords(view.events).findLast((t) => t.end !== undefined);
      const bp = last?.end?.breakpoint;
      if (last?.end !== undefined && bp?.kind === "impasse" && !view.events.some((e) => e.type === "campaign.mode_changed" && e.data.turn === last.turn && e.data.mode === "cold_restart")) {
        const turn = last.turn;
        const reason = last.end.detail;
        const runId = view.runId;
        pending.add((journal) => journal.emit("campaign.mode_changed", { runId, turn, mode: "cold_restart", reason, ...(bp.problemId !== undefined ? { problemId: bp.problemId } : {}) }, "orchestrator"));
      }
      // A plateau changes the mode at the next turn, by rule (LH5); not when the guard is about to end the campaign (LH6).
      if (last?.end !== undefined && !view.events.some((e) => e.type === "campaign.mode_changed" && e.data.turn === last.turn && e.data.mode !== "cold_restart")) {
        const scores = scoresByTurn(view.events, view.p, view.frontierOptions);
        const plateauUsd = view.settings.plateauUsd ?? (view.runUsd !== undefined ? view.runUsd / 10 : undefined);
        const change = spiralOf(view.events, scores) !== undefined ? undefined : decidePlateau({ events: view.events, scores, plateauUsd, ctx: plateauContext(view) });
        if (change !== undefined) {
          const runId = view.runId;
          const turn = last.turn;
          pending.add((journal) => journal.emit("campaign.mode_changed", { runId, turn, mode: change.mode, reason: change.reason, ...(change.skipped.length > 0 ? { skipped: change.skipped } : {}), step: change.step }, "orchestrator"));
          log(`campaign: the next turn works in mode ${change.mode}: ${change.reason}`);
        }
      }
      // The dead-end store past its bound: the least active half of what is past it is retired, in the journal and out of view (LH4).
      {
        const retire = retirementOf(view.events, MemoryStore.readOnly(view.p), view.p.problems().map((row) => row.claim_id), view.frontierOptions, view.settings.deadEnds ?? DEFAULT_DEAD_ENDS);
        const runId = view.runId;
        const turn = view.p.turns().ended;
        if (retire.length > 0) pending.add((journal) => journal.emit("campaign.dossier", { runId, turn, retired: retire }, "orchestrator"));
      }
      pending.flush(view);
      view.close();
      const after = readCampaign(o.dir);
      if (after === undefined) throw new Error("the run lost its journal");
      digest = writeDigest(o.dir, renderDigest(after.events, after.p, context(after, "working", { waiting: "the next turn starts by itself" })));
      after.close();
    }
  }
}
