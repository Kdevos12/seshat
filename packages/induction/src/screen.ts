import { forbiddenTokensIn, maskCommentsAndStrings } from "@seshat/core";
import { signatureProblem } from "@seshat/memory";

/**
 * The strict screen for model text that reaches a Lean file. The statement of a conjecture a model wrote is
 * written, as it is, into reference files and into the files of the checks; a token the validator refuses in a
 * proof (`#eval`, `macro_rules`, `IO`...), a `#` command, or a `--` or `/-` that Lean may read as a comment
 * reaching into the lines after it, must not get there. The text is read with `maskCommentsAndStrings` in its
 * strict form and `forbiddenTokensIn`, as M11 reads a statement (documentation/models.md, "Statements").
 * Returns the reasons the text is refused; empty when it passes.
 */
export function screenLeanText(text: string): string[] {
  const masked = maskCommentsAndStrings(text, { strict: true });
  const reasons: string[] = [];
  const forbidden = forbiddenTokensIn(masked);
  if (forbidden.length > 0) reasons.push(`it holds the token${forbidden.length > 1 ? "s" : ""} ${forbidden.map((t) => `'${t}'`).join(", ")}, which the validator refuses in a proof`);
  if (masked.includes("#")) reasons.push("it holds '#', which starts a Lean command");
  if (masked.includes("--") || masked.includes("/-")) reasons.push("it holds '--' or '/-' where Lean may read a comment that reaches into the lines written after it");
  return reasons;
}

/** Why a statement a model wrote may not become a claim: the strict screen, then the signature form. Undefined when it may. */
export function statementProblem(statement: string): string | undefined {
  if (statement.trim() === "") return "the statement is empty";
  if (statement.length > 4000) return "the statement is longer than 4000 characters";
  const reasons = screenLeanText(statement);
  if (reasons.length > 0) return reasons.join("; ");
  return signatureProblem(statement);
}
