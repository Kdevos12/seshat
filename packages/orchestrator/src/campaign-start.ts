import type { CampaignConfig } from "./campaign-config.ts";
import type { RunConfig } from "./run.ts";

/** What `harness campaign` gives a run on top of the defaults set: the axes, cold restarts on the geometric schedule, the frontier shown, and the pacing. */
export function campaignBase(c: CampaignConfig): Partial<RunConfig> {
  const { usdPerDay, until, spiralTurns } = c;
  return {
    horizon: "campaign",
    human: "digest",
    restarts: { schedule: "geometric" },
    frontier: { show: true },
    campaign: { ...(usdPerDay !== undefined ? { usdPerDay } : {}), ...(until !== undefined ? { until } : {}), ...(spiralTurns !== undefined ? { spiralTurns } : {}) },
  };
}

/** The dollars of a campaign's turn when none is given: a tenth of the allowance, and never above the day's cap. */
export function campaignTurnUsd(o: { turnUsd?: number; maxUsd: number; usdPerDay?: number }): number {
  return Math.round(Math.min(o.turnUsd ?? o.maxUsd / 10, o.usdPerDay ?? Infinity) * 1e6) / 1e6;
}
