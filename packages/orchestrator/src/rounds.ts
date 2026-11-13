import type { HarnessEvent, Journal } from "@seshat/core";
import { failureDepth, VALID_DEPTH } from "@seshat/memory";
import { type Progress, progressed } from "@seshat/scheduler";
import { PROGRESS_DEPTH } from "./budget-gate.ts";

/**
 * A run's budget in rounds (plan change CA8, documentation/scheduler.md, "The budget in rounds"). With a run budget `runUsd` and K problems,
 * the problems are worked round-robin: in round r a problem may have spent at most `runUsd / (4K) * 2^r` in all. A problem without Lean
 * progress at the end of its round is parked, and what it did not spend stays in the run's budget; the parked problems are taken up again only
 * when every other problem is solved, parked or over and budget remains. A solved problem leaves the rotation. Nothing here decides how a
 * problem is worked inside its slice: the rotation only says which problem gets the next slice and how large it is.
 */

/** What a problem had reached at one moment: the ladder's measure of Lean progress, and the depth of its best check. */
export interface Mark {
  proved: number;
  holes: number | null;
  depth: number;
}

export const NO_MARK: Readonly<Mark> = { proved: 0, holes: null, depth: -1 };

/**
 * The most a problem may have spent in all in round `round`: round 0 gets a quarter of its share of the run budget, but never less than
 * `floorUsd`, the cost of one probe (PA5: a probe costs $0.03 to $0.07, and a quarter of a share of $0.0169 paid for none), and each round
 * doubles the one before. `floorUsd` is zero when there is no probe, and is at most the problem's allowance (a slice never exceeds it anyway).
 */
export function roundCap(runUsd: number, k: number, round: number, floorUsd = 0): number {
  return Math.max(runUsd / (4 * Math.max(1, k)), floorUsd) * 2 ** round;
}

/** The mark of a problem from the ladder's measure and its attempts' rows. */
export function markOf(progress: Progress, attempts: ReadonlyArray<{ outcome: string | null; failure_class: string | null; last_check_class?: string | null }>): Mark {
  let depth = -1;
  for (const row of attempts) {
    // A session the slice cut has no failure class, but the prover records the class of its last check apart (`lastCheckClass`).
    const cls = row.failure_class ?? row.last_check_class ?? null;
    const d = row.outcome === "valid" ? VALID_DEPTH : cls === null ? undefined : failureDepth(cls);
    if (d !== undefined && d > depth) depth = d;
  }
  return { proved: progress.proved, holes: progress.holes ?? null, depth };
}

/**
 * Whether `now` is Lean progress over `before`, in words, or undefined. The ladder's measure (a subclaim proved, fewer open holes), and, as the
 * budget gate's probe reads it, a check that passed or that typed every step and left only goals (`PROGRESS_DEPTH`) where none had.
 */
export function markProgress(before: Mark | undefined, now: Mark): string | undefined {
  const base = before ?? NO_MARK;
  const why = progressed({ proved: base.proved, holes: base.holes ?? undefined }, { proved: now.proved, holes: now.holes ?? undefined });
  if (why !== undefined) return why;
  if (now.depth > base.depth && now.depth >= PROGRESS_DEPTH) return `a check got further (depth ${now.depth}, from ${base.depth})`;
  return undefined;
}

/** What the journal says of the rotation: the last round, who was parked, in the order they were recorded. */
export interface RecordedRounds {
  round: number;
  capUsd: number;
  problems: string[];
  marks: { [problemId: string]: Mark };
  /** Problems parked and not taken up again since. */
  parked: string[];
  /** Problems already parked at the end of the last round. */
  parkedInRound: string[];
}

export function recordedRounds(events: readonly HarnessEvent[]): RecordedRounds | undefined {
  let last: RecordedRounds | undefined;
  const parked: string[] = [];
  for (const event of events) {
    if (event.type === "budget.round") {
      const d = event.data;
      for (const id of d.problems) {
        const at = parked.indexOf(id);
        if (at >= 0) parked.splice(at, 1);
      }
      last = { round: d.round, capUsd: d.capUsd, problems: [...d.problems], marks: { ...(d.marks ?? {}) }, parked: [], parkedInRound: [] };
    } else if (event.type === "problem.parked") {
      if (!parked.includes(event.data.problemId)) parked.push(event.data.problemId);
      if (last !== undefined && event.data.round === last.round) last.parkedInRound.push(event.data.problemId);
    }
  }
  if (last !== undefined) last.parked = [...parked];
  return last;
}

export interface Grant {
  round: number;
  capUsd: number;
}

export interface RotationOptions {
  runUsd: number;
  k: number;
  /** The least round 0 gives a problem: the probe's cap (`roundCap`). Absent: none. */
  floorUsd?: number;
  concurrency: number;
  /** The problems in the order they are worked, for a run that begins. */
  order: readonly string[];
  journal: Journal;
  /** Where a problem stands now. */
  measure: (problemId: string) => Mark;
  /** What a problem has spent in all. */
  spent: (problemId: string) => number;
  /** True when no more slices are to be given: the run's budget is spent, it was stopped, or its turn ended. */
  over: () => boolean;
  log: (text: string) => void;
  /** Whether a problem already has a candidate: it needs no slice, only the end that its coroutine gives it (it counts as unfinished, not as sliced). */
  found?: (problemId: string) => boolean;
  /** What the journal of the run before the interruption says, and which problems have an outcome already. */
  recorded?: RecordedRounds;
  finished?: ReadonlySet<string>;
}

type State = "todo" | "running" | "sliced" | "done";

/**
 * The rotation. A problem's coroutine asks for its slice with `acquire`, works it, and then either says it is `done` or asks for the next one
 * with `next`, which waits until the problem's next round. Slices are given in the order of the round, at most `concurrency` at a time, so the
 * same journal and the same outcomes give the same rotation.
 */
export class Rotation {
  readonly #o: RotationOptions;
  #round = 0;
  #cap = 0;
  #active: string[] = [];
  readonly #state = new Map<string, State>();
  readonly #baseline = new Map<string, Mark>();
  readonly #parked: string[] = [];
  readonly #waiting = new Map<string, (grant: Grant | undefined) => void>();
  #running = 0;
  #closed = false;

  constructor(options: RotationOptions) {
    this.#o = options;
  }

  get round(): number {
    return this.#round;
  }

  /** Starts the first round, or the one the journal ends on. Call it once, before any problem asks for a slice. */
  begin(): void {
    const o = this.#o;
    const r = o.recorded;
    const done = (id: string) => o.finished?.has(id) ?? false;
    if (r === undefined) {
      this.#active = o.order.filter((id) => !done(id));
      this.#startRound(0, [], undefined);
      return;
    }
    this.#round = r.round;
    this.#cap = r.capUsd;
    this.#active = r.problems.filter((id) => !done(id));
    this.#parked.push(...r.parked.filter((id) => !done(id)));
    for (const id of r.problems) {
      const base = r.marks[id];
      if (base !== undefined) this.#baseline.set(id, base);
      // A slice is over when the problem spent its cap, or the round already parked it; a problem with an outcome is over.
      const sliced = done(id) ? "done" : (r.parkedInRound.includes(id) || o.spent(id) >= r.capUsd - 1e-9) && !(o.found?.(id) ?? false) ? "sliced" : "todo";
      this.#state.set(id, sliced);
    }
    this.#pump();
  }

  /** The next slice of a problem, or undefined when there are no more. Waits for the problem's turn. */
  acquire(problemId: string): Promise<Grant | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.#waiting.set(problemId, resolve);
      this.#pump();
    });
  }

  /** The problem's slice is over and it goes on: asks for its next slice, which comes with a later round. */
  next(problemId: string): Promise<Grant | undefined> {
    if (this.#state.get(problemId) === "running") this.#running -= 1;
    if (this.#state.has(problemId)) this.#state.set(problemId, "sliced");
    return this.acquire(problemId);
  }

  /** The problem has an outcome, or was never worked: it leaves the rotation. */
  done(problemId: string): void {
    if (this.#state.get(problemId) === "running") this.#running -= 1;
    this.#state.set(problemId, "done");
    this.#waiting.delete(problemId);
    this.#pump();
  }

  #pump(): void {
    if (this.#closed) return;
    if (this.#o.over()) return this.#close();
    for (;;) {
      const id = this.#active.find((x) => this.#state.get(x) === "todo");
      if (id !== undefined) {
        // Slices are given in the round's order: the next one waits for its problem to ask, and for a free place.
        const resolve = this.#waiting.get(id);
        if (this.#running >= this.#o.concurrency || resolve === undefined) return;
        this.#waiting.delete(id);
        this.#state.set(id, "running");
        this.#running += 1;
        resolve({ round: this.#round, capUsd: this.#cap });
        continue;
      }
      if (this.#running > 0) return;
      // Every slice of the round is over.
      if (!this.#endRound()) return;
    }
  }

  /** Parks the problems without progress and starts the next round; false when the rotation is over. */
  #endRound(): boolean {
    const o = this.#o;
    const marks = new Map<string, Mark>();
    const stayed: string[] = [];
    for (const id of this.#active) {
      if (this.#state.get(id) !== "sliced") continue;
      const now = o.measure(id);
      marks.set(id, now);
      const why = markProgress(this.#baseline.get(id), now);
      const already = o.recorded?.parkedInRound.includes(id) === true && this.#parked.includes(id);
      if (why !== undefined) {
        stayed.push(id);
        continue;
      }
      if (!this.#parked.includes(id)) this.#parked.push(id);
      if (!already) {
        const usd = o.spent(id);
        o.journal.emit(
          "problem.parked",
          { problemId: id, round: this.#round, usd, capUsd: this.#cap, reason: `no Lean progress in round ${this.#round}: it had spent $${usd.toFixed(4)} of its $${this.#cap.toFixed(4)}` },
          "orchestrator",
        );
        o.log(`round ${this.#round}: ${id} is parked, with no Lean progress after $${usd.toFixed(2)}`);
      }
    }
    if (o.over()) {
      this.#close();
      return false;
    }
    let resumed: string[] = [];
    let next = stayed;
    if (next.length === 0 && this.#parked.length > 0) {
      resumed = this.#parked.splice(0);
      next = resumed;
    }
    if (next.length === 0) {
      this.#close();
      return false;
    }
    this.#active = next;
    this.#startRound(this.#round + 1, resumed, marks);
    return true;
  }

  #startRound(round: number, resumed: string[], marks: Map<string, Mark> | undefined): void {
    const o = this.#o;
    this.#round = round;
    this.#cap = roundCap(o.runUsd, o.k, round, o.floorUsd);
    const at = new Map<string, Mark>();
    if (round > 0) for (const id of this.#active) at.set(id, marks?.get(id) ?? o.measure(id));
    this.#baseline.clear();
    for (const [id, mark] of at) this.#baseline.set(id, mark);
    for (const id of this.#active) this.#state.set(id, "todo");
    if (this.#active.length === 0) return this.#close();
    o.journal.emit(
      "budget.round",
      {
        round,
        capUsd: this.#cap,
        runUsd: o.runUsd,
        problems: [...this.#active],
        ...(round > 0 ? { marks: Object.fromEntries(at) } : {}),
        ...(resumed.length > 0 ? { resumed } : {}),
      },
      "orchestrator",
    );
    o.log(`round ${round}: ${this.#active.length} problem(s), at most $${this.#cap.toFixed(4)} each in all${resumed.length > 0 ? `, ${resumed.length} taken up again from parking` : ""}`);
  }

  #close(): void {
    this.#closed = true;
    for (const resolve of this.#waiting.values()) resolve(undefined);
    this.#waiting.clear();
  }
}
