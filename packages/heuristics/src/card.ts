import { FAILURE_CLASSES, type Strategy } from "@seshat/memory";

/**
 * The closed vocabulary of families (plan change HB1, aligned with the eleven families of SHAPE, arXiv
 * 2608.28600). A card is measured by its family first, so that cards from many traditions that say the
 * same thing share their counts. A new family is a change of the plan, not a pack's choice.
 */
export const FAMILIES = [
  "specialize",
  "generalize",
  "auxiliary",
  "decompose",
  "work_backwards",
  "analogy",
  "represent",
  "restate",
  "simplify",
  "definitions",
  "vary",
  "compute",
  "invariant",
  "extremal",
  "count",
  "symmetry",
  "contradiction",
  "induction",
  "counterexample",
  "bounds",
  "automation",
  "look_back",
] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * Zeitz's levels, less the third: a `strategy` card is an attitude (how to work), a `tactic` card a
 * mathematical move. Zeitz's `tool` level is not a card: tools are capabilities of the registry.
 */
export const LEVELS = ["strategy", "tactic"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * The strategy label of M1 a tactic card's family is a move of, when there is one. A tactic card is
 * drawn only for a session whose strategy is that label (or a session with no strategy), so that a
 * session is never told two directions at once. A family without a label is neutral, and so is
 * every strategy card.
 */
export const FAMILY_STRATEGY: Readonly<Partial<Record<Family, Strategy>>> = {
  compute: "computation",
  induction: "induction",
  decompose: "cases",
  contradiction: "contradiction",
  automation: "automation",
  counterexample: "counterexample",
  generalize: "generalization",
  bounds: "bounds",
  extremal: "extremal",
  count: "extremal",
};

/** What a card says progress looks like: read by the report, never by the prover. */
export const EXPECTS = ["subgoals", "table", "counterexample", "lemma", "witness", "closed"] as const;
export type Expect = (typeof EXPECTS)[number];

/**
 * The statement features a `when` may name (`features.ts` reads them from the statement's text, with
 * no model): `forall_nat` (a natural-number variable bound by the signature or by ∀), `exists`,
 * `inequality`, `divisibility`, `prime`, `finset_sum` (a finite sum or product), `real`,
 * `function_equation` (a function variable between number types), and the size classes.
 */
export const STATEMENT_FEATURES = [
  "forall_nat",
  "exists",
  "inequality",
  "divisibility",
  "prime",
  "finset_sum",
  "real",
  "function_equation",
  "size_small",
  "size_medium",
  "size_large",
] as const;
export type StatementFeature = (typeof STATEMENT_FEATURES)[number];

/** The session modes a `when` may name (the fleet's). */
export const CARD_MODES = ["standard", "nl_first"] as const;

/**
 * When a card applies: every field given must hold (a conjunction); a list holds when one of its
 * values does, except `features`, which all must be present. An empty condition always holds.
 */
export interface Condition {
  /** The problem has a domain that starts with one of these (`msc:05`, `msc:11B`). */
  domains?: string[];
  /** All of these statement features are present. */
  features?: StatementFeature[];
  /** At least one of these is present. */
  anyFeatures?: StatementFeature[];
  /** The counted attempts on the claim (or the subgoal) so far, at least and at most. */
  minAttempts?: number;
  maxAttempts?: number;
  /** The last counted attempt failed with one of these classes (`@seshat/memory` FAILURE_CLASSES). */
  lastFailure?: string[];
  /** The counted attempts since Lean last got further on the claim, at least. */
  minDepthStuck?: number;
  /** The session runs in one of these modes. */
  modes?: string[];
}

/** A heuristic card (plan change HB1). Built in, or from a pack. */
export interface HeuristicCard {
  /** Stable name: lowercase words joined by `_`, in parts joined by `.` (`specialize.toy_model`). */
  id: string;
  version: number;
  family: Family;
  level: Level;
  /** What the prover reads: one line, a question or a short directive, at most `ASK_MAX` characters. */
  ask: string;
  when?: Condition;
  whenNot?: Condition;
  /** The capabilities that serve the method, named for the prover. The card is not one of them. */
  tools?: string[];
  expects?: Expect;
  /** The tradition (`polya`, `first_principles`, `cps_votat`, `zeitz`, `engel`, `tao`...) and a reference. Never shown to the prover. */
  tradition: string;
  source: string;
}

export const ASK_MAX = 160;
export const CARD_ID = /^[a-z][a-z0-9_]{0,31}(\.[a-z0-9_]{1,32}){0,2}$/;
const TOOL_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/;
const DOMAIN = /^msc:[0-9][0-9A-Z]{0,4}$/;

// Control, format, bidirectional, zero-width and tag characters: nothing a reader cannot see.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
const LINK = /https?:|www\.|\]\(|<[a-z]|`/i;

/** The problems of a text a model will read, or none. */
function textProblems(field: string, text: unknown, max: number): string[] {
  if (typeof text !== "string" || text.trim() === "") return [`${field} is a non-empty string`];
  const problems: string[] = [];
  if (text.length > max) problems.push(`${field} has ${text.length} characters, more than ${max}`);
  if (INVISIBLE.test(text)) problems.push(`${field} holds a control or invisible character`);
  if (LINK.test(text)) problems.push(`${field} holds a link, markup or code`);
  if (text !== text.trim()) problems.push(`${field} starts or ends with a space`);
  return problems;
}

function listOf(field: string, value: unknown, check: (item: unknown) => boolean, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || !value.every(check)) return [`${field} is a non-empty list of ${what}`];
  return [];
}

const count = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000;

/** The problems of a condition, or none. */
export function conditionProblems(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${field} is an object`];
  const c = value as Record<string, unknown>;
  const known = new Set(["domains", "features", "anyFeatures", "minAttempts", "maxAttempts", "lastFailure", "minDepthStuck", "modes"]);
  const problems = Object.keys(c).filter((k) => !known.has(k)).map((k) => `${field}.${k} is not a condition this version knows`);
  const isFeature = (f: unknown): boolean => (STATEMENT_FEATURES as readonly unknown[]).includes(f);
  problems.push(
    ...listOf(`${field}.domains`, c.domains, (d) => typeof d === "string" && DOMAIN.test(d), "MSC prefixes such as msc:05"),
    ...listOf(`${field}.features`, c.features, isFeature, `statement features (${STATEMENT_FEATURES.join(", ")})`),
    ...listOf(`${field}.anyFeatures`, c.anyFeatures, isFeature, "statement features"),
    ...listOf(`${field}.lastFailure`, c.lastFailure, (f) => (FAILURE_CLASSES as readonly unknown[]).includes(f), `failure classes (${FAILURE_CLASSES.join(", ")})`),
    ...listOf(`${field}.modes`, c.modes, (m) => (CARD_MODES as readonly unknown[]).includes(m), `session modes (${CARD_MODES.join(", ")})`),
  );
  for (const key of ["minAttempts", "maxAttempts", "minDepthStuck"]) {
    if (c[key] !== undefined && !count(c[key])) problems.push(`${field}.${key} is a whole number from 0 to 1000`);
  }
  if (count(c.minAttempts) && count(c.maxAttempts) && (c.minAttempts as number) > (c.maxAttempts as number)) {
    problems.push(`${field} has minAttempts above maxAttempts`);
  }
  return problems;
}

/**
 * The problems of a card, or none: what `harness add` refuses in a pack and a test refuses in the
 * built-in bank. The text checks are a floor (no invisible character, no link, no code, one line);
 * the card's wording is a person's, and a person reads it.
 */
export function cardProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["a card is an object"];
  const card = value as Record<string, unknown>;
  const known = new Set(["id", "version", "family", "level", "ask", "when", "whenNot", "tools", "expects", "tradition", "source"]);
  const problems = Object.keys(card).filter((k) => !known.has(k)).map((k) => `the field ${k} is not one a card has`);
  if (typeof card.id !== "string" || !CARD_ID.test(card.id)) problems.push("id is lowercase words joined by _, in at most three parts joined by . (specialize.toy_model)");
  if (typeof card.version !== "number" || !Number.isInteger(card.version) || card.version < 1) problems.push("version is a whole number from 1");
  if (!(FAMILIES as readonly unknown[]).includes(card.family)) problems.push(`family is one of ${FAMILIES.join(", ")}`);
  if (!(LEVELS as readonly unknown[]).includes(card.level)) problems.push(`level is ${LEVELS.join(" or ")}`);
  problems.push(...textProblems("ask", card.ask, ASK_MAX));
  problems.push(...conditionProblems("when", card.when), ...conditionProblems("whenNot", card.whenNot));
  if (card.whenNot !== null && typeof card.whenNot === "object" && Object.keys(card.whenNot).length === 0) problems.push("whenNot is empty: the card would never apply");
  problems.push(...listOf("tools", card.tools, (t) => typeof t === "string" && TOOL_ID.test(t), "capability ids such as compute.sage"));
  if (card.expects !== undefined && !(EXPECTS as readonly unknown[]).includes(card.expects)) problems.push(`expects is one of ${EXPECTS.join(", ")}`);
  problems.push(...textProblems("tradition", card.tradition, 40), ...textProblems("source", card.source, 300));
  return problems;
}

/** The card, checked; throws with every problem otherwise. */
export function parseCard(value: unknown, where = "card"): HeuristicCard {
  const problems = cardProblems(value);
  if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}`);
  return value as HeuristicCard;
}

/** The strategy label a card's family is a move of, for a tactic card; none for a strategy card or a neutral family. */
export function strategyOfCard(card: Pick<HeuristicCard, "family" | "level">): Strategy | undefined {
  return card.level === "tactic" ? FAMILY_STRATEGY[card.family] : undefined;
}
