import type { HealthEntry } from "@seshat/registry";

/**
 * What `harness health` prints for the entries of a host, and its exit code: 1 when an
 * implementation that is not optional does not answer. One that is optional (a public site that a
 * host without outbound access cannot reach) is shown as `warn` and does not change the code.
 */
export function renderHealth(entries: readonly HealthEntry[], host: string): { lines: string[]; code: number } {
  const lines = entries.map((e) => {
    const mark = e.ok ? "ok  " : e.optional === true ? "warn" : "FAIL";
    return `${mark} ${e.capability}/${e.implementation} ${e.version} (${e.durationMs} ms): ${e.detail}`;
  });
  if (entries.length === 0) lines.push(`host ${host} offers no capability`);
  return { lines, code: entries.every((e) => e.ok || e.optional === true) ? 0 : 1 };
}
