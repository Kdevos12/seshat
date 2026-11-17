/**
 * The two axes of a run (plan change LH9, documentation/runs.md): `horizon` (how long it is bound) and `human` (whether it stops for a
 * person). Both are optional keys of `RunConfig`; what the run does is derived from what exists, in `runShape`, so a run that sets neither
 * records and behaves as it always did. `campaign` works with `digest` (`harness campaign`) and with `consortium`; `digest` without `campaign` is refused
 * at the start (documentation/campaign.md).
 */

/** `episode`: a bounded number of sessions, it ends when they are used (every run today). `campaign`: money, time and a frontier bound it, and its sessions are not capped (documentation/campaign.md). */
export const HORIZONS = ["episode", "campaign"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** `none`: nobody is asked (measurement; `ablate` forces it). `consortium`: a turn ends at a limit or a breakpoint and waits. `digest`: it never waits: the next turn starts by itself, and what a person would be asked goes into a digest (a campaign's). */
export const HUMAN_MODES = ["none", "consortium", "digest"] as const;
export type HumanMode = (typeof HUMAN_MODES)[number];

/** The values that work; one that does not is refused at the start. */
export const BUILT_HORIZONS: readonly Horizon[] = ["episode", "campaign"];
export const BUILT_HUMAN_MODES: readonly HumanMode[] = ["none", "consortium", "digest"];

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

/** The effective axes of a run: `horizon` is `episode` unless given; `human` is `consortium` when the run has consortium turns, `none` otherwise (always under `ablate`, which refuses a person). */
export function runShape(config: ShapeInput): RunShape {
  return { horizon: config.horizon ?? "episode", human: config.human ?? (config.consortium !== undefined ? "consortium" : "none") };
}

/** What stops a run whose axes cannot work, one sentence each; empty: fine. */
export function shapeProblems(config: ShapeInput): string[] {
  const problems: string[] = [];
  if (config.horizon !== undefined) {
    if (!(HORIZONS as readonly string[]).includes(config.horizon)) problems.push(`horizon must be one of ${HORIZONS.join(", ")}, got ${String(config.horizon)}`);
    else if (!BUILT_HORIZONS.includes(config.horizon)) problems.push(`horizon ${config.horizon} is not built`);
  }
  if (config.human !== undefined) {
    if (!(HUMAN_MODES as readonly string[]).includes(config.human)) problems.push(`human must be one of ${HUMAN_MODES.join(", ")}, got ${String(config.human)}`);
    else if (!BUILT_HUMAN_MODES.includes(config.human)) problems.push(`human ${config.human} is not built`);
    else if (config.human === "none" && config.consortium !== undefined) problems.push("human none contradicts the consortium turns of the run (a turn limit, --human or solve)");
    else if (config.human === "consortium" && config.consortium === undefined) problems.push("human consortium needs consortium turns: give a turn limit or --human");
    else if (config.human === "digest" && config.horizon !== "campaign") problems.push("human digest goes with horizon campaign: a run that never waits for a person is a campaign (harness campaign)");
    else if (config.human === "digest" && config.consortium === undefined) problems.push("human digest needs consortium turns: a campaign works in turns that end by themselves");
  }
  if (config.horizon === "campaign" && runShape(config).human === "none") problems.push("horizon campaign works in turns: give human digest or consortium, with turns (harness campaign does)");
  return problems;
}

/** One phrase for a log line or a report header. */
export function describeShape(shape: RunShape): string {
  return `horizon ${shape.horizon}, human ${shape.human}`;
}
