/**
 * The two axes of a run (plan change LH9, documentation/runs.md): `horizon` (how long it is bound) and `human` (whether it stops for a
 * person). Both are optional keys of `RunConfig`; what the run does is derived from what exists, in `runShape`, so a run that sets neither
 * records and behaves as it always did. `campaign` and `digest` are reserved for Task 59 and are refused at the start.
 */

/** `episode`: a bounded number of sessions, it ends when they are used (every run today). `campaign`: money, time and a frontier bound it (Task 59). */
export const HORIZONS = ["episode", "campaign"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** `none`: nobody is asked (measurement; `ablate` forces it). `consortium`: a turn ends at a limit or a breakpoint and waits. `digest`: it never waits (Task 59). */
export const HUMAN_MODES = ["none", "consortium", "digest"] as const;
export type HumanMode = (typeof HUMAN_MODES)[number];

/** The values that work today; the others are refused at the start naming the task that builds them. */
export const BUILT_HORIZONS: readonly Horizon[] = ["episode"];
export const BUILT_HUMAN_MODES: readonly HumanMode[] = ["none", "consortium"];

export interface RunShape {
  horizon: Horizon;
  human: HumanMode;
}

/** What `runShape` reads: the two keys, and whether the run has consortium turns (`RunConfig.consortium`). */
export interface ShapeInput {
  horizon?: Horizon | undefined;
  human?: HumanMode | undefined;
  consortium?: unknown;
}

/** The effective axes of a run: `horizon` is `episode` (the only one built); `human` is `consortium` when the run has consortium turns, `none` otherwise (always under `ablate`, which refuses a person). */
export function runShape(config: ShapeInput): RunShape {
  return { horizon: config.horizon ?? "episode", human: config.human ?? (config.consortium !== undefined ? "consortium" : "none") };
}

/** What stops a run whose axes cannot work, one sentence each; empty: fine. */
export function shapeProblems(config: ShapeInput): string[] {
  const problems: string[] = [];
  if (config.horizon !== undefined) {
    if (!(HORIZONS as readonly string[]).includes(config.horizon)) problems.push(`horizon must be one of ${HORIZONS.join(", ")}, got ${String(config.horizon)}`);
    else if (!BUILT_HORIZONS.includes(config.horizon)) problems.push(`horizon ${config.horizon} is not built yet: Task 59`);
  }
  if (config.human !== undefined) {
    if (!(HUMAN_MODES as readonly string[]).includes(config.human)) problems.push(`human must be one of ${HUMAN_MODES.join(", ")}, got ${String(config.human)}`);
    else if (!BUILT_HUMAN_MODES.includes(config.human)) problems.push(`human ${config.human} is not built yet: Task 59`);
    else if (config.human === "none" && config.consortium !== undefined) problems.push("human none contradicts the consortium turns of the run (a turn limit, --human or solve)");
    else if (config.human === "consortium" && config.consortium === undefined) problems.push("human consortium needs consortium turns: give a turn limit or --human");
  }
  return problems;
}

/** One phrase for a log line or a report header. */
export function describeShape(shape: RunShape): string {
  return `horizon ${shape.horizon}, human ${shape.human}`;
}
