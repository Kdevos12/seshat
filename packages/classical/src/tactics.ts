import type { LeanCheckResult } from "@seshat/core";

/**
 * The battery's tactics. Each is a Lean tactic that closes a goal on its own, tried as
 * `example : goal := by <tactic>`. A tactic that needs a package the host's Lean may lack is offered
 * only when the host has it ({@link TacticSpec.needs}); the list is read from the host, never assumed.
 */
export interface TacticSpec {
  /** The tactic's name, which the posteriors and the briefing use. */
  name: string;
  /** The tactic script (one line, or several joined by newlines). */
  script: string;
  /** What kind of procedure it is, for the documentation and the cost order. */
  kind: "decision" | "normalizer" | "search" | "library" | "hammer";
  /** Seconds one try may take. */
  timeoutSec: number;
  /** The package or command the host's Lean must have; absent: Lean core or Mathlib. */
  needs?: "canonical" | "hammer" | "polyrith" | "bv_decide";
  /** The tactic prints its proof as `Try this: ...`; that suggestion, not the search tactic, is what is submitted. */
  suggests?: boolean;
  /** The first-try cost class, cheapest first. */
  cost: 1 | 2 | 3;
}

export const TACTICS: readonly TacticSpec[] = [
  { name: "decide", script: "decide", kind: "decision", timeoutSec: 10, cost: 1 },
  { name: "omega", script: "omega", kind: "decision", timeoutSec: 10, cost: 1 },
  { name: "norm_num", script: "norm_num", kind: "normalizer", timeoutSec: 10, cost: 1 },
  { name: "simp", script: "simp", kind: "normalizer", timeoutSec: 10, cost: 1 },
  { name: "ring", script: "ring", kind: "normalizer", timeoutSec: 10, cost: 1 },
  { name: "linarith", script: "linarith", kind: "decision", timeoutSec: 15, cost: 1 },
  { name: "positivity", script: "positivity", kind: "decision", timeoutSec: 10, cost: 1 },
  { name: "nlinarith", script: "nlinarith", kind: "decision", timeoutSec: 20, cost: 2 },
  { name: "aesop", script: "aesop", kind: "search", timeoutSec: 20, cost: 2 },
  { name: "grind", script: "grind", kind: "search", timeoutSec: 20, cost: 2 },
  { name: "exact?", script: "exact?", kind: "library", timeoutSec: 30, suggests: true, cost: 2 },
  { name: "bv_decide", script: "bv_decide", kind: "decision", timeoutSec: 20, needs: "bv_decide", cost: 2 },
  { name: "polyrith", script: "polyrith", kind: "decision", timeoutSec: 30, needs: "polyrith", suggests: true, cost: 3 },
  { name: "canonical", script: "canonical", kind: "search", timeoutSec: 30, needs: "canonical", cost: 3 },
  { name: "hammer", script: "hammer", kind: "hammer", timeoutSec: 60, needs: "hammer", suggests: true, cost: 3 },
];

export const TACTIC_BY_NAME: ReadonlyMap<string, TacticSpec> = new Map(TACTICS.map((t) => [t.name, t]));

/** What the host's Lean has, as far as the battery needs to know. */
export interface HostTactics {
  /** The `needs` values the host's Lean provides. */
  have: ReadonlySet<string>;
}

export const NO_EXTRA_TACTICS: HostTactics = { have: new Set() };

/** The tactics the host offers: those that need nothing, and those whose `needs` the host has. */
export function availableTactics(host: HostTactics, only?: readonly string[]): TacticSpec[] {
  return TACTICS.filter((t) => (t.needs === undefined || host.have.has(t.needs)) && (only === undefined || only.includes(t.name)));
}

/** A variant of the hammer at a premise cutoff (plan change PC6 item 2): `hammer@64`. */
export function hammerAt(cutoff: number): TacticSpec {
  return {
    name: `hammer@${cutoff}`,
    script: `hammer {aesopPremises := ${cutoff}, autoPremises := ${cutoff}}`,
    kind: "hammer",
    timeoutSec: 60,
    needs: "hammer",
    suggests: true,
    cost: 3,
  };
}

/** The goal of a try: a statement in signature form read after `header`. */
export interface Goal {
  /** The header: imports, `open`s, namespaces and definitions the statement needs. */
  header: string;
  /** The statement in signature form: the binders, then `:` and the type. */
  statement: string;
}

/** The Lean file that tries `script` on a goal: `example <statement> := by <script>`. */
export function snippetFor(goal: Goal, script: string): string {
  const indented = script
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  const header = goal.header.trimEnd();
  return `${header === "" ? "" : `${header}\n\n`}example ${goal.statement.trim()} := by\n${indented}\n`;
}

/** The file that probes whether a tactic exists: its parse is all that matters. */
export function probeSnippet(header: string, script: string): string {
  const h = header.trimEnd();
  return `${h === "" ? "import Mathlib" : h}\n\nexample : (0 : Nat) = 0 := by\n  ${script}\n`;
}

/** Whether a probe's messages say that the tactic's syntax is unknown to this Lean. */
export function isUnknownTactic(result: LeanCheckResult): boolean {
  return result.messages.some((m) => m.severity === "error" && /unknown tactic|unknown identifier|unknown constant|<input>:\d+:\d+: expected|unexpected (token|identifier)|expected '|expected tactic/iu.test(m.text));
}

/** A success: Lean accepted the file without an error or a `sorry`. */
export function succeeded(result: LeanCheckResult): boolean {
  return result.status === "valid" && !result.messages.some((m) => m.severity === "error");
}

/** The tactic text after `Try this:` in a message, if the tactic suggested one. */
export function suggestion(result: LeanCheckResult): string | undefined {
  for (const m of result.messages) {
    if (m.severity !== "info" && m.severity !== "warning") continue;
    const at = m.text.indexOf("Try this:");
    if (at < 0) continue;
    const text = m.text.slice(at + "Try this:".length).trim();
    if (text !== "") return text;
  }
  return undefined;
}
