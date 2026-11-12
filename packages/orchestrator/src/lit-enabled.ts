import { BACKENDS } from "@seshat/lit";
import type { HostProfile } from "@seshat/registry";

/** The value of a setting with its `${env:NAME:-default}` references replaced, as the registry reads it. */
function withEnv(value: unknown, env: Readonly<Record<string, string | undefined>>): string {
  return typeof value === "string" ? value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? "") : "";
}

/** The backends the host profile's `lit.search` enables (an address, or a directory); no request is made. */
export function enabledBackends(profile: HostProfile, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const enabled: string[] = [];
  for (const settings of Object.values(profile.capabilities["lit.search"]?.settings ?? {})) {
    const backends = (settings as { backends?: Record<string, { baseUrl?: unknown; dir?: unknown }> }).backends ?? {};
    for (const [id, setting] of Object.entries(backends)) if (withEnv(setting.baseUrl, env) !== "" || withEnv(setting.dir, env) !== "") enabled.push(id);
  }
  return BACKENDS.filter((b) => enabled.includes(b));
}
