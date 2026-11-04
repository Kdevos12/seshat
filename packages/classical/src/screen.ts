import { leanTextProblems } from "@seshat/core";

export { leanTextProblems };

/** Thrown when text a model wrote fails the strict screen of `@seshat/core` (`leanTextProblems`, the one copy). */
export class UnsafeText extends Error {}

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
