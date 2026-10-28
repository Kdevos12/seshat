import { DECISION_BACKENDS, DECISION_SITES, type DecisionBackend, decisionSiteProblem } from "@seshat/core";

/** The `decide` keys of a run's configuration: `decide.backend`, `decide.sites.<site>` and, for the run's model, `decide.votes`. */
export interface DecideSettings {
  /** Who decides at the sites with no entry of their own. Default `llm`. */
  backend?: DecisionBackend;
  /** A backend per site, or `off`: the site keeps its way of deciding from before `decide`. */
  sites?: Record<string, DecisionBackend | "off">;
  /** Independent calls of the run's model per decision (1 to 9); their vote shares are the distribution. Default 1. */
  votes?: number;
}

export interface DecideConfig {
  backend: DecisionBackend;
  sites: Record<string, DecisionBackend | "off">;
  votes: number;
}

export const MAX_VOTES = 9;

export function resolveDecideSettings(settings: DecideSettings | undefined): DecideConfig {
  return { backend: settings?.backend ?? "llm", sites: { ...(settings?.sites ?? {}) }, votes: settings?.votes ?? 1 };
}

/** What is wrong with the settings; a site that may not use decide is refused here, whatever the backend. */
export function checkDecideSettings(settings: DecideSettings | undefined): string[] {
  if (settings === undefined) return [];
  const problems: string[] = [];
  const known = (value: unknown): boolean => typeof value === "string" && (DECISION_BACKENDS as readonly string[]).includes(value);
  if (settings.backend !== undefined && !known(settings.backend)) problems.push(`decide.backend must be one of ${DECISION_BACKENDS.join(", ")}, got ${String(settings.backend)}`);
  for (const [site, backend] of Object.entries(settings.sites ?? {})) {
    const why = decisionSiteProblem(site);
    if (why !== undefined) problems.push(`decide.sites.${site}: ${why}`);
    if (backend !== "off" && !known(backend)) problems.push(`decide.sites.${site} must be off or one of ${DECISION_BACKENDS.join(", ")}, got ${String(backend)}`);
  }
  if (settings.votes !== undefined && !(Number.isInteger(settings.votes) && settings.votes >= 1 && settings.votes <= MAX_VOTES)) {
    problems.push(`decide.votes must be a whole number from 1 to ${MAX_VOTES}, got ${String(settings.votes)}`);
  }
  return problems;
}

/** The sites whose decisions leave the process for a third party (the Jev backend). */
export function sitesSentOutside(config: DecideConfig): string[] {
  return Object.keys(DECISION_SITES).filter((site) => (config.sites[site] ?? config.backend) === "jev");
}
