import { hash32, type Json, seeded } from "@seshat/core";
import { shouldDeactivate, type MemoryStore } from "@seshat/memory";
import { injectedPart } from "./consolidation-page.ts";
import { newestPage } from "./consolidate.ts";

/** The heading of the section that carries a page in a session's first user message. */
export const PAGE_SECTION_TITLE = "Unverified notes from an earlier run";

/** The rule that switches a page off: as the lessons', P(effect < 0) above 0.9 after 8 observations with the page and 8 without it. */
export const PAGE_DEACTIVATION = { minObservations: 8, threshold: 0.9 };

export interface PageForSession {
  /** What the draw decided, to be recorded on `attempt.started` with the other draws (absent: no page for this claim, or it is off). */
  included?: string[];
  withheld?: string[];
  /** The text of the section, when the draw included the page. */
  section?: { title: string; text: string };
}

/**
 * The page of an earlier consolidation pass for a session (documentation/consolidation.md, "Showing the page"; `RunConfig.consolidation`).
 * Only the newest page of the claim counts. A page whose measured effect is negative is switched off (a delta, written as the orchestrator)
 * and shown no more; otherwise it is drawn like a lesson (`MemoryStore.draw`, seeded by the run's seed, the problem, the prover and the
 * session), and when included its capped part goes in the session's first user message, never in the system prompt.
 */
export function pageForSession(store: MemoryStore, o: { claimId: string; problemId: string; prover: string; session: number; seed: string | number }): PageForSession {
  const page = newestPage(store, o.claimId);
  if (page === undefined || !page.active || page.sentences.length === 0) return {};
  const effect = store.itemEffect(page.nodeId, { claimIds: store.equivalents(o.claimId) });
  if (shouldDeactivate(effect, PAGE_DEACTIVATION)) {
    store.updateNode(
      page.nodeId,
      { active: false, deactivated: { rule: "effect", reason: `P(effect < 0) = ${effect.pNegative.toFixed(2)} with ${effect.with.attempts} attempt(s) that had it (${effect.with.successes.toFixed(1)} accepted) and ${effect.without.attempts} that did not (${effect.without.successes.toFixed(1)} accepted)` } } as unknown as Json,
      "page switched off by its effect",
    );
    return {};
  }
  const random = seeded(hash32(`${o.seed}:draw:${o.problemId}:${o.prover}:${o.session}:consolidation`));
  const drawn = store.draw([page.nodeId], random);
  const text = injectedPart(page.sentences);
  return {
    included: drawn.included,
    withheld: drawn.withheld,
    ...(drawn.included.includes(page.nodeId) && text !== "" ? { section: { title: PAGE_SECTION_TITLE, text: `${text}\n(Written by a model from the journal of an earlier run; not proved and possibly wrong: Lean's verdicts and the goal decide.)` } } : {}),
  };
}
