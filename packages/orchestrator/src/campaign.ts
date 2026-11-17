import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HarnessEvent, Journal, Projection, readEvents } from "@seshat/core";
import { frontier, type FrontierOptions, frontierScore, MemoryStore } from "@seshat/memory";
import { type CampaignConfig, DEFAULT_SPIRAL_TURNS, readCampaignConfig } from "./campaign-config.ts";
import { renderDigest, scoresByTurn, writeDigest } from "./campaign-digest.ts";
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
  let count = 0;
  for (let i = scores.length - 1; i >= 0; i--) {
    const now = scores[i] as (typeof scores)[number];
    if (!(now.usd > 0)) continue;
    const before = scores.slice(0, i).at(-1)?.score ?? 0;
    if (now.score > before) break;
    count += 1;
  }
  if (count >= spiral) return { reason: "spiral", detail: `${count} turns in a row spent money and the frontier did not grow: out of reach at this budget, here is what is established` };
  return undefined;
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

const readDigestContext = (view: CampaignView, state: string, extra: { waiting?: string } = {}) => ({
  state,
  ...(view.settings.usdPerDay !== undefined ? { usdPerDay: view.settings.usdPerDay } : {}),
  ...(view.settings.until !== undefined ? { until: view.settings.until } : {}),
  ...(view.runUsd !== undefined ? { allowanceUsd: view.runUsd } : {}),
  ...(extra.waiting !== undefined ? { waiting: extra.waiting } : {}),
  frontierOptions: view.frontierOptions,
});

/** Runs the campaign until it ends. */
export async function runCampaign(o: CampaignOptions): Promise<CampaignEnd> {
  const log = o.log ?? (() => {});
  const pending = new Pending();
  let digest: string | undefined;

  const stop = (view: CampaignView, end: { reason: CampaignStop; detail: string }): CampaignEnd => {
    const f = frontierSummary(view);
    const turns = view.p.turns().ended;
    const usd = view.p.totalSpend().usd;
    pending.add((journal) =>
      journal.emit("campaign.stopped", { runId: view.runId, reason: end.reason, detail: end.detail, turns, usd, frontier: f }, "orchestrator"),
    );
    pending.flush(view);
    digest = writeDigest(o.dir, renderDigest(view.events, view.p, readDigestContext(view, end.reason)));
    log(`campaign ${end.reason === "settled" ? "settled" : `stopped (${end.reason})`}: ${end.detail}`);
    return { reason: end.reason, detail: end.detail, turns, usd, ...(digest !== undefined ? { digest } : {}) };
  };

  for (;;) {
    let view = readCampaign(o.dir);
    if (view === undefined) {
      if (o.first === undefined) throw new Error(`${o.dir} holds no run to continue`);
      const result = await o.first();
      if (result === undefined) return { reason: "not_started", detail: "no run was begun", turns: 0, usd: 0 };
      view = readCampaign(o.dir);
      if (view === undefined) throw new Error("the first turn wrote no journal");
      log(`campaign: turn ${result.turn?.number ?? 1} ended${result.turn !== undefined ? `: ${result.turn.reason}` : ""}`);
    } else {
      if (o.signal?.aborted === true) {
        const ended = stop(view, { reason: "aborted", detail: "the supervisor was stopped" });
        view.close();
        return ended;
      }
      const end = endOf(view, { now: Date.now() });
      if (end !== undefined) {
        const ended = stop(view, end);
        view.close();
        return ended;
      }
      const limit = baseLimit(view.events);
      view.close();
      const result = await o.next({ limit: Object.keys(limit).length > 0 ? limit : undefined });
      log(`campaign: turn ${result.turn?.number ?? "?"} ended${result.turn !== undefined ? `: ${result.turn.reason}` : ""}`);
      view = readCampaign(o.dir);
      if (view === undefined) throw new Error("the run lost its journal");
    }
    // The turn is over: the impasse is a change of mode, the digest is rebuilt, and the end is decided from the journal.
    const last = turnRecords(view.events).findLast((t) => t.end !== undefined);
    const bp = last?.end?.breakpoint;
    if (last?.end !== undefined && bp?.kind === "impasse" && !view.events.some((e) => e.type === "campaign.mode_changed" && e.data.turn === last.turn)) {
      const turn = last.turn;
      const reason = last.end.detail;
      pending.add((journal) =>
        journal.emit("campaign.mode_changed", { runId: view?.runId ?? "", turn, mode: "cold_restart", reason, ...(bp.problemId !== undefined ? { problemId: bp.problemId } : {}) }, "orchestrator"),
      );
    }
    pending.flush(view);
    view.close();
    const after = readCampaign(o.dir);
    if (after === undefined) throw new Error("the run lost its journal");
    digest = writeDigest(o.dir, renderDigest(after.events, after.p, readDigestContext(after, "working", { waiting: "the next turn starts by itself" })));
    after.close();
  }
}
