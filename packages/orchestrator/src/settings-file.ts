import { readFileSync, statSync } from "node:fs";
import { RunSetupError } from "./setup-error.ts";
import { checkConfig, DEFAULT_CONFIG, type RunConfig } from "./run.ts";
import { RUN_PARAMETERS, SOLVE_OWN_FLAGS, settingsFileAccepts } from "./parameters.ts";

/**
 * The settings file of `harness run` and `harness solve` (`--settings FILE`, documentation/quickstart.md): a JSON object whose keys are
 * `RunConfig` keys, read with the catalogue (`parameters.ts`). A key the catalogue does not know, hides or marks internal is refused naming
 * it; a value is checked against the catalogue's type, then the whole is checked by `checkConfig`, the check every run passes at its start.
 * The order is the defaults set, then the file, then the flags: a flag wins over the file. What the file sets is part of the run's
 * configuration, so `run.started` records it and a resume restores it.
 */

const MAX_BYTES = 100_000;

export type SettingsCommand = "run" | "solve";

/** What a settings file holds, checked. */
export interface Settings {
  /** The keys and values, as `RunConfig` has them. */
  values: Partial<RunConfig>;
  /** The keys, in the file's order. */
  keys: Array<keyof RunConfig>;
  /** Where it came from (the file's path), for the start log. */
  source: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** How a catalogue type is entered: one word per kind of value, which the interface's form and the check below both read. */
export type SettingKind = "boolean" | "integer" | "number" | "list" | "text" | "text-or-number" | "choice" | "json";

/** The kind of a catalogue `type` string, and for a choice its words. */
export function settingKind(type: string): { kind: SettingKind; choices?: string[] } {
  if (type === "boolean") return { kind: "boolean" };
  if (type.startsWith("integer")) return { kind: "integer" };
  if (type.startsWith("number")) return { kind: "number" };
  if (type.startsWith("string[]")) return { kind: "list" };
  if (type.startsWith("string | number")) return { kind: "text-or-number" };
  if (type.startsWith("string")) return { kind: "text" };
  const words = type.split(" | ").map((w) => w.replace(/\s*\(.*$/, ""));
  if (words.length > 1 && words.every((w) => /^[a-z_]+$/.test(w))) return { kind: "choice", choices: words.filter((w) => w !== "absent") };
  return { kind: "json" };
}

/** The problem with a value against the catalogue's type for it, or undefined. One small check per kind of type; `checkConfig` does the finer ones. */
function typeProblem(type: string, value: unknown): string | undefined {
  const { kind, choices } = settingKind(type);
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "a boolean (true or false)";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? undefined : "a whole number";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "a number";
    case "list":
      return Array.isArray(value) && value.every((x) => typeof x === "string") ? undefined : "a list of text";
    case "text-or-number":
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? undefined : "text or a number";
    case "text":
      return typeof value === "string" ? undefined : "text";
    case "choice":
      return typeof value === "string" && (choices ?? []).includes(value) ? undefined : `one of ${(choices ?? []).join(", ")}`;
    case "json":
      return type.startsWith("{") || type.startsWith("Record<") ? (isObject(value) ? undefined : "an object") : undefined;
  }
}

/** The problems of a settings object (a parsed file, or what the interface collected): an unknown, hidden or internal key, a key `solve` takes from a flag, a value of the wrong type, and what `checkConfig` finds. Empty: fine. */
export function settingsProblems(raw: unknown, command: SettingsCommand): string[] {
  if (!isObject(raw)) return ["a settings file is a JSON object whose keys are RunConfig keys"];
  const problems: string[] = [];
  const known: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(RUN_PARAMETERS, key)) {
      problems.push(`unknown setting ${JSON.stringify(key)}: the keys are those of documentation/parameters.md, "Settings file"`);
      continue;
    }
    if (!settingsFileAccepts(key)) {
      const info = RUN_PARAMETERS[key as keyof RunConfig];
      problems.push(`${JSON.stringify(key)} is not a setting a person gives (${info.status === "internal" ? "the harness sets it" : "it is hidden"})`);
      continue;
    }
    const own = command === "solve" ? SOLVE_OWN_FLAGS[key as keyof RunConfig] : undefined;
    if (own !== undefined) {
      problems.push(`${JSON.stringify(key)} is set by ${own} in solve, not by the settings file`);
      continue;
    }
    const wrong = typeProblem(RUN_PARAMETERS[key as keyof RunConfig].type, value);
    if (wrong !== undefined) {
      problems.push(`${JSON.stringify(key)} must be ${wrong}, got ${JSON.stringify(value)?.slice(0, 80)}`);
      continue;
    }
    known[key] = value;
  }
  if (problems.length > 0) return problems;
  // The check every run passes at its start, on the file's keys over the defaults of a run.
  return checkConfig({ ...DEFAULT_CONFIG, selection: { ids: [] }, model: "provider/model", ...known } as RunConfig);
}

/** Checks a settings object and returns it as `Settings`; a problem is a `RunSetupError` that names the key. */
export function parseSettings(raw: unknown, command: SettingsCommand, source: string): Settings {
  const problems = settingsProblems(raw, command);
  if (problems.length > 0) throw new RunSetupError(`${source}: ${problems.join("; ")}`);
  const values = raw as Partial<RunConfig>;
  return { values, keys: Object.keys(values) as Array<keyof RunConfig>, source };
}

/** Reads `--settings FILE`. */
export function readSettingsFile(path: string, command: SettingsCommand): Settings {
  let text: string;
  try {
    if (statSync(path).size > MAX_BYTES) throw new RunSetupError(`--settings ${path} is larger than ${MAX_BYTES} bytes`);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof RunSetupError) throw error;
    throw new RunSetupError(`--settings ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RunSetupError(`--settings ${path} is not valid JSON`);
  }
  return parseSettings(raw, command, `--settings ${path}`);
}

/**
 * The configuration the flags make, with the file's keys under them: a key a flag of it was given for keeps the flag's value (`given` says
 * whether a flag was given), and a key without a flag given takes the file's. Returns the keys that came from the file and those a flag won.
 */
export function mergeSettings(flagged: RunConfig, file: Settings, given: (flag: string) => boolean): { config: RunConfig; fromFile: string[]; overruled: string[] } {
  const config: RunConfig = { ...flagged };
  const fromFile: string[] = [];
  const overruled: string[] = [];
  for (const key of file.keys) {
    if (RUN_PARAMETERS[key].cli.some(given)) {
      overruled.push(key);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = file.values[key];
    fromFile.push(key);
  }
  return { config, fromFile, overruled };
}

/** One line for the start log: the keys that came from the file, and the ones a flag won. */
export function describeSettings(file: Settings, fromFile: readonly string[], overruled: readonly string[]): string {
  return `Settings from ${file.source.replace(/^--settings /, "")}: ${fromFile.length > 0 ? fromFile.join(", ") : "nothing"}${overruled.length > 0 ? ` (a flag won over the file for ${overruled.join(", ")})` : ""}.`;
}
