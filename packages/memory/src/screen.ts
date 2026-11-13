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

/** The most characters of a person's sketch (`harness solve --sketch FILE`, documentation/human.md, "A person's sketch"). */
export const MAX_SKETCH_CHARS = 20_000;

/**
 * Control characters, bidirectional marks and zero-width characters, which fetched or foreign text may hide in: the class the literature's text hygiene
 * removes (`@seshat/lit`, `clean`), without the tab, the line feed and the carriage return, which a sketch keeps.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * The screen of a person's sketch before it enters a prompt: the hygiene the literature's text gets (`clean`: invisible characters go, and a run of three
 * `<` or `>` becomes two, so that the text cannot forge the delimiters a prompt uses), with its lines kept, since an informal proof has them. It is not
 * the strict screen of `screenProse`: a sketch is the person's own words, and mathematics has `$`, `:=` and underscores. What it protects is the prompt's
 * structure; what the model does with the text is for Lean to check. The result is trimmed, with at most one empty line in a row.
 */
export function screenSketch(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/<{3,}/g, "<<")
    .replace(/>{3,}/g, ">>")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A person's sketch read from the `hint` nodes of a claim (`data.sketch === true`): the newest, with its author, or undefined. */
export function sketchOfNodes(nodes: ReadonlyArray<{ data: unknown }>): { by: string; text: string } | undefined {
  for (const node of [...nodes].reverse()) {
    const data = node.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const d = data as Record<string, unknown>;
    if (d.sketch === true && d.provenance === "human" && typeof d.by === "string" && typeof d.text === "string") return { by: d.by, text: d.text };
  }
  return undefined;
}

/** The sketch as prompt text, quoted line by line so that it reads as data and cannot pass for the prompt's own sections. */
export function quotedSketch(text: string): string {
  return screenSketch(text).split("\n").map((line) => `> ${line}`.replace(/\s+$/, "")).join("\n");
}
