import { type Decide, isInterrupted, judge, type Llm } from "@seshat/lines";

/**
 * The target-centred conjecture pool (plan change PC4 item 2, after Seed-Prover's heavy mode): a model proposes
 * properties of the target's objects, each becomes an `open` claim, and the pool is scored by (proof rate,
 * relevance, proof length) and pruned before it enters a briefing. The relevance is judged on the statement
 * alone: through `decide` (a Score per conjecture, site `conjecture.relevance`, plan change J3 item 1) when the
 * run has it on for that site, else through `judge`. A relevance only orders the pool; it changes no status.
 */
export const RELEVANCE_SITE = "conjecture.relevance";
export const RELEVANCE_LEVELS = ["irrelevant", "marginal", "useful", "central"] as const;

export interface Relevance {
  /** 0 to 1. */
  value: number;
  via: "decide" | "judge";
  /** For `judge`: whether the votes disagreed. */
  disagreement?: boolean;
}

export interface RelevanceDeps {
  decide?: Decide;
  llm: Llm;
  /** Votes of `judge` when `decide` is absent or off. Default 1. */
  votes?: number;
  log?: (text: string) => void;
}

/** The relevance of a statement to the target, on the statement alone. An interruption passes through. */
export async function relevanceOf(deps: RelevanceDeps, target: string, statement: string): Promise<Relevance> {
  const instructions = `How useful would this statement be as a lemma toward proving: ${target.slice(0, 400)}? Judge the statement alone.`;
  if (deps.decide !== undefined && deps.decide.backendFor(RELEVANCE_SITE) !== "off") {
    try {
      const d = await deps.decide.decide({ site: RELEVANCE_SITE, state: statement, question: { type: "score", instructions, levels: [...RELEVANCE_LEVELS] }, use: "order" });
      const index = d.expected ?? RELEVANCE_LEVELS.indexOf(String(d.answer) as (typeof RELEVANCE_LEVELS)[number]);
      return { value: Math.max(0, Math.min(1, index / (RELEVANCE_LEVELS.length - 1))), via: "decide" };
    } catch (error) {
      if (isInterrupted(error)) throw error;
      deps.log?.(`decide failed for a conjecture's relevance (${error instanceof Error ? error.message : String(error)}); asking judge`);
    }
  }
  const j = await judge(deps.llm, { prompt: `${instructions}\n\nStatement: ${statement}\n\nAnswer with a score from 0 (irrelevant) to 1 (central).`, site: RELEVANCE_SITE, k: deps.votes ?? 1, min: 0, max: 1 });
  return { value: j.result ?? 0, via: "judge", disagreement: j.disagreement };
}

export interface PoolEntry {
  claimId: string;
  statement: string;
  relevance: number;
  /** The interestingness score of the hypothesis, 0 to 1. */
  interest: number;
  /** Sessions that worked it and how many proved it, from the attempts on the claim. */
  attempts: number;
  proved: number;
  /** The length of the shortest accepted proof, in characters, once there is one. */
  proofChars?: number;
}

export interface PoolWeights {
  relevance: number;
  interest: number;
  proofRate: number;
}

export const POOL_WEIGHTS: PoolWeights = { relevance: 0.5, interest: 0.3, proofRate: 0.2 };

/** The pool score: relevance, interest, and the proof rate (which counts for nothing before an attempt). */
export function poolScore(entry: PoolEntry, w: PoolWeights = POOL_WEIGHTS): number {
  const rate = entry.attempts === 0 ? 0 : entry.proved / entry.attempts;
  const used = entry.attempts === 0 ? w.relevance + w.interest : w.relevance + w.interest + w.proofRate;
  return (w.relevance * entry.relevance + w.interest * entry.interest + (entry.attempts === 0 ? 0 : w.proofRate * rate)) / used;
}

export interface Pruned {
  kept: PoolEntry[];
  pruned: Array<{ entry: PoolEntry; reason: string }>;
}

/**
 * Prunes the pool as Seed-Prover's heavy mode does: a conjecture of low relevance goes, and so does a proved one
 * whose proof is short (the battery would have found it: not worth the briefing's room). The rest are ranked by
 * score and the first `keep` stay.
 */
export function prunePool(entries: readonly PoolEntry[], o: { minRelevance?: number; minProofChars?: number; keep?: number } = {}): Pruned {
  const minRelevance = o.minRelevance ?? 0.34;
  const minProofChars = o.minProofChars ?? 40;
  const pruned: Pruned["pruned"] = [];
  const alive: PoolEntry[] = [];
  for (const entry of entries) {
    if (entry.relevance < minRelevance) pruned.push({ entry, reason: `relevance ${entry.relevance.toFixed(2)} is below ${minRelevance}` });
    else if (entry.proofChars !== undefined && entry.proofChars < minProofChars) pruned.push({ entry, reason: `its proof is ${entry.proofChars} characters, under ${minProofChars}` });
    else alive.push(entry);
  }
  alive.sort((a, b) => poolScore(b) - poolScore(a) || (a.claimId < b.claimId ? -1 : 1));
  const keep = o.keep ?? 8;
  for (const entry of alive.slice(keep)) pruned.push({ entry, reason: `ranked below the ${keep} kept` });
  return { kept: alive.slice(0, keep), pruned };
}
