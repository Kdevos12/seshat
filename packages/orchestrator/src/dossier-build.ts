import { type HarnessEvent, readEvents, type Journal } from "@seshat/core";
import type { NarrativeCall } from "./account.ts";
import { frontier as frontierOf, frontierCardLines, type FrontierOptions, type MemoryStore, STATE_CARD_CHARS } from "@seshat/memory";
import { activities, byActivity, type DeadEnd, type Activity, type DossierSection, deadEndStore, parseReflection, REFLECT_MAX_TOKENS, REFLECT_SYSTEM, reflectionPrompt, renderDossier, toRetire } from "./dossier.ts";

/** The dossier's default bound in tokens: the state card's bound in characters, at about four characters a token. */
export const DEFAULT_DOSSIER_TOKENS = Math.ceil(STATE_CARD_CHARS / 4);

/** What the journal and the frontier give the dossier of a problem, at this moment. */
export function dossierParts(journal: Journal, store: MemoryStore, claimId: string, frontierOptions: FrontierOptions): { items: DeadEnd[]; activity: Map<string, Activity>; frontierLines: string[] } {
  const events = readEvents(journal.log.path);
  const f = frontierOf(store, claimId, frontierOptions);
  const { items } = deadEndStore(events, f.entries.filter((e) => e.kind === "dead_end"));
  const activity = activities(events, items, f.entries.map((e) => e.seq));
  return { items: byActivity(items, activity), activity, frontierLines: frontierCardLines(f, 1500, frontierOptions) };
}

/** The dossier of a campaign session, rebuilt from the journal at its start (documentation/campaign.md, "The dossier"). */
export function buildDossier(o: { journal: Journal; store: MemoryStore; claimId: string; statement: string; frontier: FrontierOptions; tokens?: number; unverified: readonly DossierSection[] }): string {
  const parts = dossierParts(o.journal, o.store, o.claimId, o.frontier);
  return renderDossier({ statement: o.statement, frontier: parts.frontierLines, items: parts.items, activity: parts.activity, unverified: o.unverified, tokens: o.tokens ?? DEFAULT_DOSSIER_TOKENS });
}

/** The items to retire now, over every problem of the run: see `toRetire`. */
export function retirementOf(events: readonly HarnessEvent[], store: MemoryStore, claimIds: readonly string[], frontierOptions: FrontierOptions, bound: number): Array<{ key: string; score: number }> {
  const entries = claimIds.flatMap((id) => frontierOf(store, id, frontierOptions).entries);
  const { items } = deadEndStore(events, entries.filter((e) => e.kind === "dead_end"));
  return toRetire(items, activities(events, items, entries.map((e) => e.seq)), bound);
}

/** The site of the reflection call in the journal. */
export const SITE_CAMPAIGN_REFLECT = "campaign.reflect";
/** The reflection's own budget in dollars for the run: a short answer, once a turn. */
export const REFLECT_USD = 0.25;

/**
 * The capped reflection (`campaign.reflect`, plan change LH4): one model call, at most once a turn, from the dossier's items; code validates the answer
 * (`parseReflection`) and journals what it keeps as a delta of the store (`campaign.dossier`). A malformed answer or a failed call changes nothing and is
 * logged. The model never writes the dossier.
 */
export async function reflectOnce(o: {
  journal: Journal;
  store: MemoryStore;
  runId: string;
  turn: number;
  claimId: string;
  statement: string;
  frontier: FrontierOptions;
  call: NarrativeCall;
  log: (line: string) => void;
}): Promise<{ added: number; dropped: number } | undefined> {
  try {
    const parts = dossierParts(o.journal, o.store, o.claimId, o.frontier);
    const answer = await o.call({ system: REFLECT_SYSTEM, prompt: reflectionPrompt(o.statement, parts.frontierLines, parts.items), maxTokens: REFLECT_MAX_TOKENS });
    const { kept, dropped } = parseReflection(answer.text);
    if (kept.length > 0) o.journal.emit("campaign.dossier", { runId: o.runId, turn: o.turn, added: kept }, "orchestrator");
    o.log(`the reflection added ${kept.length} dead end(s) to the dossier${dropped > 0 ? `, ${dropped} dropped` : ""}`);
    return { added: kept.length, dropped };
  } catch (error) {
    o.log(`the reflection call changed nothing: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
