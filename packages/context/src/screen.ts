import { forbiddenTokensIn } from "@seshat/core";

/**
 * The strict screen for a line of Lean or typed text that was derived from model output or from another run (a statement
 * of a claim a line stated, a library lemma's signature, a declaration of the environment's export, a typed failure detail)
 * before it goes into a packet (Global Constraint 16). Prose goes through `screenProse` of `@seshat/memory` instead.
 *
 * The text is collapsed to one line and cut to `max` characters. It is refused (undefined) when it holds a control character,
 * a link or address, a Lean comment, a Lean token the validator forbids, or reads as an instruction.
 */
const INSTRUCTION = /\b(?:ignore|disregard|override|forget)\s+(?:all|the|any|your|previous)\b|\bprevious instructions?\b|\bsystem prompt\b|\bsubmit (?:this|it)\b/i;

export function screenLean(raw: string, max: number): string | undefined {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return undefined;
  if (/https?:|www\.|\w@\w/i.test(text)) return undefined;
  if (/--|\/-|-\/|\/\*/.test(text)) return undefined;
  if (forbiddenTokensIn(text).length > 0) return undefined;
  if (INSTRUCTION.test(text)) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const IDENT = /^[\p{L}\p{N}_.'!?«»]+$/u;
const MODULE = /^[\p{L}\p{N}_.]+$/u;
/** A name or label that comes from an export or a library: only identifier characters pass; anything else is not echoed. */
export const ident = (text: string | undefined): string => (text !== undefined && text.length <= 200 && IDENT.test(text) ? text : "(name not shown)");
export const moduleName = (text: string | undefined): string => (text !== undefined && text.length <= 200 && MODULE.test(text) ? text : "(module not shown)");
