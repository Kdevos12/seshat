import { leanTextProblems } from "@seshat/core";
import { signatureProblem } from "@seshat/memory";

/** The strict screen of `@seshat/core` (`leanTextProblems`), the one copy. */
export const screenLeanText = leanTextProblems;

/** Why a statement a model wrote may not become a claim: the strict screen, then the signature form. Undefined when it may. */
export function statementProblem(statement: string): string | undefined {
  if (statement.trim() === "") return "the statement is empty";
  if (statement.length > 4000) return "the statement is longer than 4000 characters";
  const reasons = screenLeanText(statement);
  if (reasons.length > 0) return reasons.join("; ");
  return signatureProblem(statement);
}
