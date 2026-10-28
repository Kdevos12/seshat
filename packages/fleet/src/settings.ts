import type { JsonObject } from "@seshat/lines";
import type { Attempt } from "@seshat/memory";
import { UNIFORM } from "./beta.ts";
import { thompson } from "./choose.ts";
import { type AttemptWeight, group } from "./posterior.ts";
import type { RandomSource } from "./random.ts";

/**
 * The directives a session can be given at random (plan change PC6, after Nexus): one sentence that
 * points the session at a way of working, so that sessions on one claim do not all start from the same
 * place. Fixed text, worded to ask for no demonstration of the statement (the guards' framing check finds
 * nothing in any of them). The label is what the attempt records.
 */
export const DIRECTIVES: Readonly<Record<string, string>> = {
  small_cases: "Work out small cases first, by hand or with decide, and read the pattern from them before you generalize.",
  more_general: "Look for a more general statement than the target, one that may be easier to handle, then come back to the target from it.",
  other_tool: "If you would reach for one main tool first, pick another one for this session and see how far it goes.",
  shortest: "Look for the shortest argument you can think of before you build an elaborate one.",
  skeleton: "Spend your first checks on the skeleton of the argument, with sorry for every step, and fill the holes only once the skeleton checks.",
  doubt: "Spend part of your effort looking for the way the statement could fail as written: an edge case, a degenerate instance, a hypothesis that is too weak.",
};

/** The modes of a session: the usual one, and the informal-first one (plan change PC11). */
export const SESSION_MODES = ["standard", "nl_first"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** The thinking levels a session can be sampled at. */
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The distributions the fleet samples a session's settings from (documentation/fleet.md, "Sampled
 * settings"). A setting that is absent is not sampled: the session keeps the run's own.
 */
export interface SettingsConfig {
  /** A fixed value, a range to draw uniformly from, or a list of values to learn over. */
  temperature?: { fixed: number } | { min: number; max: number } | { values: number[] };
  /** Thinking levels to learn over. */
  thinking?: string[];
  /** Directives to learn over: label to text. */
  directives?: Record<string, string>;
  /** Session modes to learn over. */
  modes?: SessionMode[];
}

function fail(message: string): never {
  throw new Error(message);
}

/** Reads the options that describe the distributions, with a message that says what is wrong. */
export function settingsConfigOf(options: Readonly<JsonObject>): SettingsConfig {
  const config: SettingsConfig = {};
  const { temperature, thinking, directives, modes } = options;
  const temp = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) fail("the option temperature takes numbers from 0 to 2");
    return value;
  };
  if (temperature !== undefined && temperature !== null) {
    if (typeof temperature === "number") config.temperature = { fixed: temp(temperature) };
    else if (Array.isArray(temperature)) {
      if (temperature.length === 0) fail("the option temperature is an empty list");
      config.temperature = { values: temperature.map(temp) };
    } else if (typeof temperature === "object" && "min" in temperature && "max" in temperature) {
      const min = temp(temperature.min);
      const max = temp(temperature.max);
      if (min > max) fail("the option temperature has min above max");
      config.temperature = { min, max };
    } else fail("the option temperature is a number, a list of numbers or {min, max}");
  }
  if (thinking !== undefined && thinking !== null) {
    if (!Array.isArray(thinking) || thinking.length === 0 || thinking.some((level) => typeof level !== "string" || !THINKING.includes(level))) {
      fail(`the option thinking is a non-empty list of thinking levels (${THINKING.join(", ")})`);
    }
    config.thinking = [...new Set(thinking as string[])];
  }
  if (directives !== undefined && directives !== null && directives !== false) {
    if (directives === true) config.directives = { ...DIRECTIVES };
    else if (typeof directives === "object" && !Array.isArray(directives) && Object.keys(directives).length > 0 && Object.values(directives).every((text) => typeof text === "string" && text !== "")) {
      config.directives = { ...(directives as Record<string, string>) };
    } else fail("the option directives is true (the built-in ones) or an object from label to text");
  }
  if (modes !== undefined && modes !== null) {
    if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !(SESSION_MODES as readonly unknown[]).includes(mode))) {
      fail(`the option modes is a non-empty list of ${SESSION_MODES.join(", ")}`);
    }
    config.modes = [...new Set(modes as SessionMode[])];
  }
  return config;
}

/** Whether any setting is sampled. */
export function samplesSettings(config: SettingsConfig): boolean {
  return config.temperature !== undefined || config.thinking !== undefined || config.directives !== undefined || config.modes !== undefined;
}

/** What `sampleSettings` decided, and the draws it was decided from. */
export interface SampledSettings {
  /** The settings to record on the attempt. */
  settings: JsonObject;
  /** The draw of each value of each learned setting, rounded: `{ thinking: { low: 0.41, high: 0.77 } }`. */
  draws: { [setting: string]: { [value: string]: number } };
}

const round = (x: number): number => Math.round(x * 10000) / 10000;

/** The value a recorded setting has, as the text its posterior is kept under. */
function keyOf(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * One session's settings. The discrete settings (thinking level, directive, mode, and a temperature given as a
 * list) are learned like strategies: each value has a Beta posterior over the attempts of the claim that were
 * given it (the `choice` reward, weighted like the strategies'), and Thompson sampling picks the value with the
 * highest draw; a value nothing is known of has the flat posterior, so it is tried. A temperature given as a range
 * is drawn uniformly (nothing is learned over a continuum here), and a fixed one is just recorded. The draws come
 * from `random`, which the caller seeds from the run's seed, the problem, the prover and the session.
 */
export function sampleSettings(
  random: RandomSource,
  config: SettingsConfig,
  attempts: readonly Attempt[],
  partial: number,
  weigh?: AttemptWeight,
): SampledSettings {
  const settings: JsonObject = {};
  const draws: SampledSettings["draws"] = {};
  const learn = (name: string, values: readonly (string | number)[]): string | number | undefined => {
    const posteriors = group(attempts, (attempt) => keyOf(attempt.settings?.[name]), partial, weigh);
    const picked = thompson(random, values.map((value) => [String(value), posteriors.get(String(value))?.choice ?? UNIFORM] as const));
    if (picked === undefined) return undefined;
    draws[name] = Object.fromEntries(picked.draws.map(([value, draw]) => [value, round(draw)]));
    return values.find((value) => String(value) === picked.choice);
  };
  const temperature = config.temperature;
  if (temperature !== undefined) {
    if ("fixed" in temperature) settings.temperature = temperature.fixed;
    else if ("min" in temperature) settings.temperature = Math.round((temperature.min + random() * (temperature.max - temperature.min)) * 100) / 100;
    else {
      const value = learn("temperature", temperature.values);
      if (value !== undefined) settings.temperature = value;
    }
  }
  if (config.thinking !== undefined) {
    const value = learn("thinking", config.thinking);
    if (value !== undefined) settings.thinking = value;
  }
  if (config.directives !== undefined) {
    const value = learn("directive", Object.keys(config.directives));
    if (value !== undefined) settings.directive = value;
  }
  if (config.modes !== undefined) {
    const value = learn("mode", config.modes);
    if (value !== undefined) settings.mode = value;
  }
  return { settings, draws };
}
