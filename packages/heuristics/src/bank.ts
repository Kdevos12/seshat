import { BUILTIN_CARDS } from "./builtin.ts";
import { cardProblems, type HeuristicCard } from "./card.ts";

/** A card with where it comes from: `builtin`, or `pack:<name>`. */
export interface BankCard extends HeuristicCard {
  origin: string;
}

/** Two cards that may say the same thing: reported, never merged (a person chooses). */
export interface Overlap {
  a: string;
  b: string;
  family: string;
  /** The share of content words the two `ask` texts have in common (Jaccard). */
  similarity: number;
  reason: string;
}

/** At or above this share of common content words, two cards of one family are reported as overlapping. */
export const OVERLAP_THRESHOLD = 0.4;

// Words that carry no content in a card's question.
const STOP = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "than", "then", "from", "what", "which", "does", "into", "each", "they", "them",
  "can", "could", "would", "will", "one", "its", "are", "not", "any", "there", "here", "when", "where", "before", "after", "first", "only",
  "once", "say", "how", "who", "all", "out", "off", "has", "have", "how", "now", "but", "too", "via",
]);

/** The content words of a text: lowercase, three letters or more, without the stop words, roughly singular. */
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const w of a) if (b.has(w)) common += 1;
  return common / (a.size + b.size - common);
}

const conditionKey = (card: HeuristicCard): string => JSON.stringify([card.when ?? {}, card.whenNot ?? {}]);

/**
 * The pairs of cards of one family that may say the same thing: their questions share at least
 * `OVERLAP_THRESHOLD` of their content words, or they have the same text. Cards of different families
 * never overlap here: the family is what they are measured by, and two traditions that say the same
 * thing in one family share its counts anyway.
 */
export function overlaps(cards: readonly HeuristicCard[], threshold = OVERLAP_THRESHOLD): Overlap[] {
  const found: Overlap[] = [];
  const words = cards.map((card) => contentWords(card.ask));
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i] as HeuristicCard;
      const b = cards[j] as HeuristicCard;
      if (a.family !== b.family) continue;
      const similarity = Math.round(jaccard(words[i] as Set<string>, words[j] as Set<string>) * 100) / 100;
      if (a.ask.trim().toLowerCase() === b.ask.trim().toLowerCase()) found.push({ a: a.id, b: b.id, family: a.family, similarity: 1, reason: "the same question" });
      else if (similarity >= threshold) {
        const same = conditionKey(a) === conditionKey(b) ? ", with the same conditions" : "";
        found.push({ a: a.id, b: b.id, family: a.family, similarity, reason: `${Math.round(similarity * 100)}% of their content words in common${same}` });
      }
    }
  }
  return found;
}

/** What `checkBank` finds: errors refuse the bank (or the pack), overlaps are reported. */
export interface BankCheck {
  errors: string[];
  overlaps: Overlap[];
}

/**
 * The checks of a bank: every card valid, every id once (a pack may not reuse a built-in id or
 * another pack's), and the overlaps. `harness add` refuses a pack with an error and prints its
 * overlaps; the built-in bank has neither (a test checks it).
 */
export function checkBank(cards: readonly BankCard[]): BankCheck {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const card of cards) {
    for (const problem of cardProblems(stripOrigin(card))) errors.push(`${card.origin} card ${String(card.id)}: ${problem}`);
    const first = seen.get(card.id);
    if (first !== undefined) errors.push(`the card id ${card.id} is taken twice (${first} and ${card.origin})`);
    else seen.set(card.id, card.origin);
  }
  return { errors, overlaps: overlaps(cards) };
}

function stripOrigin(card: BankCard): HeuristicCard {
  const { origin: _origin, ...rest } = card;
  return rest;
}

/** The built-in cards, with their origin. */
export function builtinBank(): BankCard[] {
  return BUILTIN_CARDS.map((card) => ({ ...card, origin: "builtin" }));
}

/**
 * The bank a run draws from: the built-in cards and the cards of the installed packs, checked. A
 * bank with an error is refused (a pack that passed `harness add` cannot make one, unless a later
 * release of the harness took one of its ids: the message says which).
 */
export function bankOf(packs: readonly { name: string; heuristics?: readonly HeuristicCard[] }[] = []): BankCard[] {
  const cards = [...builtinBank(), ...packs.flatMap((pack) => (pack.heuristics ?? []).map((card) => ({ ...card, origin: `pack:${pack.name}` })))];
  const { errors } = checkBank(cards);
  if (errors.length > 0) throw new Error(`the heuristic bank is refused: ${errors.join("; ")}`);
  return cards;
}
