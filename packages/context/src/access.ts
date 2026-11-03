import type { Entry } from "@seshat/library";

/** The use a premise suggests (PC5 item 1c): applied or given to `exact`, rewritten with, simplified with, or a definition to unfold. */
export type Use = "apply" | "rw" | "simp" | "definition";

/** The conclusion of a signature: what follows its last colon outside brackets. */
export function conclusionOf(signature: string): string {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < signature.length; i++) {
    const c = signature[i] as string;
    if ("([{⟨⦃".includes(c)) depth++;
    else if (")]}⟩⦄".includes(c)) depth--;
    else if (depth === 0 && c === ":" && signature[i + 1] !== "=") at = i;
  }
  return (at < 0 ? signature : signature.slice(at + 1)).trim();
}

/** How a premise is used, from its conclusion: an equation or an equivalence is rewritten with, anything else is applied. A flagged `simp` lemma or a `def` keeps its flag. */
export function useOf(entry: Entry, flags: { kind?: string; simp?: boolean } = {}): Use {
  if (flags.kind !== undefined && ["def", "abbrev", "structure", "class", "inductive", "instance"].includes(flags.kind)) return "definition";
  if (flags.simp === true) return "simp";
  return /(?<![<>≠≤≥:!=])=(?![=>])|↔/.test(conclusionOf(entry.signature)) ? "rw" : "apply";
}

/**
 * The accessibility filter (LeanDojo; PC5 item 1b): a premise the problem's file cannot see is not offered. A declaration of the
 * file itself and a library lemma (it travels as pasted text) are always visible. Another is visible when its module, or its package
 * for want of a module, is one the header imports or one the base environment always has (`assumed`: the bench's header pulls
 * Mathlib in, so `Mathlib` by default). A module is covered by an import of itself or of a prefix of it (`Mathlib` covers
 * `Mathlib.Algebra.Group`). The import graph is not read, so the filter is conservative about a module that a narrower import
 * pulls in transitively: such a premise is withheld.
 */
export function accessible(entry: Entry, header: string, assumed: readonly string[]): boolean {
  if (entry.source === "local" || entry.source === "library") return true;
  const roots = [...header.matchAll(/^\s*import\s+(\S+)/gm)].map((m) => m[1] as string).concat(assumed);
  const covered = (module: string) => roots.some((r) => module === r || module.startsWith(`${r}.`));
  if (entry.module !== undefined) return covered(entry.module);
  // Without a module, a Mathlib declaration is visible when Mathlib is (an import of a Mathlib module is not enough to say), a package's when its name is imported.
  if (entry.source === "mathlib") return roots.includes("Mathlib");
  return roots.some((r) => r === entry.label || r.startsWith(`${entry.label}.`));
}

/** Whether the header already imports `module`: an import of it, or of a prefix of it (`import Mathlib` covers every Mathlib module). */
export function imports(header: string, module: string): boolean {
  return [...header.matchAll(/^\s*import\s+(\S+)/gm)].some((m) => module === m[1] || module.startsWith(`${m[1]}.`));
}
