import { type EdgeKind, type EdgeLink, LINK_KINDS } from "@seshat/core";
import { parseSignature, paren } from "./signature.ts";

/** How a variant relates to the claim it comes from (plan §2, "Variant"). */
export const VARIANT_RELATIONS = ["strengthening", "special_case", "generalization", "negation"] as const;
export type VariantRelation = (typeof VARIANT_RELATIONS)[number];

export function isVariantRelation(value: unknown): value is VariantRelation {
  return typeof value === "string" && (VARIANT_RELATIONS as readonly string[]).includes(value);
}

/**
 * The edge between a claim and its variant, with the variant at the end the relation says:
 * a strengthening `strengthens` the claim, a special case is `special_case_of` it, a
 * generalization is the claim `special_case_of` the variant, and a negation is `negation_of` it.
 */
export function variantEdge(relation: VariantRelation, claimId: string, variantId: string): { kind: EdgeKind; from: string; to: string } {
  switch (relation) {
    case "strengthening":
      return { kind: "strengthens", from: variantId, to: claimId };
    case "special_case":
      return { kind: "special_case_of", from: variantId, to: claimId };
    case "generalization":
      return { kind: "special_case_of", from: claimId, to: variantId };
    case "negation":
      return { kind: "negation_of", from: variantId, to: claimId };
  }
}

/**
 * The link lemma of an edge, as a statement in signature form, written from the two ends'
 * statements (`F` is the `from` end, `T` the `to` end, each as one parenthesized proposition):
 *
 * | Edge | Lemma |
 * |---|---|
 * | `implies`, `strengthens` | `F → T` |
 * | `special_case_of`, `instance_of` | `T → F` (the general statement implies the special one) |
 * | `equiv` | `F ↔ T` |
 * | `negation_of` | `F ↔ ¬ T` |
 * | `decomposes_into` | `T1 → ... → Tn → F` (the parts imply the whole) |
 * | `refuted_by` | `T → ¬ F` (the counterexample refutes the claim) |
 *
 * The propagation rules and the composed proofs rely on exactly these shapes. Undefined for the
 * kinds no lemma checks (`uses`, `derived_from`, `cites`).
 */
export function linkStatement(kind: EdgeKind, from: string, to: readonly string[]): string | undefined {
  if (!LINK_KINDS.includes(kind)) return undefined;
  const f = paren(parseSignature(from));
  const t = to.map((statement) => paren(parseSignature(statement)));
  const first = t[0];
  if (first === undefined) throw new Error(`a ${kind} edge has no target`);
  switch (kind) {
    case "implies":
    case "strengthens":
      return `: ${f} → ${first}`;
    case "special_case_of":
    case "instance_of":
      return `: ${first} → ${f}`;
    case "equiv":
      return `: ${f} ↔ ${first}`;
    case "negation_of":
      return `: ${f} ↔ ¬ ${first}`;
    case "decomposes_into":
      return `: ${[...t, f].join(" → ")}`;
    case "refuted_by":
      return `: ${first} → ¬ ${f}`;
    default:
      return undefined;
  }
}

/** The link of an edge between claims, named after its kind and the ends of the ids. */
export function linkFor(kind: EdgeKind, from: { id: string; statement: string }, to: ReadonlyArray<{ id: string; statement: string }>): EdgeLink | undefined {
  const statement = linkStatement(kind, from.statement, to.map((end) => end.statement));
  if (statement === undefined) return undefined;
  const tail = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(-6);
  return { name: `link_${kind}_${tail(from.id)}_${to.map((end) => tail(end.id)).join("_")}`, statement };
}
