/**
 * The settings of a campaign (`RunConfig.campaign`, documentation/campaign.md): the pacing the supervisor keeps and the guard it ends on. They are
 * recorded in `run.started` with the rest of the configuration, so `harness campaign --resume` reads them from the journal.
 */
export interface CampaignConfig {
  /** The most dollars a UTC day may spend (`--usd-per-day`). A turn ends when the day's spend reaches it, and the next one waits for the next day. Absent: no daily cap. */
  usdPerDay?: number;
  /** The wall-clock end, an ISO instant (`--until`): the campaign stops at it. Absent: it ends on the allowance, the claim or the guard. */
  until?: string;
  /** The spiral guard: this many turns in a row that spent money and did not grow the frontier end the campaign as `spiral`. Default 8. */
  spiralTurns?: number;
}

export const DEFAULT_SPIRAL_TURNS = 8;

/**
 * The session cap of a campaign: a prover's sessions are numbered over the whole campaign and money, time and the guard bound it, so the number a
 * run is given (`sessions`) is replaced by this one, which no campaign reaches. The prompt omits "of at most N" for it.
 */
export const UNBOUNDED_SESSIONS = 1_000_000;

/** What `RunConfig.campaign` allows. Problems in words; empty: fine. */
export function campaignConfigProblems(config: unknown): string[] {
  if (config === undefined) return [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["campaign must be an object: { usdPerDay?: number, until?: string, spiralTurns?: number }"];
  const c = config as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(c)) if (key !== "usdPerDay" && key !== "until" && key !== "spiralTurns") problems.push(`campaign.${key} is not a setting (usdPerDay, until, spiralTurns)`);
  if (c.usdPerDay !== undefined && !(typeof c.usdPerDay === "number" && Number.isFinite(c.usdPerDay) && c.usdPerDay > 0)) problems.push(`campaign.usdPerDay must be a positive number, got ${String(c.usdPerDay)}`);
  if (c.until !== undefined && !(typeof c.until === "string" && !Number.isNaN(Date.parse(c.until)))) problems.push(`campaign.until must be an ISO time, got ${String(c.until)}`);
  if (c.spiralTurns !== undefined && !(typeof c.spiralTurns === "number" && Number.isInteger(c.spiralTurns) && c.spiralTurns >= 1)) problems.push(`campaign.spiralTurns must be a whole number of at least 1, got ${String(c.spiralTurns)}`);
  return problems;
}

/** The recorded settings read back, keeping only what is valid. */
export function readCampaignConfig(recorded: unknown): CampaignConfig | undefined {
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded) || campaignConfigProblems(recorded).length > 0) return undefined;
  const r = recorded as CampaignConfig;
  return { ...(r.usdPerDay !== undefined ? { usdPerDay: r.usdPerDay } : {}), ...(r.until !== undefined ? { until: r.until } : {}), ...(r.spiralTurns !== undefined ? { spiralTurns: r.spiralTurns } : {}) };
}
