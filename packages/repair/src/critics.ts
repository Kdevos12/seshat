import { FAILURE_CLASSES, type FailureClass } from "@seshat/memory";

/**
 * Typed repairs (line M14): a table from the way a proof failed to the repair that fits, after the proof critics of
 * Ireland and Bundy (1996). A critic does not prove anything: it reads the failure (its class, its short typed detail,
 * the first unsolved goal, the strategy of the attempt) and, when the failure has the shape the critic knows, says what
 * to change. The directive goes into the next session's briefing as a suggestion; Lean judges what comes of it.
 */
export const CRITICS = ["induction_revision", "generalization", "lemma_speculation", "case_split"] as const;
export type CriticId = (typeof CRITICS)[number];

/** What a failed attempt shows, in the words the critics need. */
export interface Situation {
  failureClass: FailureClass;
  /** The typed summary of the failure (`unsolved goals at case succ`). */
  detail: string;
  /** The strategy classified from the submission (`induction`, `simp`...), when there is one. */
  strategy?: string;
  /** The first unsolved goal or error text Lean printed, clipped. */
  goal?: string;
  /** The statement of the claim, in signature form. */
  statement: string;
  /** The submitted proof, to see which tactics it used. */
  proof?: string;
}

export interface Repair {
  critic: CriticId;
  /** A short name for the log and the briefing. */
  title: string;
  /** The classes of failure the critic reads; the others are not its business. */
  classes: readonly FailureClass[];
  /** Why this critic applies to this situation, or undefined when it does not. */
  applies: (s: Situation) => string | undefined;
  /** What to do, written for the prover that goes on. */
  directive: (s: Situation) => string;
}

const text = (s: Situation): string => `${s.detail}\n${s.goal ?? ""}`;
const usesInduction = (s: Situation): boolean => s.strategy === "induction" || /\binduction\b|\bNat\.rec\b|\brcases?\b.*\bih\b/.test(s.proof ?? "");
const stuckInStep = (s: Situation): boolean => /case (succ|step|ih|insert|cons|inr?)\b|\bih\b|n \+ 1|succ/.test(text(s));
const ihUnused = (s: Situation): boolean => /\bih\b|IH|inductive hypothesis|induction hypothesis/.test(text(s));

/** The table. The order is the order of preference when several apply. */
export const REPAIR_TABLE: readonly Repair[] = [
  {
    critic: "induction_revision",
    title: "revise the induction",
    classes: ["unsolved_goals", "tactic_failed", "type_mismatch"],
    applies: (s) => (usesInduction(s) && stuckInStep(s) && !ihUnused(s) ? "an induction proof ends in the step case with goals left" : undefined),
    directive: () =>
      "The induction fails in its step case. Change the induction before changing the step: induct on another variable, use strong induction (Nat.strong_induction_on), " +
      "or revert the hypotheses that mention the variable before `induction` so that the induction hypothesis is general enough.",
  },
  {
    critic: "generalization",
    title: "generalize before the induction",
    classes: ["unsolved_goals", "tactic_failed"],
    applies: (s) => (usesInduction(s) && ihUnused(s) ? "the induction hypothesis is in the goal but does not apply, which is what a constant or a fixed argument does to it" : undefined),
    directive: () =>
      "The induction hypothesis does not match the goal. Generalize: replace the constant or the repeated subterm in the statement by a new variable, " +
      "prove the more general lemma as an `aux_` lemma by induction, and obtain the statement as an instance of it.",
  },
  {
    critic: "lemma_speculation",
    title: "speculate a lemma",
    classes: ["unsolved_goals", "tactic_failed", "unknown_identifier"],
    applies: (s) => {
      if (s.failureClass === "unknown_identifier" && /\b[A-Za-z]+\.[A-Za-z_]+_[A-Za-z_]+/.test(s.detail)) return "a lemma name was guessed and does not exist: the lemma may have to be stated and proved";
      if (!usesInduction(s) && (s.failureClass === "tactic_failed" || s.failureClass === "unsolved_goals") && /[a-z]\w*\s*\(.*\)\s*[=≤<]|=|≤/.test(s.goal ?? "") && !/∨|\bif\b|\bmatch\b/.test(s.goal ?? "")) {
        return "the proof is stuck on an equation or inequality that no automation closes, which is where a missing lemma sits";
      }
      return undefined;
    },
    directive: (s) =>
      s.failureClass === "unknown_identifier"
        ? "The lemma you named does not exist. State what you wanted as an `aux_` lemma and prove it, or find a real one with the search tools; do not guess its name again."
        : "The goal is stuck on a step that no tactic closes. Write the step as a lemma (`aux_...`) with the stuck goal as its statement, prove the main result from it first, and then prove the lemma.",
  },
  {
    critic: "case_split",
    title: "split the cases",
    classes: ["unsolved_goals", "tactic_failed"],
    applies: (s) => (/∨|\bOr\b|\bif\b.*\bthen\b|\bmatch\b|% ?\d|\bEven\b|\bOdd\b|case (inl|inr|pos|neg|isTrue|isFalse)/.test(text(s)) ? "the goal or a hypothesis has a disjunction, a conditional or a parity that a case analysis separates" : undefined),
    directive: () =>
      "Split the cases before the tactic that failed: `rcases` on the disjunction, `by_cases` on the condition, or `Nat.even_or_odd` on the number; prove each case on its own and combine them.",
  },
];

/** For every class of failure, the critics that read it: typed over `FailureClass`, so that a class added to M1 is placed here. */
export const CRITICS_BY_CLASS: Readonly<Record<FailureClass, readonly CriticId[]>> = Object.fromEntries(
  FAILURE_CLASSES.map((c) => [c, REPAIR_TABLE.filter((r) => r.classes.includes(c)).map((r) => r.critic)]),
) as unknown as Record<FailureClass, readonly CriticId[]>;

export interface Suggestion {
  critic: CriticId;
  title: string;
  /** Why it applies. */
  reason: string;
  directive: string;
}

/** The repairs that fit a failure, in the table's order, at most `max`. A class no critic reads gets none. */
export function selectRepairs(situation: Situation, max = 2): Suggestion[] {
  const out: Suggestion[] = [];
  for (const repair of REPAIR_TABLE) {
    if (!repair.classes.includes(situation.failureClass)) continue;
    const reason = repair.applies(situation);
    if (reason !== undefined) out.push({ critic: repair.critic, title: repair.title, reason, directive: repair.directive(situation) });
    if (out.length >= max) break;
  }
  return out;
}
