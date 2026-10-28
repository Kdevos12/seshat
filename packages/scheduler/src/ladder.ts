import type { MemoryStore } from "@seshat/memory";
import { asRecord, SKETCH_KIND, type SketchRecord } from "./records.ts";

/**
 * The escalation ladder of a problem (PE4 of `plans/plan-change-memory-evolution.md`, documentation/scheduler.md,
 * "The ladder"). Rung 0 is the provers with the lines that work from the start; each higher rung is made of the
 * enabled lines that say they belong to it (`Line.rung`). A problem moves up one rung when a fraction of its
 * budget is spent since the last Lean progress, the fractions growing with the rung (0.3, then 0.6 by default).
 */

/** The default fractions of the problem's budget: the first move up, the second. */
export const DEFAULT_FRACTIONS: readonly number[] = [0.3, 0.6];

/** What counts as Lean progress on a problem. */
export interface Progress {
  /** Subclaims of the problem's claim that Lean accepted (`computed` or `proved`). */
  proved: number;
  /** Open holes in the best healthy sketch, or undefined when no healthy sketch exists. */
  holes: number | undefined;
}

export const NO_PROGRESS: Readonly<Progress> = { proved: 0, holes: undefined };

/** The subclaims of a claim: what it decomposes into, all the way down (`decomposes_into` edges of any status). */
export function subclaims(memory: MemoryStore, claimId: string): string[] {
  const seen = new Set<string>([claimId]);
  const out: string[] = [];
  for (let queue = [claimId]; queue.length > 0; ) {
    const next: string[] = [];
    for (const id of queue) {
      for (const edge of memory.edges({ from: id, kinds: ["decomposes_into"] })) {
        for (const part of edge.to) {
          if (seen.has(part)) continue;
          seen.add(part);
          out.push(part);
          next.push(part);
        }
      }
    }
    queue = next;
  }
  return out;
}

const accepted = (memory: MemoryStore, id: string): boolean => {
  const status = memory.claim(id)?.status;
  return status === "computed" || status === "proved";
};

/**
 * Where the problem stands, read from the memory: the subclaims Lean accepted, and the holes still open in the
 * healthy sketch with the fewest (a sketch that checked with only its named holes open: `m12_sketch` nodes).
 */
export function progressOf(memory: MemoryStore, problemId: string, claimId: string): Progress {
  const proved = subclaims(memory, claimId).filter((id) => accepted(memory, id)).length;
  let holes: number | undefined;
  for (const node of memory.nodes(SKETCH_KIND, { claimId })) {
    const sketch = asRecord<SketchRecord>(node.data);
    if (sketch.problemId !== problemId || !sketch.healthy || !sketch.registered) continue;
    const open = sketch.holes.filter((id) => !accepted(memory, id)).length;
    holes = holes === undefined ? open : Math.min(holes, open);
  }
  return { proved, holes };
}

/** Whether `now` is progress over `before`: a new proved subclaim, or fewer open holes in the best healthy sketch. */
export function progressed(before: Progress, now: Progress): string | undefined {
  if (now.proved > before.proved) return `${now.proved - before.proved} more subclaim(s) proved (${now.proved} in all)`;
  if (now.holes !== undefined && (before.holes === undefined || now.holes < before.holes)) {
    return before.holes === undefined ? `a healthy sketch with ${now.holes} open hole(s)` : `the best healthy sketch has ${now.holes} open hole(s), from ${before.holes}`;
  }
  return undefined;
}

/** A rung above 0: the lines that make it. */
export interface Rung {
  lines: string[];
}

export interface LadderDue {
  from: number;
  to: number;
  lines: string[];
  threshold: number;
}

/**
 * The move up the ladder a problem is due, or undefined. `rung` is where the problem is (0 to `rungs.length`),
 * `sinceProgressUsd` what it spent since its last Lean progress, `budgetUsd` the problem's whole budget. The
 * fraction for the next move is `fractions[rung]`, the last one for any rung beyond the list. A problem moves up
 * one rung at a time; when its spend has passed the fractions of two rungs, it moves again on the next check.
 */
export function ladderDue(rungs: readonly Rung[], fractions: readonly number[], state: { rung: number; sinceProgressUsd: number; budgetUsd: number }): LadderDue | undefined {
  if (state.rung >= rungs.length || !(state.budgetUsd > 0) || fractions.length === 0) return undefined;
  const threshold = fractions[Math.min(state.rung, fractions.length - 1)] as number;
  if (state.sinceProgressUsd < threshold * state.budgetUsd - 1e-9) return undefined;
  const next = rungs[state.rung] as Rung;
  return { from: state.rung, to: state.rung + 1, lines: next.lines, threshold };
}

/** The rungs of a set of lines: the distinct rungs above 0, in order, each with the lines that belong to it. A rung no line has does not exist. */
export function rungsOf(lines: ReadonlyArray<{ id: string; rung?: number | undefined }>): Rung[] {
  const numbers = [...new Set(lines.flatMap((line) => (line.rung !== undefined && line.rung > 0 ? [line.rung] : [])))].sort((a, b) => a - b);
  return numbers.map((n) => ({ lines: lines.filter((line) => line.rung === n).map((line) => line.id) }));
}
