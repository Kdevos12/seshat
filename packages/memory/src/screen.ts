import { forbiddenTokensIn } from "@seshat/core";

/**
 * The strict screen for prose that a mechanism stores and later shows to a prover (a lemma's gloss, a lesson's text):
 * text a model or a Lean message wrote is unverified, so it must not carry code, a Lean token the validator forbids,
 * a link, something that looks like a lemma name, or an instruction (Global Constraint 16). It returns the text made
 * of one line and cut to `max` characters at a word, or the reason it was refused.
 */
export type Screened = { ok: true; text: string } | { ok: false; reason: string };

const INSTRUCTION = /\b(?:ignore|disregard|override|forget)\b|\bprevious instructions?\b|\bsystem prompt\b|\bsubmit (?:this|it)\b|\balready proved\b/i;

export function screenProse(raw: string, options: { max: number }): Screened {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return { ok: false, reason: "it is empty" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "it holds control characters" };
  if (/https?:|www\.|\w@\w/i.test(text)) return { ok: false, reason: "it holds a link or an address" };
  if (/[`$\\{}[\]<>|]|--|\/-|-\/|:=|#\w/.test(text)) return { ok: false, reason: "it holds code" };
  if (forbiddenTokensIn(text).length > 0) return { ok: false, reason: `it holds a Lean token the validator forbids (${forbiddenTokensIn(text).join(", ")})` };
  if (/[A-Za-z0-9]_[A-Za-z0-9]/.test(text) || /\b[A-Za-z][A-Za-z0-9]*\.[A-Za-z_][A-Za-z0-9_.']*/.test(text)) return { ok: false, reason: "it names a declaration" };
  if (INSTRUCTION.test(text)) return { ok: false, reason: "it reads as an instruction" };
  if (text.length <= options.max) return { ok: true, text };
  const cut = text.slice(0, options.max - 1);
  const word = cut.lastIndexOf(" ");
  return { ok: true, text: `${(word > options.max / 2 ? cut.slice(0, word) : cut).replace(/[ ,;:.]+$/, "")}…` };
}
