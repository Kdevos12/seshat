import { applies, type BankCard, bankOf, type CardContext, type HeuristicCard, strategyOfCard } from "@seshat/heuristics";
import type { Briefing, JsonObject } from "@seshat/lines";
import { armOf, type Attempt, effectOf, type ItemEffect, shouldDeactivate } from "@seshat/memory";
import { type Beta, betaMean, UNIFORM } from "./beta.ts";
import { thompson } from "./choose.ts";
import { type AttemptWeight, group } from "./posterior.ts";
import type { RandomSource } from "./random.ts";

/** What the fleet reads of the bank's options (documentation/fleet.md, "Heuristic cards"). */
export interface HeuristicsConfig {
  /** Every card of the bank, or only these ids. */
  cards: "all" | readonly string[];
  /** The share of sessions that get no card, drawn first: the control the effect of a card is measured against. */
  noCardShare: number;
  /** What a session of another model counts in the posteriors, against 1 for the session's own model. */
  crossModelWeight: number;
  /** The weight, in pseudo-sessions, of a family's counts in the prior of each of its cards. */
  familyPriorWeight: number;
  /**
   * A card is no longer drawn in a bucket once it has this many observations with it and as many in the control, and
   * P(effect < 0) is above 0.9: M5's rule on PE2's effect (`shouldDeactivate` of `@seshat/memory`).
   */
  minObservations: number;
}

export const DEFAULT_NO_CARD_SHARE = 0.2;
export const DEFAULT_CROSS_MODEL_WEIGHT = 0.5;
export const DEFAULT_FAMILY_PRIOR_WEIGHT = 2;
export const MAX_FAMILY_PRIOR_WEIGHT = 8;
/** M5's default (`minObservations` of the lessons). */
export const DEFAULT_CARD_MIN_OBSERVATIONS = 8;
export const MAX_CARD_MIN_OBSERVATIONS = 1000;

function fail(message: string): never {
  throw new Error(message);
}

/** The bank's options, checked; undefined when the bank is off (`heuristics` null or false). */
export function heuristicsConfigOf(options: Readonly<JsonObject>): HeuristicsConfig | undefined {
  const { heuristics } = options;
  if (heuristics === undefined || heuristics === null || heuristics === false) return undefined;
  let cards: HeuristicsConfig["cards"];
  if (heuristics === true) cards = "all";
  else if (Array.isArray(heuristics) && heuristics.length > 0 && heuristics.every((id) => typeof id === "string" && id !== "")) cards = [...new Set(heuristics as string[])];
  else fail("the option heuristics is true (every card of the bank), a non-empty list of card ids, or null");
  const share = (key: string, fallback: number, max = 1): number => {
    const value = options[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) fail(`the option ${key} is a number from 0 to ${max}`);
    return value;
  };
  return {
    cards,
    noCardShare: share("noCardShare", DEFAULT_NO_CARD_SHARE),
    crossModelWeight: share("crossModelWeight", DEFAULT_CROSS_MODEL_WEIGHT),
    familyPriorWeight: share("familyPriorWeight", DEFAULT_FAMILY_PRIOR_WEIGHT, MAX_FAMILY_PRIOR_WEIGHT),
    minObservations: (() => {
      const value = options.cardMinObservations ?? DEFAULT_CARD_MIN_OBSERVATIONS;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CARD_MIN_OBSERVATIONS) {
        fail(`the option cardMinObservations is a whole number from 1 to ${MAX_CARD_MIN_OBSERVATIONS}`);
      }
      return value;
    })(),
  };
}

/** The packs of a registry, as the bank reads them: a registry built without packs has none. */
export function packCardsOf(registry: unknown): { name: string; heuristics?: readonly HeuristicCard[] }[] {
  const packs = (registry as { packs?: unknown } | null | undefined)?.packs;
  if (!Array.isArray(packs)) return [];
  return packs.map((pack: { manifest?: { name?: unknown }; heuristics?: readonly HeuristicCard[] }) => ({
    name: String(pack.manifest?.name ?? "unnamed"),
    ...(pack.heuristics !== undefined ? { heuristics: pack.heuristics } : {}),
  }));
}

/** The bank a run draws from: the built-in cards and the installed packs' cards, restricted to the configured ids. */
export function runBank(registry: unknown, config: HeuristicsConfig): BankCard[] {
  const bank = bankOf(packCardsOf(registry));
  if (config.cards === "all") return bank;
  const ids = new Set(bank.map((card) => card.id));
  const unknown = config.cards.filter((id) => !ids.has(id));
  if (unknown.length > 0) fail(`the option heuristics names cards the bank does not have: ${unknown.join(", ")}`);
  const wanted = new Set(config.cards);
  return bank.filter((card) => wanted.has(card.id));
}

/** How a session's card was decided. */
export type CardRule = "control" | "thompson" | "none_applicable";

/**
 * Whether a session is a control session that could have been given the card: drawn as the control while the card
 * was among the eligible ones (`heuristicEligible`, recorded on every control session), so that a card is compared
 * with sessions on the same eligibility terms (its `when`, its strategy, the mode), not with every control of the
 * bucket. A control session recorded without the list counts for every card.
 */
export function controlFor(attempt: Pick<Attempt, "settings">, cardId: string): boolean {
  const settings = attempt.settings;
  if (settings?.heuristic !== "none" || settings.heuristicRule !== "control") return false;
  const eligible = settings.heuristicEligible;
  return !Array.isArray(eligible) || eligible.includes(cardId);
}

/**
 * A card's effect in a bucket (plan change HB3): the sessions given it against the control sessions, as PE2's two Beta
 * posteriors (`effectOf` of `@seshat/memory`). Only a proof Lean accepted or a failed check says something, as in PE2; each
 * session counts its weight.
 */
export function cardEffect(cardId: string, history: readonly Attempt[], weigh: AttemptWeight = () => 1): ItemEffect {
  const tally = (pick: (attempt: Attempt) => boolean) => {
    let successes = 0;
    let failures = 0;
    let attempts = 0;
    for (const attempt of history) {
      if (!pick(attempt) || (attempt.outcome !== "valid" && attempt.outcome !== "invalid")) continue;
      const w = weigh(attempt);
      attempts += 1;
      if (attempt.outcome === "valid") successes += w;
      else failures += w;
    }
    return armOf(successes, failures, attempts);
  };
  return effectOf(
    cardId,
    {},
    tally((a) => a.settings?.heuristic === cardId),
    tally((a) => controlFor(a, cardId)),
  );
}

/** What `drawCard` decided, and the draws it was decided from. */
export interface CardDraw {
  card?: BankCard;
  rule: CardRule;
  /** The cards that applied but were left out because their measured effect in the bucket is negative. */
  deactivated?: string[];
  /** For the control: the cards it could have been given, which its session is compared with (`controlFor`). */
  eligible?: string[];
  /** The draw of each family and of each card of the chosen family, rounded. */
  draws?: { heuristicFamily?: { [family: string]: number }; heuristic?: { [card: string]: number } };
}

export interface CardDrawInput {
  bank: readonly BankCard[];
  context: CardContext;
  /** The strategy the fleet chose for the session: a tactic card of another label is left out. */
  strategy?: string;
  /** The families other provers hold on the same subgoal now: left out while another family is left. */
  taken: ReadonlySet<string>;
  /** The cards other provers hold on the same subgoal now: when every family is taken, left out while another card is left. */
  takenCards?: ReadonlySet<string>;
  /** The finished attempts of the session's bucket, on any claim, that had a card or the control. */
  history: readonly Attempt[];
  /** The session's model: another model's sessions count `crossModelWeight`. */
  model: string;
  partial: number;
  weigh?: AttemptWeight;
  config: HeuristicsConfig;
}

const round = (x: number): number => Math.round(x * 10000) / 10000;

/** The cards that may be drawn for a session: those that apply, and agree with its strategy. */
export function eligibleCards(bank: readonly BankCard[], context: CardContext, strategy: string | undefined): BankCard[] {
  return bank.filter((card) => {
    if (!applies(card, context)) return false;
    const label = strategyOfCard(card);
    return label === undefined || strategy === undefined || label === strategy;
  });
}

/**
 * One session's card (plan change HB2). The cards that apply and agree with the session's strategy are
 * eligible, less those whose measured effect in the bucket is negative (`cardEffect`, M5's deactivation rule); none:
 * no card. Otherwise a share `noCardShare` of the sessions get none (the control), drawn
 * first from `random`. The others draw a family by Thompson sampling over the family posteriors of the
 * bucket, leaving out the families other provers hold on the subgoal while another is left, then a card
 * of that family by Thompson sampling over the card posteriors, each with a prior of `familyPriorWeight`
 * pseudo-sessions at its family's mean, so that a new card starts from what its family has shown. Every
 * attempt counts its weight (the discount and the probation), times `crossModelWeight` when another
 * model made it. Rewards are the fleet's `choice` rewards (partial credit for depth).
 */
export function drawCard(random: RandomSource, input: CardDrawInput): CardDraw {
  const weigh: AttemptWeight = (attempt) => (input.weigh?.(attempt) ?? 1) * (attempt.model === input.model ? 1 : input.config.crossModelWeight);
  const applying = eligibleCards(input.bank, input.context, input.strategy);
  const rule = { minObservations: input.config.minObservations };
  const deactivated = applying.filter((card) => shouldDeactivate(cardEffect(card.id, input.history, weigh), rule)).map((card) => card.id);
  const eligible = applying.filter((card) => !deactivated.includes(card.id));
  const off = deactivated.length > 0 ? { deactivated } : {};
  if (eligible.length === 0) return { rule: "none_applicable", ...off };
  if (random() < input.config.noCardShare) return { rule: "control", ...off, eligible: eligible.map((card) => card.id) };
  const settingOf = (key: string) => (attempt: Attempt): string | undefined => {
    const value = attempt.settings?.[key];
    return typeof value === "string" ? value : undefined;
  };
  // Provers on one subgoal look at it in different ways: families no other prover holds first; when every family is
  // held, the families that still have a card no other prover holds; only then any card again.
  const takenCards = input.takenCards ?? new Set<string>();
  const untaken = eligible.filter((card) => !takenCards.has(card.id));
  const allFamilies = [...new Set(eligible.map((card) => card.family))];
  const free = allFamilies.filter((family) => !input.taken.has(family));
  const withFreeCard = [...new Set(untaken.map((card) => card.family))];
  const families = free.length > 0 ? free : withFreeCard.length > 0 ? withFreeCard : allFamilies;
  const familyPosteriors = group(input.history, settingOf("heuristicFamily"), input.partial, weigh);
  const family = thompson(random, families.map((f) => [f, familyPosteriors.get(f)?.choice ?? UNIFORM] as const));
  if (family === undefined) return { rule: "none_applicable", ...off };
  const mean = betaMean(familyPosteriors.get(family.choice)?.choice ?? UNIFORM);
  const w = input.config.familyPriorWeight;
  const cardPosteriors = group(input.history, settingOf("heuristic"), input.partial, weigh);
  const familyCards = eligible.filter((card) => card.family === family.choice);
  const freeInFamily = familyCards.filter((card) => !takenCards.has(card.id));
  const inFamily = freeInFamily.length > 0 ? freeInFamily : familyCards;
  const withPrior = (b: Beta | undefined): Beta => {
    const base = b ?? UNIFORM;
    return { alpha: base.alpha + w * mean, beta: base.beta + w * (1 - mean) };
  };
  const card = thompson(random, inFamily.map((c) => [c.id, withPrior(cardPosteriors.get(c.id)?.choice)] as const));
  const chosen = inFamily.find((c) => c.id === card?.choice);
  if (chosen === undefined || card === undefined) return { rule: "none_applicable", ...off };
  return {
    card: chosen,
    rule: "thompson",
    ...off,
    draws: {
      heuristicFamily: Object.fromEntries(family.draws.map(([f, d]) => [f, round(d)])),
      heuristic: Object.fromEntries(card.draws.map(([c, d]) => [c, round(d)])),
    },
  };
}

/**
 * The session's briefing section for its card. A pack's card is text from outside the run: it is said
 * so and quoted, like a pack's skill. The wording asks for no demonstration of the statement.
 */
export function heuristicSection(card: BankCard): Briefing {
  const tools = card.tools !== undefined && card.tools.length > 0 ? ` Tools that serve it: ${card.tools.join(", ")}.` : "";
  const fromPack = card.origin.startsWith("pack:");
  const ask = fromPack ? `[begin text of ${card.origin}]\n> ${card.ask}\n[end text of ${card.origin}]` : card.ask;
  return {
    title: "Heuristic for this session",
    text:
      "The harness drew this heuristic for the session: a way to look at the statement, not a fact and not a step of a proof. " +
      `Use it if it helps, and say in your notes whether it did.${tools}\n${ask}`,
  };
}
