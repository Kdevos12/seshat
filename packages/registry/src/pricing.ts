import type { JsonSchema } from "./schema.ts";

/**
 * What a host profile says about a model (documentation/m0-loop.md, "Prices"): its prices and the
 * settings its family ignores. Prices and the provider's identifiers are configuration, never code:
 * a table is read from `config/hosts/*.json`, and a model with no entry is charged at the numbers
 * pi-ai carries for it.
 */
export interface ModelEntry {
  pricing?: ModelPricing;
  ignores?: IgnoredSettings;
}

/** Dollars per million tokens, and the optional off-peak calendar. */
export interface ModelPricing {
  /** Input tokens the provider read from its prompt cache. */
  cacheHit: number;
  /** Input tokens it did not (the full input price). */
  cacheMiss: number;
  output: number;
  /** Input tokens written to the cache, when the provider charges for it; absent: the cache-miss price. */
  cacheWrite?: number;
  calendar?: PricingCalendar;
}

/**
 * When the provider's prices drop. `peak` lists the windows at the full price, in UTC; any other
 * instant is off-peak and costs `offPeakMultiplier` times as much. A date in `offPeakDates` is
 * off-peak all day (a public holiday the provider names).
 */
export interface PricingCalendar {
  peak: PeakWindow[];
  offPeakMultiplier: number;
  offPeakDates?: string[];
}

/** A window of the day, `from` included and `to` excluded, on these weekdays (0 is Sunday, 1 Monday, up to 6). */
export interface PeakWindow {
  days: number[];
  /** `HH:MM`, UTC. */
  from: string;
  to: string;
}

/**
 * The sampled settings a model family does not act on, by the thinking mode the request is in. A line that
 * samples a setting spends no arm on one listed here (documentation/fleet.md, "Sampled settings").
 */
export interface IgnoredSettings {
  /** Ignored in every mode. */
  always?: string[];
  /** Ignored when the request thinks (any thinking level but `off`). */
  thinking?: string[];
}

const HHMM = "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$";
const DATE = "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$";

export const MODELS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      pricing: {
        type: "object",
        required: ["cacheHit", "cacheMiss", "output"],
        properties: {
          cacheHit: { type: "number", minimum: 0 },
          cacheMiss: { type: "number", minimum: 0 },
          output: { type: "number", minimum: 0 },
          cacheWrite: { type: "number", minimum: 0 },
          calendar: {
            type: "object",
            required: ["peak", "offPeakMultiplier"],
            properties: {
              peak: {
                type: "array",
                items: {
                  type: "object",
                  required: ["days", "from", "to"],
                  properties: {
                    days: { type: "array", minItems: 1, items: { type: "integer", minimum: 0, maximum: 6 } },
                    from: { type: "string", pattern: HHMM },
                    to: { type: "string", pattern: HHMM },
                  },
                  additionalProperties: false,
                },
              },
              offPeakMultiplier: { type: "number", minimum: 0, maximum: 1 },
              offPeakDates: { type: "array", items: { type: "string", pattern: DATE } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      ignores: {
        type: "object",
        properties: {
          always: { type: "array", items: { type: "string", minLength: 1 } },
          thinking: { type: "array", items: { type: "string", minLength: 1 } },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

/** Problems the schema cannot say: a model name that is not `provider/id`, a window that ends before it begins, a multiplier of zero. */
export function checkModels(models: Record<string, ModelEntry>, origin: string): string[] {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(models)) {
    if (!/^[^/\s]+\/\S+$/.test(name)) problems.push(`${origin} models: ${JSON.stringify(name)} must be provider/id`);
    const calendar = entry.pricing?.calendar;
    if (calendar === undefined) continue;
    if (!(calendar.offPeakMultiplier > 0)) problems.push(`${origin} models.${name}.pricing.calendar: offPeakMultiplier must be above 0`);
    for (const [k, window] of calendar.peak.entries()) {
      if (minutesOf(window.from) >= minutesOf(window.to)) {
        problems.push(`${origin} models.${name}.pricing.calendar.peak[${k}]: from must be before to (a window does not cross midnight: write two)`);
      }
    }
  }
  return problems;
}

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Whether the instant `at` (milliseconds since the epoch) is inside a peak window of the calendar. */
export function isPeak(calendar: PricingCalendar, at: number): boolean {
  return peakEnd(calendar, at) !== undefined;
}

/** The end of the peak window that holds `at`, or undefined when `at` is off-peak. */
function peakEnd(calendar: PricingCalendar, at: number): number | undefined {
  const date = new Date(at);
  if (calendar.offPeakDates?.includes(date.toISOString().slice(0, 10))) return undefined;
  const midnight = at - (at % DAY);
  const minute = Math.floor((at - midnight) / MINUTE);
  let end: number | undefined;
  for (const window of calendar.peak) {
    if (!window.days.includes(date.getUTCDay())) continue;
    if (minutesOf(window.from) <= minute && minute < minutesOf(window.to)) {
      const to = midnight + minutesOf(window.to) * MINUTE;
      end = end === undefined ? to : Math.max(end, to);
    }
  }
  return end;
}

/**
 * The first instant at or after `at` that is off-peak: `at` itself when it is. Undefined when the calendar has no
 * off-peak instant within a fortnight (a calendar that is peak all the time).
 */
export function nextOffPeak(calendar: PricingCalendar, at: number): number | undefined {
  let t = at;
  const limit = at + 14 * DAY;
  for (;;) {
    const end = peakEnd(calendar, t);
    if (end === undefined) return t;
    t = end;
    if (t > limit) return undefined;
  }
}

/** What a model response cost at the table's prices, in dollars, with the part the cache saved and whether it was charged at the off-peak rate. */
export interface PricedUsage {
  usd: number;
  savedUsd: number;
  offPeak: boolean;
}

/** The price of a response of `input` cache-miss tokens, `cacheRead` cache hits, `cacheWrite` cache writes and `output` tokens, answered at `at`. */
export function priceUsage(
  pricing: ModelPricing,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  at: number,
): PricedUsage {
  const offPeak = pricing.calendar !== undefined && !isPeak(pricing.calendar, at);
  const factor = offPeak ? (pricing.calendar?.offPeakMultiplier ?? 1) : 1;
  const million =
    usage.input * pricing.cacheMiss +
    usage.cacheRead * pricing.cacheHit +
    usage.cacheWrite * (pricing.cacheWrite ?? pricing.cacheMiss) +
    usage.output * pricing.output;
  return {
    usd: (million / 1e6) * factor,
    // Net of the premium a provider that charges for cache writes asks over the miss price; negative when the writes cost more than the reads saved.
    savedUsd:
      ((usage.cacheRead * (pricing.cacheMiss - pricing.cacheHit) - usage.cacheWrite * ((pricing.cacheWrite ?? pricing.cacheMiss) - pricing.cacheMiss)) * factor) / 1e6,
    offPeak,
  };
}
