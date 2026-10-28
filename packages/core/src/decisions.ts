import { SITE } from "./records.ts";

/**
 * Decisions (documentation/decide.md): a typed choice, score or yes/no that a backend makes about a
 * short state, to order work. They are journaled as `decision.made`, by the orchestrator only, and a
 * decision changes no claim's status.
 */
export const DECISION_BACKENDS = ["llm", "jev", "faux"] as const;
export type DecisionBackend = (typeof DECISION_BACKENDS)[number];

export const DECISION_TYPES = ["choice", "score", "noul"] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** The most options of a choice, and the levels of a score (plan change J2). */
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/**
 * The only sites that accept `decide` (plan change J3), each with the question types it asks. A new
 * site is a change of this list, which is a change of the trust boundary: review it as one.
 */
export const DECISION_SITES: Readonly<Record<string, readonly DecisionType[]>> = {
  /** PC4.2: a Score per conjecture of the pool, on its statement alone (or its yes/no coarsening). */
  "conjecture.relevance": ["score", "noul"],
  /** PC6.3: ordering candidates that come without a model call. */
  "prove.search.order": ["choice"],
  /** The fleet's cold start: a Choice over strategy families, as capped pseudo-counts. */
  "fleet.cold_start": ["choice"],
};

/**
 * What `decide` is never used for, whatever the configuration (plan change J3), as patterns on a
 * site's dotted words with the reason. Checked by the capability, by the journal and by the
 * configuration, not by convention.
 */
export const FORBIDDEN_DECISION_SITES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\.)(fidelity|equivalence|equiv|informal)(\.|_|$)/, reason: "the statement-fidelity review, and the equivalence of a Lean statement with an informal one, are high-stakes readings of a statement" },
  { pattern: /(^|\.)(status|verdict|accept|certify|validate|proved|refute|retract|sign)(\.|_|$)/, reason: "a claim's status is changed only by a Lean proof through validate" },
  { pattern: /(^|\.)(progress|goals|closed|term_size|typecheck|lean|check)(\.|_|$)/, reason: "what Lean, a decision procedure or a tool can decide (including whether a step made progress) is never put to a model" },
  { pattern: /(^|\.)(generate|generation|write|draft|session|prove_text)(\.|_|$)/, reason: "decide does not generate" },
];

/** Why `site` may not use `decide`, or undefined when it may. */
export function decisionSiteProblem(site: string): string | undefined {
  if (!SITE.test(site)) return `${JSON.stringify(site)} is not a site (dotted lowercase words)`;
  for (const { pattern, reason } of FORBIDDEN_DECISION_SITES) {
    if (pattern.test(site)) return `decide is forbidden at ${site}: ${reason}`;
  }
  if (!Object.hasOwn(DECISION_SITES, site)) {
    return `${site} is not a decide site (${Object.keys(DECISION_SITES).join(", ")})`;
  }
  return undefined;
}
