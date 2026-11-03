import { maskCommentsAndStrings, type Json } from "@seshat/core";

/**
 * Definitions that the library builder added (plan change LC5, documentation/library-builder.md): a Lean `def`,
 * `structure` or the like that a coding agent wrote. The kernel checks a proof that uses one, but nothing
 * checks that the definition means what its name says, so a claim statement may not use it until it is
 * `reviewed`. The records are nodes of the kind below; the memory store owns the kind (a line cannot record or
 * update a node of it) and its review is the single place where the status changes.
 */
export const DEFINITION_KIND = "lean_definition";

/**
 * `unreviewed`: new; may appear in proofs, not in claim statements.
 * `reviewed`: its test lemmas are proved and a person or two checkers from different families signed that it is faithful.
 * `deprecated`: found wrong; kept for the results that used it, in the environment version that has it, and
 * never in a new claim statement. It is never edited: its replacement is a new definition in a new version.
 */
export type ReviewStatus = "unreviewed" | "reviewed" | "deprecated";

/** What signs a definition as faithful. */
export type ReviewBy =
  | { kind: "human"; name: string; note?: string }
  /** A cross-model faithfulness check: at least two checkers from different model families (Global Constraint 16). */
  | { kind: "faithfulness"; checkers: string[]; verdict: "faithful"; note?: string };

export interface DefinitionInput {
  /** The full name, `SeshatLib.Foo.mulDiv`. */
  name: string;
  /** `def`, `structure`, `abbrev`... */
  keyword: string;
  /** The module that holds it, `SeshatLib.Foo.Basic`. */
  module?: string;
  /** The library build that added it (the id of its `library_build` node). */
  buildId: string;
  /** The names of the spec's test lemmas that were proved about it. */
  testLemmas: readonly string[];
  /** The environment hash of the version that has it, when known. */
  envHash?: string | null;
}

export interface Definition {
  nodeId: string;
  name: string;
  keyword: string;
  module?: string;
  buildId: string;
  testLemmas: string[];
  status: ReviewStatus;
  envHash?: string | null;
  review?: { by: ReviewBy; actor: string; at: string };
  deprecated?: { reason: string; envHash?: string | null; actor: string; at: string };
}

/** The data of a `lean_definition` node. */
export interface DefinitionData {
  name: string;
  keyword: string;
  module?: string;
  buildId: string;
  testLemmas: string[];
  status: ReviewStatus;
  envHash?: string | null;
  review?: { by: ReviewBy; actor: string; at: string };
  deprecated?: { reason: string; envHash?: string | null; actor: string; at: string };
  [key: string]: Json | undefined;
}

/**
 * Whether Lean text mentions a declaration, by its last name component (`mulDiv` of `SeshatLib.Foo.mulDiv`: a
 * statement under `open SeshatLib.Foo` says `mulDiv`, one outside says `SeshatLib.Foo.mulDiv`, and both end in it).
 * Comments and strings are not text, so they are blanked first. It fails closed: a Mathlib name with the same last
 * component is taken for a mention too, which refuses a statement that would have been fine, never one that is not.
 */
export function mentionsDeclaration(text: string, name: string): boolean {
  const last = name.split(".").pop() as string;
  if (last === "") return false;
  const escaped = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // An identifier starts at a letter or underscore and may end in `!` or `?`: a `!` or `?` before a name is an operator (`!f x` is
  // `not (f x)`), so only letters, digits, underscore and the prime bound a name on the left, and `!`, `?` and the prime on the right.
  return new RegExp(`(?<![\\p{L}\\p{N}_'])${escaped}(?![\\p{L}\\p{N}_'!?])`, "u").test(maskCommentsAndStrings(text));
}

/** What is wrong with a definition's name: nothing, when it is a dotted Lean name whose last component is long enough to be told from a variable. */
export function definitionNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name)) return `${JSON.stringify(name)} is not a dotted Lean name`;
  if ((name.split(".").pop() as string).length < 3) return `${name} ends in a component shorter than three characters, which every statement would be taken to mention`;
  return undefined;
}

/** Reasons a review is not accepted from this signature, besides who may sign (the store checks that). */
export function reviewProblem(by: ReviewBy): string | undefined {
  if (by.kind === "human") return by.name.trim() === "" ? "a human review names the person" : undefined;
  // Checkers are `family:model`, and the families differ (Global Constraint 16): two models of one family are not a cross-model check.
  const families = new Set<string>();
  for (const c of by.checkers) {
    const m = /^([A-Za-z0-9_.-]+):(\S+)$/.exec(c.trim());
    if (m === null) return `the checker ${JSON.stringify(c)} is not written family:model`;
    families.add((m[1] as string).toLowerCase());
  }
  if (families.size < 2) return "a faithfulness check needs checkers from at least two distinct model families";
  return undefined;
}
