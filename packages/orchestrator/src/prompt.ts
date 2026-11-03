import { readFileSync } from "node:fs";
import { sha256Hex } from "@seshat/core";

/** Changes with any change of the prompts below, and goes into `run.started`. */
export const PROMPT_VERSION = "m0-2.1";

/**
 * The text of the prover's system prompt, with two placeholders: `{{NOTES_CHARS}}` and `{{TOOLS_SECTION}}`. It lives in a file, so that
 * `harness optimize-prompts` can propose a rewrite as a patch that a person reviews and merges (documentation/prompts.md).
 */
export const PROVER_SYSTEM_FILE = "packages/orchestrator/prompts/prover.system.txt";
export const PROVER_SYSTEM_TEMPLATE = readFileSync(new URL("../prompts/prover.system.txt", import.meta.url), "utf8").replace(/\n$/, "");

/**
 * The system prompt of an M0 prover session; `tools` are the names of its tools besides lean_check. `template` replaces the prompt's
 * text for a measurement run of a candidate (`RunConfig.prompts`); the default is the merged prompt.
 */
export function systemPrompt(notesChars: number, tools: readonly string[] = [], template: string = PROVER_SYSTEM_TEMPLATE): string {
  return template.replace("{{NOTES_CHARS}}", () => String(notesChars)).replace("{{TOOLS_SECTION}}", () => toolsSection(tools));
}

/** The section of the system prompt on the tools besides lean_check; empty without them. */
function toolsSection(tools: readonly string[]): string {
  if (tools.length === 0) return "";
  return `
# Other tools
Besides lean_check you have: ${tools.join(", ")}. Each tool's description says what it does. What these tools return is evidence, not proof: only lean_check decides. Use them to test small cases, compute examples and search for counterexamples before you write Lean, and to find the values and witnesses a proof needs.
`;
}

export interface SessionContext {
  /** Full name of the theorem. */
  theorem: string;
  /** The file, with the regions as the prover left them. */
  file: string;
  /** Notes of the previous session, if any. */
  notes: string | undefined;
  /** What Lean said about the file as it is, if it was checked. */
  lastCheck: string | undefined;
  session: number;
  sessions: number;
  /** The enabled lines' briefings, each a titled section after the last check. */
  sections?: ReadonlyArray<{ title: string; text: string }>;
}

/** The first message of a session: the theorem, the notes, the file, the last check, and the lines' sections. */
export function sessionPrompt(c: SessionContext): string {
  const notes = c.notes ?? "(none: this is your first session on this theorem)";
  const lastCheck = c.lastCheck ?? "(the file has not been checked yet)";
  const sections = (c.sections ?? []).map((section) => `\n\n# ${section.title}\n${section.text}`).join("");
  return `Theorem: ${c.theorem}
This is session ${c.session} of at most ${c.sessions}.

# Your notes from the previous sessions
${notes}

# The file, with the regions as you left them
\`\`\`lean
${c.file}
\`\`\`

# What Lean said about the file as it is
${lastCheck}${sections}`;
}

/** Sent when a session reaches a limit, so that the prover writes its notes. */
export const WRAP_UP = `This session has reached its limit. Do not call any tool now. Write your notes for the next session as your reply: rewrite them in full, as the system prompt says.`;

/** Identifies the prompts of a run, for `run.started`. The tools' descriptions are pinned by the registry's hash. */
export function promptHash(notesChars: number, tools: readonly string[] = [], template: string = PROVER_SYSTEM_TEMPLATE): string {
  return sha256Hex([PROMPT_VERSION, systemPrompt(notesChars, tools, template), sessionPrompt({ theorem: "", file: "", notes: undefined, lastCheck: undefined, session: 1, sessions: 1 }), WRAP_UP].join("\n\u0000\n"));
}
