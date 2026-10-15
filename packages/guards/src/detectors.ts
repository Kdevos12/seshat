import type { Json } from "@seshat/core";
import { betterOf, improves, type LeanState } from "@seshat/memory";
import type { DriftKind } from "./drift.ts";

/** The drift detectors (plan §9): what they find, and when they stop a session. */
export type DetectorKind = Extract<DriftKind, "statement_drift" | "restated_target" | "strategy_loop" | "length_growth" | "session_loop">;

export interface Finding {
  kind: DetectorKind;
  /** One typed line: the `drift` node's detail, and the reason the session is stopped for. */
  detail: string;
  /** What the prover's next session is told. Made of this page's words, labels and counts. */
  notice: string;
  /** What was measured, for audit. */
  evidence: { [key: string]: Json };
}

/**
 * Counts consecutive observations that carry the same label and no Lean progress. An observation
 * with progress resets the count to 0 and sets the label; one without progress and with another
 * label starts the count again at 1.
 */
export class StreakCounter {
  label: string | undefined;
  count = 0;

  observe(label: string, progressed: boolean): number {
    if (progressed) {
      this.label = label;
      this.count = 0;
    } else if (label === this.label) {
      this.count += 1;
    } else {
      this.label = label;
      this.count = 1;
    }
    return this.count;
  }
}

/** A name that is safe to show a model: an identifier, clipped. Undefined for anything else. */
export function safeName(name: string | undefined): string | undefined {
  return name !== undefined && /^[\p{L}_][\p{L}\p{N}_'.]*$/u.test(name) ? name.slice(0, 60) : undefined;
}

export interface WatchOptions {
  /** `strategy_loop`: checks in a row with one strategy label and no Lean progress. */
  repeats: number;
  /** `length_growth`: the file's code at least this many times its size at the last progress... */
  lengthFactor: number;
  /** ...and at least this many characters longer. */
  lengthMinChars: number;
}

export const DEFAULT_WATCH: Readonly<WatchOptions> = { repeats: 3, lengthFactor: 2, lengthMinChars: 800 };

/** One `lean_check` of a session, as the detectors read it. */
export interface Observation {
  /** The check's number in the session, from 1. */
  index: number;
  /** The check's strategy label: the one the model declared, else the one computed from the file. */
  label: string;
  state: LeanState;
  /** The size of the file's code, comments and spacing out. */
  size: number;
  /** The check's failure class, if it failed. */
  failureClass?: string;
  /** True when the check made the claim a candidate: nothing is stopped then. */
  accepted: boolean;
  /** An auxiliary lemma that restates the target (M1's `restates_target`) or that the injected predicate finds nearly equivalent. */
  restating?: { name?: string; via: "restates_target" | "predicate" };
}

/** Whether `safeName` gives a name to say the lemma by. */
function lemma(name: string | undefined): string {
  const safe = safeName(name);
  return safe === undefined ? "" : ` ${safe}`;
}

/**
 * The detectors of one session. Each check is observed in order; the first finding ends the
 * session. They are checked in this order: a proved statement that is not the target, an auxiliary
 * lemma that restates it, the same strategy over and over without Lean progress, a file that grows
 * without a closed subgoal. Lean progress is `improves` of `@seshat/memory`: deeper, or fewer
 * errors, or fewer holes than the best check of the session so far.
 */
export class SessionWatch {
  readonly #options: WatchOptions;
  readonly #streak = new StreakCounter();
  #best: LeanState | undefined;
  #baseline: number | undefined;

  constructor(options: Partial<WatchOptions> = {}) {
    this.#options = { ...DEFAULT_WATCH, ...options };
  }

  /** The best state of the session's checks so far. */
  get best(): LeanState | undefined {
    return this.#best;
  }

  observe(o: Observation): Finding | undefined {
    const progressed = improves(o.state, this.#best);
    this.#best = betterOf(o.state, this.#best);
    const count = this.#streak.observe(o.label, progressed);
    if (progressed || this.#baseline === undefined) this.#baseline = o.size;
    if (o.accepted) return undefined;

    if (o.failureClass === "statement_changed") {
      return {
        kind: "statement_drift",
        detail: "the file proves a statement that is not the target",
        notice:
          "The harness stopped your last session: the statement your file proves is not the theorem. " +
          "The statement is fixed. Do not change the definitions, notations or instances that it reads.",
        evidence: { check: o.index, failureClass: o.failureClass },
      };
    }
    if (o.restating !== undefined) {
      return {
        kind: "restated_target",
        detail: `auxiliary lemma${lemma(o.restating.name)} restates the target`,
        notice:
          `The harness stopped your last session: an auxiliary lemma${lemma(o.restating.name)} states the theorem again. ` +
          "A lemma as hard as the theorem is not a step. State smaller steps, each easier than the theorem.",
        evidence: { check: o.index, via: o.restating.via, ...(safeName(o.restating.name) !== undefined ? { lemma: safeName(o.restating.name) as string } : {}) },
      };
    }
    if (count >= this.#options.repeats) {
      const best = this.#best as LeanState;
      return {
        kind: "strategy_loop",
        detail: `${count} checks in a row with the strategy ${o.label}, and Lean got no further`,
        notice:
          `The harness stopped your last session: ${count} checks in a row used the strategy ${o.label} and Lean got no further. ` +
          "Do not go on with that line of attack; try another strategy.",
        evidence: { check: o.index, strategy: o.label, checks: count, bestDepth: best.depth, bestErrors: best.errors, bestHoles: best.holes },
      };
    }
    const base = this.#baseline;
    if (base !== undefined && o.size >= base * this.#options.lengthFactor && o.size - base >= this.#options.lengthMinChars) {
      return {
        kind: "length_growth",
        detail: `the file grew from ${base} to ${o.size} characters and no subgoal was closed`,
        notice:
          `The harness stopped your last session: the file grew from ${base} to ${o.size} characters and no subgoal was closed. ` +
          "Cut it back to the part that works and close one hole before you add more.",
        evidence: { check: o.index, from: base, to: o.size, factor: this.#options.lengthFactor },
      };
    }
    return undefined;
  }
}

/**
 * The same detector across the sessions of one prover: the strategy label of each session's last
 * check, and whether the session's best check went further than any session of the prover before.
 */
export class ProverWatch {
  readonly #streak = new StreakCounter();
  #best: LeanState | undefined;

  /** The best state of the prover's sessions so far. */
  get best(): LeanState | undefined {
    return this.#best;
  }

  observe(label: string, best: LeanState, repeats: number): Finding | undefined {
    const progressed = improves(best, this.#best);
    this.#best = betterOf(best, this.#best);
    const count = this.#streak.observe(label, progressed);
    if (count < repeats) return undefined;
    // The finding restarts the count: the next session is a fresh start.
    this.#streak.label = undefined;
    this.#streak.count = 0;
    return {
      kind: "session_loop",
      detail: `${count} sessions in a row with the strategy ${label}, and Lean got no further`,
      notice:
        `Your last ${count} sessions all used the strategy ${label} and Lean got no further, so your notes were cleared. ` +
        "Start from the file as it is and choose another strategy.",
      evidence: { strategy: label, sessions: count, bestDepth: this.#best?.depth ?? 0, bestErrors: this.#best?.errors ?? 0, bestHoles: this.#best?.holes ?? 0 },
    };
  }
}
