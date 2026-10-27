import type { Json } from "@seshat/core";
import { isLineId, LINE_ORDER, LINE_TITLES, type LineId, SUSPENDED_LINES } from "./ids.ts";
import type { JsonObject, Line } from "./line.ts";

/** The lines implemented so far, by id. */
export type LineRegistry = Readonly<Partial<Record<LineId, Line>>>;

/** An enabled line, with its options: its defaults and the run's values over them. */
export interface EnabledLine {
  line: Line;
  options: JsonObject;
}

/**
 * Checks the lines a run enables and puts them in `LINE_ORDER`. `problems` says what is wrong:
 * an unknown or repeated id, a suspended line, a line that is planned but not implemented, a
 * missing requirement, options for a line that is not enabled, that the line does not have, or of
 * another type than the default (a default of `null` takes any value), or two lines that both give
 * the context packet or the statement identity. A run with problems does not start.
 */
export function resolveLines(
  ids: readonly string[],
  implemented: LineRegistry,
  options: Readonly<Record<string, JsonObject>> = {},
): { lines: EnabledLine[]; problems: string[] } {
  const problems: string[] = [];
  const enabled: Line[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      problems.push(`line ${id} is listed twice`);
      continue;
    }
    seen.add(id);
    if (!isLineId(id)) {
      problems.push(`unknown line ${JSON.stringify(id)}; the lines are ${LINE_ORDER.join(", ")}`);
      continue;
    }
    if (SUSPENDED_LINES.has(id)) {
      problems.push(`line ${id} (${LINE_TITLES[id]}) is suspended: it is not built, and no run enables it (documentation/lines.md)`);
      continue;
    }
    const line = implemented[id];
    if (line === undefined) {
      problems.push(`line ${id} (${LINE_TITLES[id]}) is planned, not implemented yet`);
      continue;
    }
    if (line.id !== id) {
      problems.push(`the line registered as ${id} says it is ${line.id}`);
      continue;
    }
    enabled.push(line);
  }
  for (const line of enabled) {
    for (const required of line.requires) {
      if (!seen.has(required)) problems.push(`line ${line.id} requires line ${required}, which is not enabled`);
    }
  }
  const packets = enabled.filter((line) => line.hooks.contextPacket !== undefined).map((line) => line.id);
  if (packets.length > 1) problems.push(`lines ${packets.join(" and ")} all give the context packet; enable one of them`);
  const identities = enabled.filter((line) => line.identity !== undefined).map((line) => line.id);
  if (identities.length > 1) problems.push(`lines ${identities.join(" and ")} all give the statement identity; enable one of them`);

  for (const key of Object.keys(options)) {
    if (!enabled.some((line) => line.id === key) && !(isLineId(key) && seen.has(key))) {
      problems.push(`options given for line ${key}, which is not enabled`);
    }
  }
  const lines = enabled.map((line) => {
    const defaults = line.options ?? {};
    const given = options[line.id] ?? {};
    for (const [key, value] of Object.entries(given)) {
      const fallback = defaults[key];
      if (fallback === undefined) {
        const known = Object.keys(defaults);
        problems.push(`line ${line.id} has no option ${key}${known.length > 0 ? `; its options are ${known.join(", ")}` : ""}`);
      } else if (fallback !== null && kind(value) !== kind(fallback)) {
        // A default of null says "not set": it has no type to keep, so any JSON value is accepted.
        problems.push(`option ${line.id}.${key} must be ${kind(fallback)}, got ${JSON.stringify(value)}`);
      }
    }
    return { line, options: { ...defaults, ...given } };
  });
  return { lines: [...lines].sort((a, b) => LINE_ORDER.indexOf(a.line.id) - LINE_ORDER.indexOf(b.line.id)), problems };
}

function kind(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}
