import type { HarnessEvent } from "@seshat/core";
import { ROLES, type Role, type RolesConfig, roleOfSite } from "./roles.ts";

/** One line of the run report for a role the run named (`RunConfig.roles`): what its calls were and cost. */
export interface RoleLine {
  role: string;
  /** The models its calls went to, in the order they first did; the role's configured model (or the run's) when it made none. */
  models: string[];
  /** The prover's sessions (attempts), or the other roles' model calls. */
  calls: number;
  usd: number;
}

/**
 * Calls and cost per role, for a run whose `run.started` records `roles` (documentation/models-setup.md, "Roles"): one line per role named. A role's calls are
 * the `model_call.finished` events stamped with it (or at a site that is one role's alone), and the prover's are its attempts. Absent when the run names none.
 */
export function roleReport(events: readonly HarnessEvent[]): RoleLine[] | undefined {
  const started = (events.find((e) => e.type === "run.started")?.data as { config?: { model?: unknown; roles?: unknown } | null } | undefined)?.config ?? undefined;
  const roles = started?.roles;
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) return undefined;
  const config = roles as RolesConfig;
  const runModel = typeof started?.model === "string" ? started.model : "";
  const named = ROLES.filter((role) => config[role] !== undefined);
  if (named.length === 0) return undefined;
  const lines = new Map<string, RoleLine>(named.map((role) => [role, { role, models: [], calls: 0, usd: 0 }]));
  const seen = (line: RoleLine, model: string): void => {
    if (!line.models.includes(model)) line.models.push(model);
  };
  const attemptModel = new Map<string, string>();
  for (const event of events) {
    if (event.type === "attempt.started") attemptModel.set(event.data.attemptId, event.data.model);
    else if (event.type === "attempt.finished") {
      const line = lines.get("prover");
      if (line === undefined) continue;
      line.calls += 1;
      line.usd += event.data.usd;
      seen(line, attemptModel.get(event.data.attemptId) ?? config.prover?.model ?? runModel);
    } else if (event.type === "model_call.finished") {
      const role = event.data.role ?? roleOfSite(event.data.site);
      const line = role === undefined ? undefined : lines.get(role);
      if (line === undefined) continue;
      line.calls += 1;
      line.usd += event.data.usd;
      seen(line, event.data.model);
    }
  }
  for (const line of lines.values()) if (line.models.length === 0) line.models.push(config[line.role as Role]?.model ?? runModel);
  return [...lines.values()];
}
