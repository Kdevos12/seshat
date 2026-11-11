import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { GateSettings } from "@seshat/scheduler";
import { DEFAULT_IMPASSE, type TurnLimit } from "./turns.ts";
import { DEFAULT_CONFIG, type RunConfig } from "./run.ts";
import { DEFAULT_CHECK_TIMEOUT_SEC } from "@seshat/registry";
import type { PriceBook } from "./prices.ts";

/**
 * The defaults of `harness solve` (plan change PB6, documentation/quickstart.md, "Student defaults"): what a run should do when its
 * user has not learned the flag list and has a small budget. Every one of them is a value of an existing option of `harness run`;
 * nothing here is a new mechanism.
 */

/**
 * The defaults sets of `harness solve` (plan change CA4 to CA6, Task 34). A set is a list of overrides of `DEFAULT_CONFIG`, by name, and
 * the name is recorded in the run's configuration (`RunConfig.defaults`).
 *
 * - `v1` is what `solve` did before the sets: nothing is added to the configuration. It stays reachable (`harness solve --defaults v1`),
 *   and a test holds that its configuration is that of the commit the sets began from.
 * - `v2` is `v1` plus the edit tool, the masking of old check results, the bounded checks, the state card and the budget in rounds. It is the default.
 *   `budgetRounds` only acts on a run of several problems: `solve` has one, so it does nothing there. `studentConfig` also adds line M6
 *   with its mechanical repeat rule alone (no detector, no model call) to `v2` when the caller names no lines.
 *
 * A later task that changes `solve`'s defaults adds its option to `v2` here, one line for each option.
 */
export type DefaultsName = "v1" | "v2";

export const DEFAULTS_NAMES: readonly DefaultsName[] = ["v1", "v2"];

/** The set `harness solve` uses when `--defaults` is not given. */
export const DEFAULT_DEFAULTS: DefaultsName = "v2";

const V1: Partial<RunConfig> = {};

export const DEFAULTS_SETS: Readonly<Record<DefaultsName, Readonly<Partial<RunConfig>>>> = {
  v1: V1,
  v2: {
    ...V1,
    editTool: true,
    maskOldChecks: true,
    checkTimeoutSec: DEFAULT_CHECK_TIMEOUT_SEC,
    stateCard: true,
    budgetRounds: true,
  },
};

/** The dollars a `solve` may spend when `--max-usd` is not given: small on purpose, and always there. */
export const STUDENT_DEFAULT_MAX_USD = 2;

/** The classical battery runs before any model call (line M10), on the shared identity of statements (line M1). */
export const STUDENT_LINES: readonly string[] = ["M1", "M10"];

/**
 * The share of the allowance a turn may spend before the run stops with its account and waits for a decision: the first stop is a
 * look at where the run stands, not the end (`harness resume` spends the rest, up to the hard cap).
 */
export const STUDENT_TURN_SHARE = 0.5;

/** The budget gate with its own defaults, probe first (documentation/scheduler.md, "The budget gate"). */
export const STUDENT_GATE: GateSettings = {};

/** The dollars of a model in a table, per million tokens: what a call with this input and output costs at the price of the table. */
export function blendedPrice(model: Pick<Model<Api>, "provider" | "id" | "cost">, prices?: PriceBook): number {
  const host = prices?.pricingOf(model);
  return host !== undefined ? host.cacheMiss + host.output : model.cost.input + model.cost.output;
}

/** A model that can be chosen without being asked: it has a price, so that a dollar cap sees it. */
export function isPriced(model: Pick<Model<Api>, "provider" | "id" | "cost">, prices?: PriceBook): boolean {
  return blendedPrice(model, prices) > 0;
}

export interface Choice {
  /** `provider/id`. */
  name: string;
  /** Dollars per million tokens, input plus output. */
  price: number;
  /** Other models that could have been chosen, cheapest first, with their prices. */
  others: Array<{ name: string; price: number }>;
}

/**
 * The cheapest priced model of the providers that have credentials (input price plus output price, from the host's table where it
 * has one and from pi-ai otherwise). A model with no price is left out: no dollar cap could see it, and naming one is the user's
 * `--model`. Undefined when no provider has credentials, or none of their models has a price.
 */
export async function cheapestModel(models: Models, prices?: PriceBook): Promise<Choice | undefined> {
  const available = await models.getAvailable().catch(() => [] as readonly Model<Api>[]);
  const priced = available
    .filter((m) => isPriced(m, prices))
    .map((m) => ({ name: `${m.provider}/${m.id}`, price: blendedPrice(m, prices) }))
    .sort((a, b) => a.price - b.price || (a.name < b.name ? -1 : 1));
  const [first, ...others] = priced;
  return first === undefined ? undefined : { ...first, others: others.slice(0, 5) };
}

export interface StudentOptions {
  selection: RunConfig["selection"];
  model: string;
  maxUsd: number;
  /** Lines to enable in place of `STUDENT_LINES`; an empty list is M0. */
  lines?: readonly string[];
  /** The off-peak option, as `--offpeak` gives it. */
  offpeak?: RunConfig["offpeak"];
  /** The dollars a turn may spend, in place of `STUDENT_TURN_SHARE` of the allowance. */
  turnUsd?: number;
  /** The defaults set, `DEFAULT_DEFAULTS` when absent. */
  defaults?: DefaultsName;
  /** The host profile's `checkTimeoutSec`: replaces the set's value when the set bounds the checks (`v2`); `v1` ignores it. */
  hostCheckTimeoutSec?: number;
  /** Overrides of the shared defaults of a run (provers, sessions, thinking level). */
  base?: Partial<RunConfig>;
}

/** The problems with the allowance, or an empty list. */
export function checkAllowance(maxUsd: number, turnUsd?: number): string[] {
  const problems: string[] = [];
  if (!(maxUsd > 0) || !Number.isFinite(maxUsd)) problems.push(`--max-usd must be a positive number of dollars, got ${maxUsd}`);
  if (turnUsd !== undefined && !(turnUsd > 0)) problems.push(`--turn-usd must be positive, got ${turnUsd}`);
  if (turnUsd !== undefined && turnUsd > maxUsd) problems.push(`--turn-usd ${turnUsd} is above --max-usd ${maxUsd}: a turn cannot spend more than the allowance`);
  return problems;
}

/**
 * The configuration of a `solve`: the allowance is both the problem's and the run's budget, so it is a ceiling nothing goes past; the
 * gate and probe-first are on; the classical battery comes first; and consortium mode stops the run for its account when a turn has
 * spent its share, at an impasse or when the problem is settled, instead of running to the cap unseen.
 */
export function studentConfig(o: StudentOptions): RunConfig {
  const turn: TurnLimit = { usd: o.turnUsd ?? Math.round(o.maxUsd * STUDENT_TURN_SHARE * 1e6) / 1e6 };
  const defaults = o.defaults ?? DEFAULT_DEFAULTS;
  const lines = o.lines ?? (defaults === "v2" ? [...STUDENT_LINES, "M6"] : STUDENT_LINES);
  // v2 runs M6 for its mechanical repeat rule only: no detector, no model call.
  const repeatOnly = defaults === "v2" && o.lines === undefined && lines.includes("M6");
  const set = DEFAULTS_SETS[defaults];
  return {
    ...DEFAULT_CONFIG,
    ...set,
    ...(set.checkTimeoutSec !== undefined && o.hostCheckTimeoutSec !== undefined ? { checkTimeoutSec: o.hostCheckTimeoutSec } : {}),
    ...o.base,
    defaults,
    selection: o.selection,
    model: o.model,
    budget: { problemUsd: o.maxUsd, runUsd: o.maxUsd },
    gate: STUDENT_GATE,
    ...(lines.length > 0 ? { lines: [...lines] } : {}),
    ...(repeatOnly
      ? { lineOptions: { ...o.base?.lineOptions, M6: { framing: false, citations: false, rawErrors: false, revisions: false, detectors: false, repeatRule: true } } }
      : {}),
    consortium: { limit: turn, impasse: { ...DEFAULT_IMPASSE }, narrative: false },
    ...(o.offpeak !== undefined ? { offpeak: o.offpeak } : {}),
  };
}
