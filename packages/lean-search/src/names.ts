/**
 * What a declaration name may be. A name that a backend returns goes into a Lean file (`#check NAME`) before it is shown, so
 * the shape is checked first: one token, no whitespace, no quote, no comment marker, no command. A name that is not of this shape is
 * dropped, whatever the backend says.
 */
const NAME = /^[\p{L}_][\p{L}\p{N}_'!?.₀-₉«»]*$/u;

/** The longest name kept. */
export const MAX_NAME_CHARS = 200;

export function isDeclarationName(text: unknown): text is string {
  return typeof text === "string" && text.length > 0 && text.length <= MAX_NAME_CHARS && NAME.test(text) && !text.includes("..") && !text.endsWith(".");
}

/** A declaration as a backend gives it. `type` and `doc` are the backend's text: they rank, and are never shown. */
export interface Declaration {
  name: string;
  type?: string;
  doc?: string;
}
