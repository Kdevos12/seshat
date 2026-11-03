import { forbiddenTokensIn, maskCommentsAndStrings } from "@seshat/core";

/**
 * The strict screen for text that a model wrote or chose and that reaches a Lean file or a Pantograph
 * goal: a statement, a header, a tactic, a lemma name, a premise name. The same reading as
 * `screenLeanText` of `@seshat/induction` (which depends on this package, so it cannot be imported):
 * comments and strings masked in the strict form, then `forbiddenTokensIn` (`#eval`, `macro_rules`, `IO`...),
 * no `#`, no `--` or `/-` that Lean may read as a comment reaching into the lines after the text.
 */
export class UnsafeText extends Error {}

/** Why a text may not reach Lean; empty when it may. */
export function leanTextProblems(text: string): string[] {
  const masked = maskCommentsAndStrings(text, { strict: true });
  const reasons: string[] = [];
  const forbidden = forbiddenTokensIn(masked);
  if (forbidden.length > 0) reasons.push(`it holds the token${forbidden.length > 1 ? "s" : ""} ${forbidden.map((t) => `'${t}'`).join(", ")}, which the validator refuses in a proof`);
  if (masked.includes("#")) reasons.push("it holds '#', which starts a Lean command");
  // The strict mask hides a comment; the raw text must hold none, since `-- x` swallows what the harness writes after the text on its line.
  if (text.includes("--") || text.includes("/-") || masked.includes("--") || masked.includes("/-")) reasons.push("it holds '--' or '/-' where Lean may read a comment that reaches into the lines written after it");
  return reasons;
}

/** Why a header a model chose may not open a Lean file: the screen of the text without its `import` lines. */
export function headerProblems(header: string): string[] {
  return leanTextProblems(header.replace(/^[ \t]*import[ \t]+[\w.]+[ \t]*$/gmu, ""));
}

/** Throws `UnsafeText` naming `what` when the text fails the screen. */
export function assertLeanSafe(text: string, what: string): void {
  const reasons = leanTextProblems(text);
  if (reasons.length > 0) throw new UnsafeText(`${what} is refused: ${reasons.join("; ")}`);
}

/** Throws `UnsafeText` naming `what` when a header fails the header screen. */
export function assertHeaderSafe(header: string, what: string): void {
  const reasons = headerProblems(header);
  if (reasons.length > 0) throw new UnsafeText(`${what} is refused: ${reasons.join("; ")}`);
}

/** A tactic or a lemma term a model proposes: one line, and the screen. */
export function assertOneLine(text: string, what: string): void {
  if (/[\r\n]/u.test(text)) throw new UnsafeText(`${what} is refused: it has more than one line`);
  assertLeanSafe(text, what);
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_'!?₀-₉]*(?:\.[\p{L}_][\p{L}\p{N}_'!?₀-₉]*)*$/u;

/** Whether a premise name is a Lean identifier, with nothing else that could be read as syntax. */
export const isIdentifier = (name: string): boolean => IDENTIFIER.test(name) && name.length <= 200;
