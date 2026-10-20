import { type Posterior, successRate } from "./posterior.ts";

export interface WidthOptions {
  /** A single-agent success rate under which a subgoal is widened. */
  widenBelow: number;
  /** Attempts that must have counted before the rate is evidence: under this, the width is 1. */
  minAttempts: number;
  /** The most provers on one subgoal. */
  maxWidth: number;
  /** The most provers in all on one problem. */
  maxWidthProblem: number;
}

/**
 * How many provers may work on a subgoal at once (plan §11, "adaptive width"): one while a single
 * agent does well or nothing is known, and more as its posterior gets lower, 2 under `widenBelow`,
 * 3 under half of it, 4 under a quarter, up to the caps.
 */
export function widthFor(success: Posterior, o: WidthOptions): number {
  const cap = Math.max(1, Math.floor(Math.min(o.maxWidth, o.maxWidthProblem)));
  if (success.attempts < o.minAttempts) return 1;
  const rate = successRate(success);
  if (rate >= o.widenBelow) return 1;
  return Math.min(cap, 2 + Math.floor(Math.log2(o.widenBelow / Math.max(rate, 1e-6))));
}

/** What the gate decided for a prover about to start a session. */
export interface Admission {
  /** False when the problem ended while the prover waited: it starts no session. */
  admitted: boolean;
  waited: boolean;
  /** The width of the subgoal when the prover was admitted. */
  width: number;
}

export interface AdmitOptions {
  /** The width of the subgoal now: read again each time the prover is woken, for the journal moves. */
  width: () => number;
  /** The most provers alive and ahead of this one, plus itself, on the problem. */
  cap: number;
  /** The problem's signal: aborted when the problem ends, which frees every waiter. */
  signal: AbortSignal;
}

/**
 * Keeps the number of provers working at once on a subgoal to its width, without the provers
 * talking to each other. A prover is `p<number>`; it may start a session when fewer than `width`
 * provers with a lower number are alive on its subgoal (the lowest alive prover is never kept
 * waiting, so the gate cannot deadlock), and fewer than `cap` are alive on the problem. A prover
 * is alive until `ended` says otherwise. The gate holds orchestration state only; what a prover
 * learns from the others goes through the memory, as for any prover.
 */
export class Gate {
  readonly #ended = new Set<number>();
  readonly #subgoal = new Map<number, string>();
  readonly #waiting = new Set<() => void>();

  /** The number of a prover named `p3`, or undefined for any other name. */
  static index(prover: string): number | undefined {
    const match = /^p(\d+)$/.exec(prover);
    return match === null ? undefined : Number(match[1]);
  }

  /** Alive provers with a lower number: those that may take a place before this one. */
  #ahead(index: number): number[] {
    const found: number[] = [];
    for (let j = 1; j < index; j++) if (!this.#ended.has(j)) found.push(j);
    return found;
  }

  /**
   * Whether a prover may start a session on `subgoal` now. A prover ahead that has not started a
   * session yet is counted against every subgoal, until it says which one it works on.
   */
  allowed(prover: string, subgoal: string, width: number, cap: number): boolean {
    const index = Gate.index(prover);
    if (index === undefined) return true;
    const ahead = this.#ahead(index);
    const sameSubgoal = ahead.filter((j) => (this.#subgoal.get(j) ?? subgoal) === subgoal);
    return ahead.length < Math.max(cap, 1) && sameSubgoal.length < Math.max(width, 1);
  }

  /** Waits until the prover may start a session, or the problem ends. */
  async admit(prover: string, subgoal: string, o: AdmitOptions): Promise<Admission> {
    const index = Gate.index(prover);
    let waited = false;
    for (;;) {
      const width = o.width();
      if (o.signal.aborted) return { admitted: false, waited, width };
      if (this.allowed(prover, subgoal, width, o.cap)) {
        if (index !== undefined) this.#subgoal.set(index, subgoal);
        return { admitted: true, waited, width };
      }
      waited = true;
      await new Promise<void>((resolve) => {
        const wake = () => {
          o.signal.removeEventListener("abort", wake);
          this.#waiting.delete(wake);
          resolve();
        };
        this.#waiting.add(wake);
        o.signal.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** The posterior may have moved, or a place been freed: waiting provers look again. The caller wakes them once the attempt that moved it is journaled. */
  wake(): void {
    for (const wake of [...this.#waiting]) wake();
  }

  /** A prover has ended: it is no longer ahead of anyone. */
  ended(prover: string): void {
    const index = Gate.index(prover);
    if (index !== undefined) this.#ended.add(index);
    this.wake();
  }

  /** How many provers are waiting at the gate. */
  get waiting(): number {
    return this.#waiting.size;
  }
}
