import { tokenize } from "@seshat/library";

/**
 * The names a statement binds: in binders `(a b : T)`, `{x : T}`, `[inst : C]`, and after `∀`, `∃`, `fun`, `λ`, `∑`, `∏`. They
 * are variables, not symbols of the theory, and a symbolic selector must not match two statements because both call a number `hn`.
 * A heuristic over the text, not a parse: a name it misses stays a (rare) symbol.
 */
export function boundNames(text: string): Set<string> {
  const names = new Set<string>();
  const ident = /[\p{L}_][\p{L}\p{N}_'!?]*/gu;
  for (const m of text.matchAll(/[([{⦃]\s*([^:()[\]{}⦃⦄]+?)\s*:/gu)) for (const n of (m[1] ?? "").match(ident) ?? []) names.add(n);
  for (const m of text.matchAll(/(?:[∀∃λ∑∏⋃⋂]|\bfun\b)\s*([^,:=∈↦⟹]+?)\s*(?:,|:|=>|↦|∈|\bin\b)/gu)) for (const n of (m[1] ?? "").match(ident) ?? []) names.add(n);
  return names;
}

/**
 * The symbols of a statement: its words and operator characters (`Finset`, `sum`, `∣`, `≤`) as the library's index tokenizes
 * them, without the names it binds. Distinct, in order of first occurrence.
 */
export function symbolsOf(text: string): string[] {
  const bound = boundNames(text);
  let stripped = text;
  for (const n of bound) if (n.length > 0) stripped = stripped.replace(new RegExp(`(?<![\\p{L}\\p{N}_.'])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "gu"), " ");
  return [...new Set(tokenize(stripped))];
}
