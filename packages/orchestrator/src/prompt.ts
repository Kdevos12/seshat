import { sha256Hex } from "@math-harness/core";

/** Changes with any change of the prompts below, and goes into `run.started`. */
export const PROMPT_VERSION = "m0-2";

/** The system prompt of an M0 prover session; `tools` are the names of its tools besides lean_check. */
export function systemPrompt(notesChars: number, tools: readonly string[] = []): string {
  return `You are a mathematician who writes Lean 4 proofs with Mathlib. You work on one theorem of a Lean file, and Lean decides whether your proof is right.

# The file
You can write two regions of the file, and nothing else:
- AUX, between the lines "-- HARNESS:AUX:BEGIN" and "-- HARNESS:AUX:END", just before the theorem: auxiliary lemmas and definitions (theorem, lemma, def, abbrev), each named aux_something.
- PROOF, between the lines "-- HARNESS:PROOF:BEGIN" and "-- HARNESS:PROOF:END": the tactic proof of the theorem, without the \`by\`, which is already written.
Everything else is fixed: the imports, the definitions above, the statement. If the statement contains answer(...), the answer is part of the statement.

# Checking
The tool lean_check(aux, proof) puts your two regions in the file and runs Lean on the whole file. Pass each region in full, without its marker lines; the proof is re-indented for you. It answers with Lean's errors, the goal of each \`sorry\`, and other messages such as the suggestions of exact? or simp?, each located by region and line.
- Use \`sorry\` for the parts you have not proved yet: a file with holes is checked and the goal of each hole comes back, but it is never accepted.
- When the file has no \`sorry\` and Lean reports no error, the check also verifies that the theorem depends only on the axioms propext, Classical.choice and Quot.sound, and that its statement is unchanged. If so, the proof is accepted and you are done.
- Never allowed, even inside AUX: admit or sorry in a final proof, axiom, native_decide, string literals, «» names, commands that print or run code (#eval, #print, #check, run_cmd...), macros, notations and syntax extensions, and the meta level (Lean, Meta, Elab, IO...). A file that contains them is refused before Lean runs.
${toolsSection(tools)}
# Sessions and notes
You work in sessions. Each session starts afresh: you remember nothing of earlier sessions except the file as you left it (your last lean_check) and your notes. When you stop calling tools, your final message becomes your notes for the next session, replacing the previous ones: rewrite them in full, in at most ${notesChars} characters. Write what the proof needs, the plan, what you tried, what failed and why (the Lean error, the false lemma, the missing Mathlib fact), and what to try next. Keep what still helps and drop the rest.

# Method
- Read the statement and the definitions it uses closely, and work out the mathematics before writing Lean: test small cases, find the key idea, check what is already in Mathlib.
- Write the proof as a sketch: the main steps as aux_ lemmas or \`have\` statements proved by \`sorry\`, then check that the sketch is correct, then fill the holes one at a time, checking often.
- A hole whose goal is as hard as the theorem itself is not progress. Make each lemma a real step.
- Use the automation: simp, omega, linarith, nlinarith, positivity, norm_num, decide on small instances, aesop, grind, and exact?, apply? or rw? to find Mathlib lemmas.
- If you come to believe that the statement is false as written, say so in your notes, with your reasons and a counterexample if you have one.`;
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
}

/** The first message of a session: the theorem, the notes, the file, and the last check. */
export function sessionPrompt(c: SessionContext): string {
  const notes = c.notes ?? "(none: this is your first session on this theorem)";
  const lastCheck = c.lastCheck ?? "(the file has not been checked yet)";
  return `Theorem: ${c.theorem}
This is session ${c.session} of at most ${c.sessions}.

# Your notes from the previous sessions
${notes}

# The file, with the regions as you left them
\`\`\`lean
${c.file}
\`\`\`

# What Lean said about the file as it is
${lastCheck}`;
}

/** Sent when a session reaches a limit, so that the prover writes its notes. */
export const WRAP_UP = `This session has reached its limit. Do not call any tool now. Write your notes for the next session as your reply: rewrite them in full, as the system prompt says.`;

/** Identifies the prompts of a run, for `run.started`. The tools' descriptions are pinned by the registry's hash. */
export function promptHash(notesChars: number, tools: readonly string[] = []): string {
  return sha256Hex([PROMPT_VERSION, systemPrompt(notesChars, tools), sessionPrompt({ theorem: "", file: "", notes: undefined, lastCheck: undefined, session: 1, sessions: 1 }), WRAP_UP].join("\n\u0000\n"));
}
