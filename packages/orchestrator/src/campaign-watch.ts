import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "@seshat/core";
import { sleepFor } from "./offpeak.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * The lock, the heartbeat and the watchdog of a campaign (documentation/campaign.md, "The watchdog"). The lock stops two supervisors working one run; the
 * heartbeat says the supervisor is alive; the watchdog restarts a supervisor that died (a crash, a reboot, a provider's usage limit) after a backoff.
 * None of them is a fact of the run: the journal is, and a restarted supervisor reads everything from it.
 */

/** Whether a process is alive: `kill(pid, 0)` finds it (a process we may not signal exists too). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const lockPath = (dir: string): string => join(dir, "campaign", "lock");
export const heartbeatPath = (dir: string): string => join(dir, "campaign", "heartbeat");

export interface CampaignLock {
  pid: number;
  startedAt: string;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Takes `campaign/lock` (the process's id and its start). A lock whose process is alive refuses the second supervisor; one whose process is gone is
 * stale and is taken over. Returns a function that releases it (only if it is still this supervisor's).
 */
export function acquireLock(dir: string, o: { pid?: number; now?: () => number; isAlive?: (pid: number) => boolean }): () => void {
  const pid = o.pid ?? process.pid;
  const alive = o.isAlive ?? processAlive;
  mkdirSync(join(dir, "campaign"), { recursive: true });
  const body = (): string => `${JSON.stringify({ pid, startedAt: new Date((o.now ?? Date.now)()).toISOString() } satisfies CampaignLock)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath(dir), "wx");
      try {
        writeSync(fd, body());
      } finally {
        closeSync(fd);
      }
      return () => release(dir, pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = readJson<CampaignLock>(lockPath(dir));
    if (held !== undefined && typeof held.pid === "number" && alive(held.pid)) {
      throw new RunSetupError(`another supervisor works this run: process ${held.pid} holds ${lockPath(dir)} (since ${held.startedAt}). Stop it, or let it run; a lock whose process is gone is taken over.`);
    }
    // Stale (or unreadable): taken over.
    try {
      unlinkSync(lockPath(dir));
    } catch {
      // Another supervisor took it first: the next attempt sees whose it is.
    }
  }
  throw new RunSetupError(`the lock ${lockPath(dir)} could not be taken`);
}

function release(dir: string, pid: number): void {
  const held = readJson<CampaignLock>(lockPath(dir));
  if (held?.pid === pid) {
    try {
      unlinkSync(lockPath(dir));
    } catch {
      // Already gone.
    }
  }
}

export interface Heartbeat {
  pid: number;
  /** An ISO instant by the supervisor's clock. */
  at: string;
  /** The turns that have ended in the run when it was written. */
  turn: number;
}

/** Rewrites `campaign/heartbeat`, whole or not at all. */
export function beat(dir: string, o: { pid?: number; now: number; turn: number }): void {
  mkdirSync(join(dir, "campaign"), { recursive: true });
  const file = heartbeatPath(dir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ pid: o.pid ?? process.pid, at: new Date(o.now).toISOString(), turn: o.turn } satisfies Heartbeat)}\n`);
  renameSync(temporary, file);
}

export function readHeartbeat(dir: string): Heartbeat | undefined {
  return existsSync(heartbeatPath(dir)) ? readJson<Heartbeat>(heartbeatPath(dir)) : undefined;
}

/** The minutes a restart or a usage limit waits after its `k`-th failure in a row (from 1): 1, 2, 4, ... up to 60. */
export function backoffMinutes(k: number): number {
  return Math.min(60, 2 ** Math.max(0, Math.min(k, 30) - 1));
}

/** Whether the journal's last word on the campaign is `campaign.stopped`: nothing is left to watch. */
export function campaignOver(dir: string): boolean {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) return false;
  const events = readEvents(path);
  const stopped = events.findLastIndex((e) => e.type === "campaign.stopped");
  return stopped >= 0 && stopped > events.findLastIndex((e) => e.type === "turn.started");
}

/** The turns that have ended in the journal of `dir`, which is how the watchdog tells that a restart made progress. */
function turnsEnded(dir: string): number {
  const path = join(dir, "journal.jsonl");
  return existsSync(path) ? readEvents(path).filter((e) => e.type === "turn.ended").length : 0;
}

export interface WatchOptions {
  dir: string;
  /** Runs a supervisor (`harness campaign --resume DIR`) until it exits; resolves with its exit code. */
  run: () => Promise<number>;
  /** Wall-clock milliseconds. Default `Date.now`. */
  clock?: () => number;
  /** Waits `ms`, or less when the signal aborts. Default a timer; a test advances its clock here. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A heartbeat older than this means the supervisor is dead (default 15 minutes: a turn that is waiting writes one each minute). */
  staleMs?: number;
  /** How often a live supervisor is looked at (default one minute). */
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/**
 * The watchdog: restarts the supervisor when its heartbeat is older than a bound (or there is none and no live lock), after a backoff of 1, 2, 4, ...
 * up to 60 minutes that starts again whenever a restart ended a turn. Returns when the campaign is over (the journal's last word is `campaign.stopped`),
 * the signal aborts, or a supervisor exits with a code that is not a crash.
 */
export async function watchCampaign(o: WatchOptions): Promise<{ restarts: number }> {
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? sleepFor;
  const log = o.log ?? (() => {});
  const stale = o.staleMs ?? 15 * 60_000;
  const poll = o.pollMs ?? 60_000;
  const alive = o.isAlive ?? processAlive;
  const aborted = (): boolean => o.signal?.aborted === true;
  let failures = 0;
  let restarts = 0;
  for (;;) {
    if (aborted() || campaignOver(o.dir)) return { restarts };
    const beating = readHeartbeat(o.dir);
    const lock = readJson<CampaignLock>(lockPath(o.dir));
    const fresh = beating !== undefined && clock() - Date.parse(beating.at) <= stale;
    if (fresh && lock !== undefined && alive(lock.pid)) {
      await sleep(poll, o.signal);
      continue;
    }
    if (failures > 0) {
      const minutes = backoffMinutes(failures);
      log(`watchdog: restarting the supervisor in ${minutes} minute(s) (restart ${restarts + 1})`);
      await sleep(minutes * 60_000, o.signal);
      if (aborted()) return { restarts };
    }
    const before = turnsEnded(o.dir);
    restarts += 1;
    const code = await o.run();
    if (campaignOver(o.dir)) return { restarts };
    // A supervisor that exited cleanly without ending the campaign was stopped by a person: do not restart it behind their back.
    if (code === 0 || code === 130) return { restarts };
    failures = turnsEnded(o.dir) > before ? 1 : failures + 1;
  }
}
