import { maskCommentsAndStrings } from "@seshat/core";
import { ANTI_SYCOPHANCY } from "@seshat/lines";

/**
 * The category of a problem as formal-conjectures writes it in the theorem's attributes
 * (`@[category research open, AMS 11]`), read from the theorem's header; undefined when it has none.
 */
export function categoryOf(header: string): string | undefined {
  const match = /\bcategory\s+([A-Za-z_ ]+?)\s*[,\]]/.exec(maskCommentsAndStrings(header));
  return match?.[1]?.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether the harness takes a statement for an open conjecture: its category says `open`, or it has
 * none. A category that says the statement is a known result (`research solved`, `textbook`, `test`...)
 * is not open. The default is the cautious one: nothing says the statement is true.
 */
export function isOpenConjecture(category: string | undefined): boolean {
  return category === undefined || /\bopen\b/.test(category);
}

/**
 * The question a prover is asked about a statement (plan §9, neutral framing): to determine whether
 * it holds, never to prove it. A prover told to prove a false statement proves it in 29% of the cases
 * (BrokenMath), so an open conjecture is never put as a thing to demonstrate. `known` is for a
 * statement from a list of solved problems, which a formalization can still get wrong. The question
 * about an open conjecture ends with the fixed anti-sycophancy instruction (plan change PC10), the one
 * every prompt that judges or reranks carries too (`ANTI_SYCOPHANCY` of `@seshat/lines`).
 */
export function neutralQuestion(options: { known?: boolean } = {}): string {
  if (options.known === true) {
    return (
      "Determine whether this theorem holds as formalized. It comes from a solved problem, so a proof is expected, " +
      "but a formalization can be wrong. lean_check accepts only a proof of the statement as written; if it is false " +
      "as written, say so in your notes, with the witness."
    );
  }
  return (
    "Determine whether this theorem holds. It is an open conjecture: it may be true, or false as formalized, and nothing " +
    "here says which. Look for a proof and for a counterexample with equal care. lean_check accepts only a proof of the " +
    "statement as written; if you find a counterexample, or come to believe the statement is false, say so in your notes, " +
    `with the witness. ${ANTI_SYCOPHANCY}`
  );
}

/** Wordings that put a statement as a thing to demonstrate, by the phrase they are reported as. */
const NON_NEUTRAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:prove|show|demonstrate|establish)\s+that\b/i, "prove that"],
  [/\b(?:prove|show|demonstrate|establish)\s+(?:the|this|our|that)\s+(?:theorem|statement|conjecture|claim|result)\b/i, "prove the statement"],
  [/\byour\s+(?:task|goal|job|aim)\s+is\s+to\s+(?:prove|show|demonstrate|establish)\b/i, "your task is to prove"],
  [/\bhelps?\s+(?:you\s+)?(?:to\s+)?prove\b/i, "help you prove"],
];

/**
 * The non-neutral wordings in a text that is about an open conjecture: a list of the phrases found
 * (from a fixed list, never a piece of the text), empty when the text asks to determine, not to prove.
 */
export function framingProblems(text: string): string[] {
  return NON_NEUTRAL.filter(([pattern]) => pattern.test(text)).map(([, phrase]) => phrase);
}
