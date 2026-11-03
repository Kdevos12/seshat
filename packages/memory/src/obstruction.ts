import type { Json } from "@seshat/core";

/**
 * Obstructions (plan change PC3): a typed record of why an approach cannot work on a claim. M1's
 * "already tried" is a summary of attempts; an obstruction is a reason, found by a mechanism (a
 * counter-model, a refuted premise, a refutation side that found nothing, a statement that differs
 * from the one meant), shared by M1's section, M2, M5, M11 and the research team's account.
 */
export const OBSTRUCTION_KIND = "obstruction";

/** The reasons an approach cannot work. */
export const OBSTRUCTION_REASONS = ["counterexample", "refuted_premise", "nogood", "statement_mismatch"] as const;
export type ObstructionReason = (typeof OBSTRUCTION_REASONS)[number];

export function isObstructionReason(value: unknown): value is ObstructionReason {
  return typeof value === "string" && (OBSTRUCTION_REASONS as readonly string[]).includes(value);
}

/** The longest detail kept, in characters. */
export const MAX_OBSTRUCTION_DETAIL = 300;

/** The data of an `obstruction` node. `summary` is the one line the research team's account reads. */
export interface ObstructionData {
  reason: ObstructionReason;
  /** What was found, in one line: the counter-model, the premise, the dead end. */
  detail: string;
  /** The strategy label the obstruction rules out, when it is about one. */
  strategy?: string;
  /** The actor that recorded it (`line:M2`). */
  source: string;
  summary: string;
  [key: string]: Json | undefined;
}

export interface ObstructionInput {
  claimId: string;
  reason: ObstructionReason;
  detail: string;
  strategy?: string;
}

/** An obstruction as the store reads it back. */
export interface Obstruction {
  /** True for a record of an epoch before the current one (another model family, prompt or Mathlib revision): it is in probation. */
  earlier?: boolean;
  nodeId: string;
  claimId: string;
  reason: ObstructionReason;
  detail: string;
  strategy?: string;
  source: string;
}

/** Collapses white space and cuts a detail to the longest kept. */
export function normalizeDetail(detail: string): string {
  const clean = detail.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_OBSTRUCTION_DETAIL ? clean : `${clean.slice(0, MAX_OBSTRUCTION_DETAIL - 1)}…`;
}

/**
 * The line an obstruction shows in "already tried". A `counterexample` or `refuted_premise` is something Lean evaluated; a
 * `nogood` is a heuristic ("found nothing"), so it is worded as what was tried and not as a fact; a record of an earlier epoch says so.
 */
export function describeObstruction(o: Pick<Obstruction, "reason" | "detail" | "strategy" | "earlier">): string {
  const label = o.reason === "nogood" ? "tried, found nothing" : o.reason.replace(/_/g, " ");
  return `${label}${o.strategy !== undefined ? ` (${o.strategy})` : ""}: ${o.detail}${o.earlier === true ? " [earlier epoch: may be out of date]" : ""}`;
}

/** The obstructions' lines of a briefing: one line each, cut at `maxLines` with a last line that counts the rest. */
export function renderObstructions(obstructions: readonly Obstruction[], options: { maxLines: number }): string[] {
  const max = Math.floor(options.maxLines);
  if (obstructions.length === 0 || max < 2) return [];
  const intro = "What the harness's tools found out about this claim:";
  if (obstructions.length <= max - 1) return [intro, ...obstructions.map(describeObstruction)];
  const shown = obstructions.slice(0, Math.max(max - 2, 0));
  const left = obstructions.length - shown.length;
  return [intro, ...shown.map(describeObstruction), `... and ${left} more obstruction${left === 1 ? "" : "s"}`];
}
