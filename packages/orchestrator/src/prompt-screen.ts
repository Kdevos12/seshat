import { forbiddenTokensIn, maskCommentsAndStrings } from "@seshat/core";
import { PROVER_SYSTEM_FILE, PROVER_SYSTEM_TEMPLATE, PROVER_VERSION_FILE } from "./prompt.ts";

/**
 * A prompt the harness may optimize (documentation/prompts.md). Every target is a text file under a `prompts` directory of a package,
 * with the placeholders the program fills in and the phrases a rewrite must keep: the ones that tie the prompt to the trust rules and to
 * the file format, which a rewrite is not allowed to drop (DGM, whose agent removed its own hallucination markers, is why).
 */
export interface PromptTarget {
  id: string;
  /** The file, from the repository root, that a person merges a patch into. */
  file: string;
  /** The file that records the prompt's version and the hash of its text, which a merge bumps. */
  versionFile: string;
  /** The merged text. */
  current: string;
  /** Placeholders the text must hold, each exactly once. */
  placeholders: readonly string[];
  /** Phrases the text must keep. */
  anchors: readonly string[];
}

export const PROMPT_TARGETS: readonly PromptTarget[] = [
  {
    id: "prover.system",
    file: PROVER_SYSTEM_FILE,
    versionFile: PROVER_VERSION_FILE,
    current: PROVER_SYSTEM_TEMPLATE,
    placeholders: ["{{NOTES_CHARS}}", "{{TOOLS_SECTION}}"],
    anchors: ["lean_check", "-- HARNESS:AUX:BEGIN", "-- HARNESS:AUX:END", "-- HARNESS:PROOF:BEGIN", "-- HARNESS:PROOF:END", "Lean decides", "Never allowed", "sorry"],
  },
];

export function promptTarget(id: string, targets: readonly PromptTarget[] = PROMPT_TARGETS): PromptTarget {
  const target = targets.find((t) => t.id === id);
  if (target === undefined) throw new Error(`no prompt target ${JSON.stringify(id)}; the targets are ${targets.map((t) => t.id).join(", ")}`);
  return target;
}

/** Where a prompt file may be: a `prompts` directory of a package. Nothing else of the repository is a prompt. */
const PROMPT_FILE = /^packages\/[a-z0-9-]+\/prompts\/[A-Za-z0-9._-]+\.txt$/;
const VERSION_FILE = /^packages\/[a-z0-9-]+\/prompts\/[A-Za-z0-9._-]+\.version\.json$/;

/** Why a target is not one an optimization may propose changes to: its file is not a prompt file. Empty when it is. */
export function targetProblems(target: PromptTarget): string[] {
  const problems: string[] = [];
  if (!PROMPT_FILE.test(target.file)) problems.push(`${target.id}: ${target.file} is not a prompt file (packages/NAME/prompts/FILE.txt): the optimization proposes changes to prompt files and to nothing else`);
  if (!VERSION_FILE.test(target.versionFile)) problems.push(`${target.id}: ${target.versionFile} is not a prompt version record (packages/NAME/prompts/FILE.version.json)`);
  return problems;
}

/**
 * Phrases that weaken the trust rules: an instruction to skip Lean, to override, to claim a result, to count a failure as success, or to
 * stop on the model's own judgement. A blacklist, not a proof: it catches the wordings a review has found, and a new wording gets past it.
 * The real gate is the human read of the patch (documentation/prompts.md). It applies to the lines a candidate adds to the merged prompt.
 */
const WEAKENING: Array<[RegExp, string]> = [
  [/\b(?:ignore|disregard|override|forget)\b/i, "it tells the model to ignore or override something"],
  [/\b(?:skip|avoid|bypass|without)\s+(?:the\s+)?(?:lean|lean_check|checking|check)\b/i, "it tells the model to skip the Lean check"],
  [/\bdo not (?:call|use|run)\s+lean_check\b/i, "it tells the model not to call lean_check"],
  [/\b(?:claim|declare|report|state|say|write|announce|conclude)\b[^.\n]{0,50}\b(?:proved|proven|accepted|verified|solved|done|correct)\b/i, "it tells the model to state a result"],
  [/\b(?:treat|count|consider|take)\b[^.\n]{0,50}\b(?:as|for)\s+(?:a\s+)?(?:success|successful|proved|proven|accepted|valid|done)\b/i, "it tells the model to count something as a success"],
  [/\b(?:finish|stop|conclude|submit|answer|decide)\b[^.\n]{0,50}\b(?:own|your)\s+(?:judge?ment|belief|opinion|confidence|assessment|sense)\b/i, "it tells the model to stop on its own judgement"],
  [/\b(?:own|your)\s+(?:judge?ment|assessment)\s+(?:over|instead of|rather than|replaces?)\b/i, "it puts the model's judgement over Lean's"],
  [/\b(?:trust|rely on) (?:your|the model's) own (?:judge?ment|reasoning) over lean\b/i, "it puts the model's judgment over Lean's"],
  [/\bsystem prompt\b|\bprevious instructions?\b/i, "it speaks of the system prompt or of previous instructions"],
];

const REFUSAL_WORDS = /\b(?:never|not|no|n't|refused|forbidden|disallowed|avoid|without|except|cannot|must)\b/i;

/** The lines of a text that the merged prompt does not hold as they are. */
function addedLines(text: string, merged: string): string[] {
  const had = new Set(merged.split("\n").map((l) => l.trim()));
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !had.has(l));
}

/** Characters that show nothing or change how text reads: control, format, line and paragraph separators, private use, unassigned and tag characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]|[\u00ad\u061c\u180e\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

/** The characters of a text that a person reading it would not see as written, or that the merged prompt does not already hold. */
function strayCharacters(text: string, merged: string): string[] {
  const known = new Set(merged);
  const stray = new Set<string>();
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") continue;
    const code = ch.codePointAt(0) as number;
    if (INVISIBLE.test(ch)) stray.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
    else if (code > 126 && !known.has(ch)) stray.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")} (${ch})`);
  }
  return [...stray];
}

/**
 * The strict screen of a rewritten prompt (Global Constraint 16): the text is model-derived and reaches a prover, so it passes before it
 * is measured and again before it is written. No control, zero-width or bidirectional character; no link or address; no Lean token the
 * validator forbids that the merged prompt does not already name (the merged one lists them to say they are refused); no instruction to
 * skip or override a check; the placeholders each once and no other; the anchors kept; a length within half to one and a half times the
 * merged prompt (a longer prompt is a larger bill, so the budget would no longer be equal). Returns the reasons it is refused; empty when it passes.
 */
export function screenPrompt(text: string, target: PromptTarget): string[] {
  const reasons: string[] = [];
  if (text.trim() === "") return ["it is empty"];
  const stray = strayCharacters(text, target.current);
  if (stray.length > 0) reasons.push(`it holds characters that are invisible or that the merged prompt does not use (${stray.slice(0, 6).join(", ")}${stray.length > 6 ? ", ..." : ""}): control, format, zero-width, bidirectional, tag, variation-selector and separator characters are refused, and so is any non-ASCII character the merged prompt lacks`);
  if (/https?:|www\.|\w@\w/i.test(text)) reasons.push("it holds a link or an address");
  const known = new Set(forbiddenTokensIn(maskCommentsAndStrings(target.current)));
  const novel = forbiddenTokensIn(maskCommentsAndStrings(text)).filter((t) => !known.has(t));
  if (novel.length > 0) reasons.push(`it names the Lean token${novel.length > 1 ? "s" : ""} ${novel.map((t) => `'${t}'`).join(", ")}, which the validator refuses and the merged prompt does not name`);
  const added = addedLines(text, target.current);
  const addedText = added.join("\n");
  for (const [pattern, why] of WEAKENING) if (pattern.test(addedText)) reasons.push(why);
  // A line the rewrite adds that names a token the validator refuses (the merged prompt names them to say they are refused) must say it is refused.
  for (const line of added) {
    const tokens = forbiddenTokensIn(maskCommentsAndStrings(line)).filter((t) => t.includes("_") || t.startsWith("#") || ["axiom", "admit", "unsafe"].includes(t));
    if (tokens.length > 0 && !REFUSAL_WORDS.test(line)) reasons.push(`it names ${tokens.map((t) => `'${t}'`).join(", ")} without saying it is refused: "${line.slice(0, 80)}"`);
  }
  for (const placeholder of target.placeholders) {
    const n = text.split(placeholder).length - 1;
    if (n !== 1) reasons.push(`the placeholder ${placeholder} must appear exactly once, it appears ${n} times`);
  }
  const unknown = [...text.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]).filter((p) => !target.placeholders.includes(p));
  if (unknown.length > 0) reasons.push(`unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  const missing = target.anchors.filter((a) => !text.includes(a));
  if (missing.length > 0) reasons.push(`it drops ${missing.map((a) => JSON.stringify(a)).join(", ")}, which a rewrite must keep`);
  if (text.length > target.current.length * 1.5) reasons.push(`it is ${text.length} characters, more than one and a half times the merged prompt's ${target.current.length}`);
  if (text.length < target.current.length * 0.5) reasons.push(`it is ${text.length} characters, less than half the merged prompt's ${target.current.length}`);
  return reasons;
}
