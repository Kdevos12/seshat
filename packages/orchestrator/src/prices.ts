import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelEntry, type ModelPricing, nextOffPeak, type PricingCalendar } from "@seshat/registry";

/**
 * The host's table of models (documentation/m0-loop.md, "Prices"): the prices a run charges with, the
 * calendar that says when they drop, and the sampled settings a model family ignores. It is built from the
 * host profile's `models` section; with none, every question is answered "nothing is known", and the run
 * charges at pi-ai's numbers as it always did.
 */
export class PriceBook {
  private readonly models: Readonly<Record<string, ModelEntry>>;
  /** Wall-clock time in milliseconds since the epoch; a test sets its own. */
  readonly now: () => number;

  constructor(models: Readonly<Record<string, ModelEntry>> | undefined, now: () => number = Date.now) {
    this.models = models ?? {};
    this.now = now;
  }

  /** The entry of a model named `provider/id`, or undefined. */
  entry(name: string): ModelEntry | undefined {
    return this.models[name];
  }

  /** Whether the host says any model ignores a setting; when it does not, no line has anything to ask. */
  get describesIgnores(): boolean {
    return Object.values(this.models).some((entry) => entry.ignores !== undefined);
  }

  /** The prices of a model, or undefined when the host gives none: the run then charges pi-ai's numbers. */
  pricingOf(model: Pick<Model<Api>, "provider" | "id">): ModelPricing | undefined {
    return this.models[`${model.provider}/${model.id}`]?.pricing;
  }

  /** The calendar of a model `provider/id`, or undefined when the host gives it no prices or no calendar. */
  calendarOf(name: string): PricingCalendar | undefined {
    return this.models[name]?.pricing?.calendar;
  }

  /**
   * Whether the model's family ignores a sampled setting (`temperature`, `penalties`...) when the request
   * thinks at `thinking` (a level, `off` for none). A model the host does not describe ignores nothing.
   */
  ignores(name: string, setting: string, thinking: string): boolean {
    const ignores = this.models[name]?.ignores;
    if (ignores === undefined) return false;
    return (ignores.always ?? []).includes(setting) || (thinking !== "off" && (ignores.thinking ?? []).includes(setting));
  }

  /** The first off-peak instant at or after `at` for this model: undefined when the host gives it no calendar, or the calendar has none. */
  nextOffPeak(name: string, at: number): number | undefined {
    const calendar = this.calendarOf(name);
    return calendar === undefined ? undefined : nextOffPeak(calendar, at);
  }
}
