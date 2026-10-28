import type { RandomSource } from "@seshat/core";

/** The knobs of the randomized inclusion (plan change PE2): the defaults are the plan's. */
export interface DrawOptions {
  /** The chance that an item is included while it is new. Default 0.5. */
  pNew: number;
  /** How many uses an item is new for: the first `nNew` times it was included. Default 20. */
  nNew: number;
  /** The chance that an item is included once it is established. Default 0.9. */
  p: number;
}

export const DEFAULT_DRAW: Readonly<DrawOptions> = { pNew: 0.5, nNew: 20, p: 0.9 };

/**
 * An unverified item a line selected for a session: a lesson, a schema hint, an inspiration example,
 * a library hint section. `verified: true` says it is a verified fact after all, which is never drawn.
 */
export interface DrawItem {
  id: string;
  verified?: boolean;
}

/** The outcome of a draw. */
export interface Draw {
  /** The unverified items the session is shown, in the order they were given. */
  included: string[];
  /** The ones the draw left out of this session, in the order they were given. */
  withheld: string[];
  /**
   * The items that were not drawn because they are not unverified: a claim (the goal or a fact) or an
   * item flagged `verified`. They are always shown, and appear in neither list above.
   */
  fixed: string[];
  /** The chance each drawn item had of being included. */
  chances: Record<string, number>;
  /** How many times each drawn item had been included since the epoch began, before this draw. */
  uses: Record<string, number>;
}

export function checkDrawOptions(o: DrawOptions): DrawOptions {
  for (const [name, value] of [["pNew", o.pNew], ["p", o.p]] as const) {
    if (!(value >= 0 && value <= 1)) throw new RangeError(`the draw option ${name} must be a probability, got ${value}`);
  }
  if (!Number.isInteger(o.nNew) || o.nNew < 0) throw new RangeError(`the draw option nNew must be a whole number of uses, got ${o.nNew}`);
  return o;
}

/**
 * The draw itself, with what the store knows passed in: `isFact` says an id names a claim, `uses` gives
 * the uses of an item. Each unverified item is included with probability `pNew` while it has been used
 * fewer than `nNew` times, then `p`, from `random`. The items are drawn in the order of their ids, one
 * number each, so the result depends on the seed and the set of items and not on the order a line
 * listed them in.
 */
export function drawItems(
  items: readonly (string | DrawItem)[],
  random: RandomSource,
  known: { isFact: (id: string) => boolean; uses: (id: string) => number },
  options: Partial<DrawOptions> = {},
): Draw {
  const o = checkDrawOptions({ ...DEFAULT_DRAW, ...options });
  const listed: DrawItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = typeof item === "string" ? { id: item } : item;
    if (entry.id === "") throw new Error("a drawn item needs an id");
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    listed.push(entry);
  }
  const fixed = listed.filter((item) => item.verified === true || known.isFact(item.id)).map((item) => item.id);
  const fixedSet = new Set(fixed);
  const drawn = listed.filter((item) => !fixedSet.has(item.id));
  const chances: Record<string, number> = {};
  const uses: Record<string, number> = {};
  const outcome = new Map<string, boolean>();
  for (const item of [...drawn].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const used = known.uses(item.id);
    const chance = used < o.nNew ? o.pNew : o.p;
    uses[item.id] = used;
    chances[item.id] = chance;
    outcome.set(item.id, random() < chance);
  }
  return {
    included: drawn.filter((item) => outcome.get(item.id) === true).map((item) => item.id),
    withheld: drawn.filter((item) => outcome.get(item.id) === false).map((item) => item.id),
    fixed,
    chances,
    uses,
  };
}
