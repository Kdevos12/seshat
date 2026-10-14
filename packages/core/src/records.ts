/**
 * The vocabulary of the memory's records (plan §2): the kinds of edges between claims and nodes,
 * the kinds a Lean lemma can check, and the form of node kinds. Mechanism packages own the shape of
 * their nodes' data; the core only checks that a record is well formed.
 */

/** Kinds of edges. `decomposes_into` is a hyperedge: its targets are all the parts. */
export const EDGE_KINDS = [
  "implies",
  "equiv",
  "special_case_of",
  "strengthens",
  "negation_of",
  "decomposes_into",
  "uses",
  "refuted_by",
  "derived_from",
  "cites",
  "instance_of",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * The kinds whose truth a Lean lemma can establish: only these carry a `link` and can become
 * `lean_checked`. `uses`, `derived_from` and `cites` record provenance, which no lemma checks.
 */
export const LINK_KINDS: readonly EdgeKind[] = [
  "implies",
  "equiv",
  "special_case_of",
  "strengthens",
  "negation_of",
  "decomposes_into",
  "refuted_by",
  "instance_of",
];

/** The Lean lemma that makes an edge true: its name, and its statement in the claims' form. */
export interface EdgeLink {
  name: string;
  statement: string;
}

/** A claim stated in Lean (`formal`, the default) or in prose (`informal`, which has no Lean reference). */
export type ClaimKind = "formal" | "informal";

/** What an attempt is for: prove the claim, refute it (prove its negation), or explore it. */
export type AttemptRole = "prove" | "refute" | "explore";

/** A node kind: a short lowercase word, such as `lemma`, `lesson` or `fingerprint`. */
export const NODE_KIND = /^[a-z][a-z0-9_]{0,31}$/;

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === "string" && (EDGE_KINDS as readonly string[]).includes(value);
}
