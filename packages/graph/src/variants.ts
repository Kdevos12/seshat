import type { EdgeKind, EdgeStatus } from "@seshat/core";
import type { Edge, MemoryStore } from "@seshat/memory";
import { linkFor, type VariantRelation, variantEdge } from "./links.ts";
import { negationStatement } from "./signature.ts";

export interface EdgeProposal {
  kind: EdgeKind;
  from: string;
  to: string | readonly string[];
  /** Default `proposed`. */
  status?: EdgeStatus;
  attemptId?: string;
  toolRunId?: string;
  note?: string;
}

/**
 * Adds an edge between claims as `proposed`, with the link lemma its kind calls for written from the
 * two statements ([links.ts](./links.ts)). An edge of the same kind between the same claims is
 * returned instead of a second one. The edge becomes `lean_checked` through `checkEdge`.
 */
export function proposeEdge(memory: MemoryStore, input: EdgeProposal): Edge {
  const targets = typeof input.to === "string" ? [input.to] : [...input.to];
  const same = memory
    .edges({ from: input.from, kinds: [input.kind] })
    .find((edge) => edge.to.length === targets.length && edge.to.every((id, k) => id === targets[k]));
  if (same !== undefined) return same;
  const claimOf = (id: string) => {
    const claim = memory.claim(id);
    if (claim === undefined) throw new Error(`proposeEdge: unknown claim ${id}`);
    if (claim.kind === "informal") throw new Error(`proposeEdge: claim ${id} is informal, no Lean lemma links it`);
    return { id, statement: claim.statement };
  };
  const link = linkFor(input.kind, claimOf(input.from), targets.map(claimOf));
  return memory.addEdge({
    kind: input.kind,
    from: input.from,
    to: targets,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.toolRunId !== undefined ? { toolRunId: input.toolRunId } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(link !== undefined ? { link } : {}),
  });
}

export interface VariantInput {
  /** The claim the variant comes from. */
  from: string;
  relation: VariantRelation;
  /**
   * The variant's statement, in signature form. A negation may leave it out: it is then `¬` of the
   * claim's statement as one proposition.
   */
  statement?: string;
  /** The Lean header the statement is read under. Default: the claim's own. */
  header?: string;
  gloss?: string;
  /** Default: the claim's. */
  domain?: string[];
  /** Default: the actor of the store. */
  origin?: string;
  attemptId?: string;
  note?: string;
}

export interface Variant {
  claimId: string;
  /** False when a claim with this statement existed already. */
  created: boolean;
  /** The edge from or to the claim, `proposed` unless it was checked before. */
  edge: Edge;
}

/**
 * Creates a variant of a claim (a strengthening, a special case, a generalization or its negation)
 * and the edge that says how they relate, as `proposed` (plan §3.2). The variant's `parentId` is the
 * claim. The edge carries its link lemma, and is `lean_checked` only once Lean has checked that
 * lemma (`checkEdge`).
 */
export async function createVariant(memory: MemoryStore, input: VariantInput): Promise<Variant> {
  const source = memory.claim(input.from);
  if (source === undefined) throw new Error(`createVariant: unknown claim ${input.from}`);
  if (source.kind === "informal") throw new Error(`createVariant: claim ${input.from} is informal; a variant needs a Lean statement`);
  const statement = input.statement ?? (input.relation === "negation" ? negationStatement(source.statement) : undefined);
  if (statement === undefined) throw new Error(`createVariant: a ${input.relation} needs its statement`);
  const header = input.header ?? source.header;
  const ensured = await memory.ensureClaim({
    statement,
    origin: input.origin ?? memory.actor,
    parentId: input.from,
    kind: "formal",
    domain: input.domain ?? source.domain,
    ...(header !== undefined ? { header } : {}),
    ...(input.gloss !== undefined ? { gloss: input.gloss } : {}),
  });
  if (ensured.claimId === input.from) throw new Error(`createVariant: the ${input.relation} has the statement of claim ${input.from} itself`);
  const ends = variantEdge(input.relation, input.from, ensured.claimId);
  const edge = proposeEdge(memory, {
    ...ends,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    note: input.note ?? input.relation.replace("_", " "),
  });
  return { claimId: ensured.claimId, created: ensured.created, edge };
}
