import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type HarnessEvent, readEvents } from "@seshat/core";
import { buildResult, money } from "./result.ts";

/**
 * Live progress of a run on the command line (plan change UX3, documentation/quickstart.md, "Progress while it works"): one line each
 * time a session ends, a Lean check is counted or a problem moves, read from the journal by the same `buildResult` that writes RESULT.md.
 * It reads the journal file and writes nothing; it never changes what a run does.
 */
export interface Progress {
  /** Seconds from the journal's first event to its last. */
  seconds: number;
  /** Sessions that ended (`attempt.finished`). */
  sessions: number;
  /** Lean checks those sessions made. */
  checks: number;
  problems: number;
  /** Problems whose claim passed the fast check and is not certified. */
  candidates: number;
  /** Problems proved or refuted by a kernel replay. */
  certified: number;
  usd: number;
  budgetUsd?: number;
}

/** The progress a journal shows. */
export function progressOf(events: readonly HarnessEvent[]): Progress {
  const result = buildResult(events);
  let sessions = 0;
  let checks = 0;
  for (const e of events) {
    if (e.type !== "attempt.finished") continue;
    sessions += 1;
    checks += e.data.checks ?? 0;
  }
  return {
    seconds: result.seconds,
    sessions,
    checks,
    problems: result.problems.length,
    candidates: result.problems.filter((p) => !p.certified && p.claimStatus === "computed").length,
    certified: result.problems.filter((p) => p.certified).length,
    usd: result.spend.usd,
    ...(result.spend.budgetUsd !== undefined ? { budgetUsd: result.spend.budgetUsd } : {}),
  };
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** One line: `[4:12] $0.3100 of $2.00 · 6 sessions · 23 Lean checks · 1 candidate of 1 problem, not certified yet`. */
export function progressLine(p: Progress): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const standing =
    p.certified > 0
      ? `${p.certified} of ${plural(p.problems, "problem")} certified`
      : p.candidates > 0
        ? `${plural(p.candidates, "candidate")} of ${plural(p.problems, "problem")}, not certified yet`
        : `nothing proved yet`;
  return `[${clock(p.seconds)}] ${money(p.usd)}${p.budgetUsd !== undefined ? ` of ${money(p.budgetUsd)}` : ""} · ${plural(p.sessions, "session")} · ${plural(p.checks, "Lean check")} · ${standing}`;
}

/** What a line is printed for: a change here prints a new line; time and cents alone do not. */
const key = (p: Progress): string => [p.sessions, p.checks, p.candidates, p.certified, p.problems].join(":");

export interface ProgressWatch {
  /** Reads the journal once, and prints a line when the run moved. */
  poll(): void;
  /** Stops the timer (a last poll first). */
  stop(): void;
}

/**
 * Follows `RUN_DIR/journal.jsonl` while a command works: every `intervalMs` (default 5 s) it reads the journal when the file grew and prints
 * a line when a session ended, a check was counted or a problem moved. Nothing is printed before the first session ends (so a signature
 * asked on the terminal is not interrupted). A journal that cannot be read yet is skipped until the next poll.
 */
export function watchProgress(dir: string, out: (line: string) => void, o: { intervalMs?: number } = {}): ProgressWatch {
  const file = join(dir, "journal.jsonl");
  let size = -1;
  let last: string | undefined;
  const poll = () => {
    try {
      if (!existsSync(file)) return;
      const now = statSync(file).size;
      if (now === size) return;
      size = now;
      const p = progressOf(readEvents(file));
      if (p.sessions === 0 && p.certified === 0) return;
      const k = key(p);
      if (k === last) return;
      last = k;
      out(progressLine(p));
    } catch {
      // A journal being written, or one buildResult cannot read yet: the next poll tries again.
    }
  };
  const timer = setInterval(poll, o.intervalMs ?? 5000);
  timer.unref();
  return {
    poll,
    stop() {
      clearInterval(timer);
      poll();
    },
  };
}
