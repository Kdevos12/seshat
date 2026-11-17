import type { ValidationReport } from "@seshat/core";
import { classifyFailure, type FailureClass, normalizeDetail } from "@seshat/memory";

/**
 * Cold restarts on a schedule (plan change LH3, documentation/runs.md, "Restarts"): a prover's successive sessions each start from the
 * frontier, the dead ends and the state card, with a step limit that the schedule gives by the session's index, and a session whose
 * checks keep failing the same way ends early. Off by default.
 */
export interface RestartsConfig {
  /** `geometric`: the session step limits are base, 2 x base, 4 x base, ...; `luby`: base times Luby's sequence 1, 1, 2, 1, 1, 2, 4, ... Default `geometric`. */
  schedule?: "geometric" | "luby";
  /** The unit of the schedule, in steps (model responses). Default 6. */
  base?: number;
  /** The same failure class on the same goal in this many consecutive `lean_check`s ends the session as a restart. Default 3. */
  stuckChecks?: number;
}

export const RESTART_SCHEDULES = ["geometric", "luby"] as const;
export const DEFAULT_RESTART_BASE = 6;
export const DEFAULT_STUCK_CHECKS = 3;

/** The restart settings with their defaults. */
export interface ResolvedRestarts {
  schedule: "geometric" | "luby";
  base: number;
  stuckChecks: number;
}

export function resolveRestarts(config: RestartsConfig): ResolvedRestarts {
  return { schedule: config.schedule ?? "geometric", base: config.base ?? DEFAULT_RESTART_BASE, stuckChecks: config.stuckChecks ?? DEFAULT_STUCK_CHECKS };
}

/** What `RunConfig.restarts` allows: `schedule` one of the two names, `base` and `stuckChecks` whole numbers of 1 or more. Problems in words; empty: fine. */
export function restartsConfigProblems(config: unknown): string[] {
  if (config === undefined) return [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["restarts must be an object: { schedule?: \"geometric\" | \"luby\", base?: number, stuckChecks?: number }"];
  const c = config as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(c)) if (key !== "schedule" && key !== "base" && key !== "stuckChecks") problems.push(`restarts.${key} is not a setting (schedule, base, stuckChecks)`);
  if (c.schedule !== undefined && !(RESTART_SCHEDULES as readonly unknown[]).includes(c.schedule)) problems.push(`restarts.schedule must be one of ${RESTART_SCHEDULES.join(", ")}, got ${String(c.schedule)}`);
  for (const key of ["base", "stuckChecks"] as const) {
    if (c[key] !== undefined && !(typeof c[key] === "number" && Number.isInteger(c[key]) && (c[key] as number) >= 1)) problems.push(`restarts.${key} must be a whole number of at least 1, got ${String(c[key])}`);
  }
  return problems;
}

/** Luby's sequence, from 1: 1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, ... */
export function luby(index: number): number {
  let i = Math.max(1, Math.floor(index));
  for (;;) {
    let k = 1;
    while (2 ** k - 1 < i) k += 1;
    if (2 ** k - 1 === i) return 2 ** (k - 1);
    i = i - 2 ** (k - 1) + 1;
  }
}

/**
 * The step limit of a prover's session by its index (from 1), under the run's own limit `cap` (`limits.steps`): `geometric` gives base,
 * 2 x base, 4 x base, ...; `luby` gives base times Luby's sequence. Never above `cap`, never below 1.
 */
export function sessionSteps(restarts: ResolvedRestarts, index: number, cap: number): number {
  const i = Math.max(1, Math.floor(index));
  const steps = restarts.schedule === "luby" ? restarts.base * luby(i) : restarts.base * 2 ** Math.min(i - 1, 40);
  return Math.max(1, Math.min(steps, cap));
}

/**
 * What a failed check says about where the session is stuck: its failure class (the one the state card counts) and its goal, the text of the
 * first error (or of the first `sorry`'s goal) as the state card normalizes it. Two checks with the same signature failed the same way on the same
 * goal. Undefined for a check that says nothing about the proof (Lean could not be reached, it timed out, it was refused before Lean) and for a valid one.
 */
export function stuckSignature(report: ValidationReport, context: { statement?: string; aux?: string } = {}): { class: FailureClass; key: string } | undefined {
  const failure = classifyFailure(report, context);
  if (failure === undefined || failure.class === "lean_unavailable" || failure.class === "timeout" || failure.class === "refused") return undefined;
  const error = report.messages.find((m) => m.severity === "error");
  const goal = error?.text ?? report.sorries[0]?.goal ?? failure.detail;
  return { class: failure.class, key: JSON.stringify([failure.class, normalizeDetail(goal)]) };
}
