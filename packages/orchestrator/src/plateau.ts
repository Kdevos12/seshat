import type { HarnessEvent } from "@seshat/core";
import { parseSignature } from "@seshat/graph";
import type { FrontierEntry } from "@seshat/memory";

/**
 * Plateau modes (plan change LH5, documentation/campaign.md, "Plateau modes") and the spiral guard (LH6): by rule, with no model role. When the frontier has
 * not grown over a window of spend, the supervisor changes mode at the next turn, in a fixed order, skipping the modes that do not apply. Everything here is a
 * pure function of the journal's events, the per-turn scores and what the run is: the same journal gives the same decision.
 */

export const PLATEAU_MODES = ["specialise", "test", "construct", "read", "reformulate"] as const;
export type PlateauMode = (typeof PLATEAU_MODES)[number];

export const isPlateauMode = (mode: string): mode is PlateauMode => (PLATEAU_MODES as readonly string[]).includes(mode);

/** The lines a mode turns on for its turn; the other lines of a campaign run as the run's configuration says. These three are dormant outside their mode. */
export const MODE_LINES: Readonly<Partial<Record<PlateauMode, string>>> = { specialise: "M18", test: "M11", construct: "M16" };
export const GATED_LINES: readonly string[] = Object.values(MODE_LINES);

/** The options the `construct` mode adds to M16: reject a candidate closer than this normalized edit distance to one already scored, and balance the parents. */
export const CONSTRUCT_OPTIONS = { novelty: 0.15, parentSplit: true } as const;

/** The origin of a claim the `reformulate` mode made. */
export const REFORMULATE_ORIGIN = "campaign.reformulate";

/** The full cycles the spiral detector waits for. */
export const SPIRAL_CYCLES = 2;

/** What decides whether a mode applies to a run. */
export interface PlateauContext {
  /** The signed statement, in signature form. */
  statement: string;
  /** The lines the run enables (`RunConfig.lines`). */
  lines: readonly string[];
  /** `RunConfig.private`: nothing goes to a third party. */
  private: boolean;
  /** The person agreed to the literature step (`intake.consented` allowed, and the intake asks for the literature). */
  literature: boolean;
}

const BINDER = /[({[⦃][^(){}[\]⦃⦄]*:[^(){}[\]⦃⦄]*[)}\]⦄]/;
const EXISTENTIAL_OR_BOUND = /∃|\bexists\b|≤|≥|<|>|\bbound|\bmin\b|\bmax\b/i;

/** The numerals of a statement's type that a generalization can replace by a variable, the largest first; none for a statement without a top-level colon. */
function numerals(statement: string): string[] {
  let type: string;
  try {
    type = parseSignature(statement).type;
  } catch {
    return [];
  }
  const found = [...type.matchAll(/(?<![\p{L}\p{N}_.'])(\d+)(?![\p{L}\p{N}_.'])/gu)].map((m) => m[1] as string).filter((n) => Number(n) >= 2);
  return [...new Set(found)].sort((a, b) => Number(b) - Number(a) || (a < b ? -1 : 1));
}

/**
 * Generalizations of a statement by rule: each replaces every occurrence of one numeral (2 or more) of its type by a new natural-number variable `m`, so
 * that the result is again a Lean statement in signature form, with no status. A statement with no such numeral has none.
 */
export function reformulations(statement: string): string[] {
  let signature: ReturnType<typeof parseSignature>;
  try {
    signature = parseSignature(statement);
  } catch {
    return [];
  }
  const taken = new Set(signature.binders.match(/[\p{L}][\p{L}\p{N}_']*/gu) ?? []);
  let name = "m";
  for (let i = 0; taken.has(name); i++) name = `m${i}`;
  return numerals(statement).map((n) => {
    const replaced = signature.type.replace(new RegExp(`(?<![\\p{L}\\p{N}_.'])${n}(?![\\p{L}\\p{N}_.'])`, "gu"), name);
    return `${signature.binders === "" ? "" : `${signature.binders} `}(${name} : ℕ) : ${replaced}`;
  });
}

/**
 * Whether a mode applies to the statement and the run, and why not. How it is decided:
 * `specialise` needs line M18 and a statement with something to specialise (a binder or a `∀`); `test` always applies (M11's counter-model search with its
 * line, the battery on each `sorry` without one); `construct` needs line M16 and an existential or a bound (`∃`, an inequality, "bound", "min", "max");
 * `read` needs the person's consent to the literature and no `--private`; `reformulate` needs a numeral a generalization can replace.
 */
export function applies(mode: PlateauMode, ctx: PlateauContext): { ok: true } | { ok: false; why: string } {
  const no = (why: string) => ({ ok: false as const, why });
  switch (mode) {
    case "specialise":
      if (!ctx.lines.includes("M18")) return no("line M18 is not enabled");
      return BINDER.test(ctx.statement) || ctx.statement.includes("∀") ? { ok: true } : no("the statement has nothing to specialise");
    case "test":
      return { ok: true };
    case "construct":
      if (!ctx.lines.includes("M16")) return no("line M16 is not enabled");
      return EXISTENTIAL_OR_BOUND.test(ctx.statement) ? { ok: true } : no("the statement is neither an existence nor a bound");
    case "read":
      if (ctx.private) return no("the run is private");
      return ctx.literature ? { ok: true } : no("the person did not agree to the literature step");
    case "reformulate":
      return reformulations(ctx.statement).length > 0 ? { ok: true } : no("no numeral of the statement can be generalized");
  }
}

/** The terms the frontier added, for a new literature query: the `aux_` lemma names and subclaim statements of its entries, clipped and without duplicates. */
export function frontierTerms(entries: readonly Pick<FrontierEntry, "kind" | "statement" | "evidence">[], max = 6): string[] {
  const terms: string[] = [];
  for (const e of entries) {
    if (e.evidence || (e.kind !== "subclaim" && e.kind !== "reduction" && e.kind !== "variant" && e.kind !== "case")) continue;
    const t = e.statement.replace(/\s+/g, " ").trim().slice(0, 100);
    if (t !== "" && !terms.includes(t)) terms.push(t);
    if (terms.length >= max) break;
  }
  return terms;
}

/** The per-turn view of a campaign's frontier: the score at each turn's end and what the turn spent. */
export interface TurnScore {
  turn: number;
  score: number;
  usd: number;
}

type ModeEvent = Extract<HarnessEvent, { type: "campaign.mode_changed" }>;
const plateauEvents = (events: readonly HarnessEvent[]): ModeEvent[] => events.filter((e): e is ModeEvent => e.type === "campaign.mode_changed" && isPlateauMode(e.data.mode));

/** The mode in force for the turn after the last event: the newest plateau mode, if any. */
export function currentMode(events: readonly HarnessEvent[]): PlateauMode | undefined {
  const last = plateauEvents(events).at(-1);
  return last === undefined ? undefined : (last.data.mode as PlateauMode);
}

/** The mode a turn ran in: the newest plateau mode changed after an earlier turn. */
export function modeOfTurn(events: readonly HarnessEvent[], turn: number): PlateauMode | undefined {
  const found = plateauEvents(events).filter((e) => e.data.turn < turn).at(-1);
  return found === undefined ? undefined : (found.data.mode as PlateauMode);
}

const grew = (scores: readonly TurnScore[], i: number): boolean => (scores[i] as TurnScore).score > (scores[i - 1]?.score ?? 0);

/** The dollars the latest turns spent without the frontier growing. */
export function dryUsd(scores: readonly TurnScore[]): number {
  let usd = 0;
  for (let i = scores.length - 1; i >= 0 && !grew(scores, i); i--) usd += (scores[i] as TurnScore).usd;
  return usd;
}

/** How many modes the rule has gone through since the frontier last grew, the skipped ones included. */
export function stepsSinceGrowth(events: readonly HarnessEvent[], scores: readonly TurnScore[]): number {
  let growthSeq = -1;
  for (let i = scores.length - 1; i >= 0; i--) {
    if (!grew(scores, i)) continue;
    const ended = events.find((e) => e.type === "turn.ended" && e.data.turn === (scores[i] as TurnScore).turn);
    growthSeq = ended?.seq ?? -1;
    break;
  }
  return plateauEvents(events).filter((e) => e.seq > growthSeq).reduce((n, e) => n + 1 + (e.data.skipped?.length ?? 0), 0);
}

export interface PlateauChange {
  mode: PlateauMode;
  reason: string;
  skipped: Array<{ mode: string; why: string }>;
  step: number;
}

const money = (usd: number): string => `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;

/**
 * What the supervisor does after a turn ended: nothing (the frontier grew, so a mode that was running stays; or the window has not passed), or the change to
 * the next mode that applies. With no mode in force, the window is `plateauUsd` dollars spent without growth; with one, a turn that ran in it and added
 * nothing passes to the next, and after the fifth the first comes again.
 */
export function decidePlateau(o: { events: readonly HarnessEvent[]; scores: readonly TurnScore[]; plateauUsd: number | undefined; ctx: PlateauContext }): PlateauChange | undefined {
  const { scores } = o;
  const last = scores.at(-1);
  if (last === undefined || grew(scores, scores.length - 1) || !(last.usd > 0)) return undefined;
  const ran = modeOfTurn(o.events, last.turn);
  let from: number;
  let reason: string;
  if (ran !== undefined) {
    from = PLATEAU_MODES.indexOf(ran) + 1;
    reason = `${ran} added nothing to the frontier in turn ${last.turn} (it spent ${money(last.usd)})`;
  } else {
    const dry = dryUsd(scores);
    if (o.plateauUsd === undefined || dry < o.plateauUsd - 1e-9) return undefined;
    from = 0;
    reason = `the frontier has not grown over ${money(dry)} of spend (the window is ${money(o.plateauUsd)})`;
  }
  const skipped: Array<{ mode: string; why: string }> = [];
  for (let k = 0; k < PLATEAU_MODES.length; k++) {
    const mode = PLATEAU_MODES[(from + k) % PLATEAU_MODES.length] as PlateauMode;
    const fit = applies(mode, o.ctx);
    if (fit.ok) return { mode, reason, skipped, step: stepsSinceGrowth(o.events, scores) + 1 + skipped.length };
    skipped.push({ mode, why: fit.why });
  }
  return undefined;
}

/**
 * The spiral guard (LH6): spend without frontier growth across two full cycles of the five modes, that is, `SPIRAL_CYCLES` x 5 turns in a row that worked in a
 * mode and spent money without the frontier growing, the last one included. Counting turns and not the modes passed over keeps a statement for which few
 * modes apply from ending early: its modes come round more often within the same ten turns. There is no plan without the research agent, so the rule
 * "the same plan revision three times" has nothing to read and does not apply.
 */
export function spiralOf(events: readonly HarnessEvent[], scores: readonly TurnScore[]): { turns: number; usd: number } | undefined {
  let turns = 0;
  let usd = 0;
  for (let i = scores.length - 1; i >= 0 && !grew(scores, i); i--) {
    const s = scores[i] as TurnScore;
    if (!(s.usd > 0) || modeOfTurn(events, s.turn) === undefined) break;
    turns += 1;
    usd += s.usd;
  }
  return turns >= SPIRAL_CYCLES * PLATEAU_MODES.length ? { turns, usd } : undefined;
}
