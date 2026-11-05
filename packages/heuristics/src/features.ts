import { type Attempt, attemptDepth } from "@seshat/memory";
import type { Condition, StatementFeature } from "./card.ts";

/**
 * The statement features of a Lean statement in signature form (`(n : ℕ) (h : 0 < n) : ...`), read
 * from its text alone: no model, no Lean. They are lexical, so they can be wrong on an unusual
 * notation; a card that keys on them is filtered, not proved applicable. The order of the list is
 * fixed (`STATEMENT_FEATURES`), so the same statement always gives the same list.
 */
export function statementFeatures(statement: string): StatementFeature[] {
  // Arrows and `=>` hold `<` and `>` that are not comparisons.
  const text = statement.replace(/=>|->|<-|<->|←|→|↔|⟨|⟩/g, " ");
  const found = new Set<StatementFeature>();
  const binders = /^\s*[({[⦃]/.test(statement);
  if (/ℕ|\bNat\b/.test(statement) && (binders || /∀/.test(statement))) found.add("forall_nat");
  if (/∃|\bExists\b/.test(statement)) found.add("exists");
  if (/[≤≥<>≠]|\bNat\.le\b|\bNat\.lt\b/.test(text)) found.add("inequality");
  if (/∣|%|\bNat\.ModEq\b|\bInt\.ModEq\b|≡|\bdvd\b/.test(statement)) found.add("divisibility");
  if (/\bPrime\b|\.Prime\b|\bNat\.Prime\b/.test(statement)) found.add("prime");
  if (/∑|∏|\bFinset\.sum\b|\bFinset\.prod\b|\bFinset\.card\b/.test(statement)) found.add("finset_sum");
  if (/ℝ|\bReal\b/.test(statement)) found.add("real");
  if (/:\s*[ℕℤℚℝℂ]\s*→\s*[ℕℤℚℝℂ]/.test(statement)) found.add("function_equation");
  const size = statement.length;
  found.add(size < 80 ? "size_small" : size < 240 ? "size_medium" : "size_large");
  const order: StatementFeature[] = [
    "forall_nat", "exists", "inequality", "divisibility", "prime", "finset_sum", "real", "function_equation", "size_small", "size_medium", "size_large",
  ];
  return order.filter((f) => found.has(f));
}

/** What a session's `when` is read against. */
export interface CardContext {
  /** The problem's domains, `msc:11`. */
  domains: readonly string[];
  features: readonly StatementFeature[];
  /** The counted attempts on the claim (or the subgoal) so far. */
  attempts: number;
  /** The failure class of the last counted attempt, when it failed. */
  lastFailure?: string;
  /** The counted attempts since Lean last got further. */
  depthStuck: number;
  /** The session's mode (`standard` when none was sampled). */
  mode: string;
}

/**
 * The history part of a context, from a claim's attempts in the order they were made: how many
 * counted (an attempt that says nothing does not), how the last one failed, and how many counted since
 * the deepest check so far was first reached.
 */
export function historyOf(attempts: readonly Pick<Attempt, "outcome" | "failureClass">[]): Pick<CardContext, "attempts" | "lastFailure" | "depthStuck"> {
  let counted = 0;
  let best = -1;
  let since = 0;
  let lastFailure: string | undefined;
  for (const attempt of attempts) {
    const depth = attemptDepth(attempt);
    if (depth === undefined) continue;
    counted += 1;
    lastFailure = attempt.outcome === "invalid" ? attempt.failureClass : undefined;
    if (depth > best) {
      best = depth;
      since = 0;
    } else since += 1;
  }
  return { attempts: counted, depthStuck: since, ...(lastFailure !== undefined ? { lastFailure } : {}) };
}

/** Whether a condition holds in a context. An absent or empty condition holds. */
export function holds(condition: Condition | undefined, context: CardContext): boolean {
  if (condition === undefined) return true;
  const c = condition;
  if (c.domains !== undefined && !c.domains.some((prefix) => context.domains.some((d) => d.startsWith(prefix)))) return false;
  if (c.features !== undefined && !c.features.every((f) => context.features.includes(f))) return false;
  if (c.anyFeatures !== undefined && !c.anyFeatures.some((f) => context.features.includes(f))) return false;
  if (c.minAttempts !== undefined && context.attempts < c.minAttempts) return false;
  if (c.maxAttempts !== undefined && context.attempts > c.maxAttempts) return false;
  if (c.lastFailure !== undefined && (context.lastFailure === undefined || !c.lastFailure.includes(context.lastFailure))) return false;
  if (c.minDepthStuck !== undefined && context.depthStuck < c.minDepthStuck) return false;
  if (c.modes !== undefined && !c.modes.includes(context.mode)) return false;
  return true;
}

/**
 * Whether a card applies: its `when` holds and its `whenNot`, when it has one, does not. A `whenNot`
 * that is an empty object would hold everywhere, so the check refuses it as a card that never applies;
 * it is read here as it is written.
 */
export function applies(card: { when?: Condition; whenNot?: Condition }, context: CardContext): boolean {
  return holds(card.when, context) && (card.whenNot === undefined || !holds(card.whenNot, context));
}

/**
 * The bucket a session's counts are kept under, across problems: the problem's first domain, two digits
 * (`msc:11`, or `msc:none`), and the first two statement features in their fixed order, size excluded
 * (`msc:11|forall_nat+divisibility`). Coarse on purpose: a bucket must gather enough sessions to say
 * something (documentation/heuristics.md, "Measure").
 */
export function bucketOf(domains: readonly string[], features: readonly StatementFeature[]): string {
  const domain = domains[0]?.match(/^msc:[0-9]{2}/)?.[0] ?? "msc:none";
  const shape = features.filter((f) => !f.startsWith("size_")).slice(0, 2);
  return `${domain}|${shape.length === 0 ? "plain" : shape.join("+")}`;
}
