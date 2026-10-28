import type { RandomSource } from "@seshat/core";

/** An item of the given-clause loop: a task on a claim, with the two numbers selection reads. */
export interface Clause {
  id: string;
  /** Order of arrival: lower is older. */
  age: number;
  /** Expected cost of working on it: lower is lighter (documentation/scheduler.md, "Weight"). */
  weight: number;
}

/** The age/weight ratio: out of `age + weight` picks, `age` go to the oldest and `weight` to the lightest. */
export interface Ratio {
  age: number;
  weight: number;
}

export const DEFAULT_RATIO: Readonly<Ratio> = { age: 1, weight: 4 };

export interface Pick<T extends Clause> {
  clause: T;
  /** Which of the two orders made the pick. */
  rule: "age" | "weight";
}

/**
 * The given-clause loop's two sets (graphe-donnees.md section 1): the passive queue, work waiting,
 * and the active set, work that was given at least once. `select` moves one clause from passive to
 * active, by the age/weight ratio: on a cycle of `age + weight` picks, the first `age` take the
 * oldest clause and the others the lightest. Picking only the lightest loses clauses that are never
 * treated; the age picks are the guarantee that every clause is given within one cycle of its turn
 * at the head of the age order (fairness). The cycle position is the number of picks made so far,
 * which the caller keeps (the scheduler counts its `schedule` nodes), so a process that starts again
 * continues the cycle where it was. Ties are broken by the seeded `random`, and by age without one.
 */
export class GivenClause<T extends Clause> {
  readonly passive = new Map<string, T>();
  readonly active = new Map<string, T>();
  picks: number;
  readonly ratio: Ratio;

  constructor(ratio: Ratio = DEFAULT_RATIO, picks = 0) {
    if (!(ratio.age >= 0 && ratio.weight >= 0 && ratio.age + ratio.weight > 0)) throw new Error("the ratio needs at least one pick in its cycle");
    this.ratio = ratio;
    this.picks = picks;
  }

  add(clause: T): void {
    if (this.active.has(clause.id)) return;
    this.passive.set(clause.id, clause);
  }

  /** A clause that is no longer wanted (its claim was settled): out of both sets. */
  remove(id: string): boolean {
    return this.passive.delete(id) || this.active.delete(id);
  }

  /** The order the next pick takes. */
  nextRule(): "age" | "weight" {
    return this.picks % (this.ratio.age + this.ratio.weight) < this.ratio.age ? "age" : "weight";
  }

  select(random?: RandomSource): Pick<T> | undefined {
    if (this.passive.size === 0) return undefined;
    const rule = this.nextRule();
    const key = (c: T): number => (rule === "age" ? c.age : c.weight);
    const all = [...this.passive.values()];
    const best = Math.min(...all.map(key));
    const tied = all.filter((c) => key(c) === best).sort((a, b) => a.age - b.age);
    const clause = random === undefined ? (tied[0] as T) : (tied[Math.min(Math.floor(random() * tied.length), tied.length - 1)] as T);
    this.passive.delete(clause.id);
    this.active.set(clause.id, clause);
    this.picks += 1;
    return { clause, rule };
  }
}
