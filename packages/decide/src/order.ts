import { MAX_CHOICE_OPTIONS } from "@seshat/core";
import { type Decide, type Decision, isInterrupted } from "@seshat/lines";
import { ForbiddenDecisionError } from "./errors.ts";

/**
 * The orderer that `prove.search` (Task 6, line M10) will call: it puts candidates that come without a
 * model call in the order to try them (plan change J3, item 3). Task 6 does not exist yet, so this is
 * the interface, a `decide`-backed implementation and a test double; the search takes any
 * `CandidateOrderer`.
 */
export const ORDER_SITE = "prove.search.order";

/** Where a candidate comes from. A model's own tactics are ranked by the model for free, and stay out. */
export type NonLlmSource = "battery" | "mined" | "library" | "aesop";
const SOURCES: readonly string[] = ["battery", "mined", "library", "aesop"];

export interface OrderCandidate {
  /** Stable name, unique among the candidates. */
  id: string;
  /** What it is, in a few words: a tactic, a lemma to apply, an aesop rule. */
  text: string;
  source: NonLlmSource;
}

export interface Ordered {
  /** The candidates in the order to try them. */
  candidates: OrderCandidate[];
  /** How: by a decision, or kept as given (the site is off, there was nothing to rank, or the decision failed). */
  by: "decision" | "kept";
  decision?: Decision;
}

export interface CandidateOrderer {
  order(state: string, candidates: readonly OrderCandidate[]): Promise<Ordered>;
}

const INSTRUCTIONS =
  "Which of these candidates should be tried first on the goal? Choose the one most likely to make progress. " +
  "The candidates come from fixed procedures, not from a model.";

function checkCandidates(candidates: readonly OrderCandidate[]): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!SOURCES.includes(c.source)) {
      throw new ForbiddenDecisionError(
        `candidate ${c.id} comes from ${String(c.source)}: when a model proposed the tactics its rank is free and stays; decide orders only ${SOURCES.join(", ")} candidates`,
      );
    }
    if (c.id === "" || seen.has(c.id)) throw new Error(`candidate ids are unique and not empty: ${JSON.stringify(c.id)}`);
    seen.add(c.id);
  }
}

/**
 * Orders by a decision: a Choice over the candidates (at most 255; the rest follow in the order given),
 * sorted by probability, ties in the order given. Only the order is used (plan change J4). With the
 * run's model and one vote the distribution has one label, so only the top candidate is separated; more
 * votes or Jev separate more. The site `off`, fewer than two candidates, or a failure of the decision
 * (not an interruption) keep the order given.
 */
export function decideOrderer(decide: Decide, options: { instructions?: string; log?: (text: string) => void } = {}): CandidateOrderer {
  return {
    async order(state, candidates) {
      checkCandidates(candidates);
      const kept: Ordered = { candidates: [...candidates], by: "kept" };
      if (candidates.length < 2 || decide.backendFor(ORDER_SITE) === "off") return kept;
      const ranked = candidates.slice(0, MAX_CHOICE_OPTIONS);
      const rest = candidates.slice(MAX_CHOICE_OPTIONS);
      let decision: Decision;
      try {
        decision = await decide.decide({
          site: ORDER_SITE,
          state,
          question: { type: "choice", instructions: options.instructions ?? INSTRUCTIONS, options: Object.fromEntries(ranked.map((c) => [c.id, c.text])) },
          use: "order",
        });
      } catch (error) {
        // A pause passes through, and so does a refusal of the forbidden list; any other failure keeps the order the search had.
        if (isInterrupted(error) || error instanceof ForbiddenDecisionError) throw error;
        options.log?.(`decide: the order of ${candidates.length} candidates was kept, the decision failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        return kept;
      }
      const rank = new Map(ranked.map((c, i) => [c.id, i]));
      const sorted = [...ranked].sort((a, b) => (decision.probabilities[b.id] ?? 0) - (decision.probabilities[a.id] ?? 0) || (rank.get(a.id) as number) - (rank.get(b.id) as number));
      return { candidates: [...sorted, ...rest], by: "decision", decision };
    },
  };
}

/** The orderer that keeps the order given: what the search does without `decide`. */
export const keepOrder: CandidateOrderer = {
  async order(_state, candidates) {
    checkCandidates(candidates);
    return { candidates: [...candidates], by: "kept" };
  },
};

/** A test double for the search: puts the ids `first` at the front, in that order, the rest as given. */
export function scriptedOrderer(first: readonly string[]): CandidateOrderer & { readonly asked: Array<{ state: string; ids: string[] }> } {
  const asked: Array<{ state: string; ids: string[] }> = [];
  return {
    asked,
    async order(state, candidates) {
      checkCandidates(candidates);
      asked.push({ state, ids: candidates.map((c) => c.id) });
      const front = first.flatMap((id) => candidates.filter((c) => c.id === id));
      return { candidates: [...front, ...candidates.filter((c) => !first.includes(c.id))], by: "decision" };
    },
  };
}

