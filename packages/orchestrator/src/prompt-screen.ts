import { forbiddenTokensIn, maskCommentsAndStrings } from "@seshat/core";
import { PROVER_SYSTEM_FILE, PROVER_SYSTEM_TEMPLATE } from "./prompt.ts";

/**
 * A prompt the harness may optimize (documentation/prompts.md). Every target is a text file under a `prompts` directory of a package,
 * with the placeholders the program fills in and the phrases a rewrite must keep: the ones that tie the prompt to the trust rules and to
 * the file format, which a rewrite is not allowed to drop (DGM, whose agent removed its own hallucination markers, is why).
 */
export interface PromptTarget {
  id: string;
  /** The file, from the repository root, that a person merges a patch into. */
  file: string;
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

/** Why a target is not one an optimization may propose changes to: its file is not a prompt file. Empty when it is. */
export function targetProblems(target: PromptTarget): string[] {
  return PROMPT_FILE.test(target.file) ? [] : [`${target.id}: ${target.file} is not a prompt file (packages/NAME/prompts/FILE.txt): the optimization proposes changes to prompt files and to nothing else`];
}

/** The model-derived text is never an instruction to weaken a check, to skip Lean, or to claim a result without it. */
const WEAKENING: Array<[RegExp, string]> = [
  [/\b(?:ignore|disregard|override|forget)\b/i, "it tells the model to ignore or override something"],
  [/\b(?:skip|avoid|bypass|without)\s+(?:the\s+)?(?:lean|lean_check|checking|check)\b/i, "it tells the model to skip the Lean check"],
  [/\bdo not (?:call|use|run)\s+lean_check\b/i, "it tells the model not to call lean_check"],
  [/\b(?:claim|declare|report|state|say)\b[^.\n]{0,40}\b(?:proved|accepted|verified|solved|done)\b[^.\n]{0,30}\b(?:without|before|even if)\b/i, "it tells the model to claim a result without Lean"],
  [/\b(?:trust|rely on) (?:your|the model's) own (?:judgment|reasoning) over lean\b/i, "it puts the model's judgment over Lean's"],
  [/\bsystem prompt\b|\bprevious instructions?\b/i, "it speaks of the system prompt or of previous instructions"],
];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]|[​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;

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
  if (CONTROL.test(text)) reasons.push("it holds control, zero-width or bidirectional characters");
  if (/https?:|www\.|\w@\w/i.test(text)) reasons.push("it holds a link or an address");
  const known = new Set(forbiddenTokensIn(maskCommentsAndStrings(target.current)));
  const novel = forbiddenTokensIn(maskCommentsAndStrings(text)).filter((t) => !known.has(t));
  if (novel.length > 0) reasons.push(`it names the Lean token${novel.length > 1 ? "s" : ""} ${novel.map((t) => `'${t}'`).join(", ")}, which the validator refuses and the merged prompt does not name`);
  for (const [pattern, why] of WEAKENING) if (pattern.test(text) && !pattern.test(target.current)) reasons.push(why);
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
