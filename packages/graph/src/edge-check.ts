import type { EdgeKind } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import { failureLines } from "./failure.ts";
import type { ValidateFn } from "./realize.ts";

/** Cheap tactic proofs of a link lemma that is an implication, tried before any model is asked. */
export const IMPLICATION_CLOSERS: readonly string[] = ["exact fun h => h", "intro h; exact h", "intro h; simpa using h", "tauto", "intro h; omega", "aesop"];

/** The same for a link lemma that is an equivalence (`equiv` and `negation_of` edges). */
export const EQUIVALENCE_CLOSERS: readonly string[] = ["exact Iff.rfl", "constructor <;> intro h <;> simpa using h", "tauto", "constructor <;> intro h <;> omega", "simp", "aesop"];

export function closersFor(kind: EdgeKind): readonly string[] {
  return kind === "equiv" || kind === "negation_of" ? EQUIVALENCE_CLOSERS : IMPLICATION_CLOSERS;
}

export interface Proposal {
  /** The tactic proof, without `by`. */
  proof: string;
  /** Auxiliary declarations before the theorem, each named `aux_...`. */
  aux?: string;
}

export interface EdgeCheckOptions {
  memory: MemoryStore;
  validate: ValidateFn;
  /** The Lean header the link lemma is read under. Default: the header of the edge's `from` claim. */
  header?: string;
  /** Tactic proofs to try first, one Lean check each. Default: `closersFor(kind)`. */
  closers?: readonly string[];
  /** More proofs when the closers fail (a model's), given the lemma and what failed. */
  propose?: (request: { claimId: string; statement: string; failures: string[] }) => Promise<readonly Proposal[]>;
  attemptId?: string;
  log?: (text: string) => void;
}

export interface EdgeCheck {
  edgeId: string;
  checked: boolean;
  reason: string;
  /** The link lemma's claim, when there is one. */
  lemmaId?: string;
  validationId?: string;
  /** Proofs submitted to Lean. */
  tried: number;
}

/**
 * Checks an edge by its link lemma (plan §2: "the lemma that compiles makes the edge `lean_checked`"):
 * states the lemma as a claim, submits a proof of it through `validate`, and on a valid verdict
 * moves the edge to `lean_checked` with that validation. The proofs come from the closers first
 * (cheap tactics), then from `propose`. An edge already checked, or whose kind has no lemma, is
 * left alone. Nothing here can make a claim `proved`: the lemma is a claim of its own, and the
 * edge's status is the only thing that changes.
 */
export async function checkEdge(o: EdgeCheckOptions, edgeId: string): Promise<EdgeCheck> {
  const edge = o.memory.edge(edgeId);
  if (edge === undefined) throw new Error(`checkEdge: unknown edge ${edgeId}`);
  if (edge.status === "lean_checked") return { edgeId, checked: true, reason: "the edge is lean_checked already", tried: 0 };
  if (edge.link === undefined) return { edgeId, checked: false, reason: `no Lean lemma checks a ${edge.kind} edge`, tried: 0 };
  const header = o.header ?? o.memory.claim(edge.from)?.header;
  const lemma = await o.memory.ensureClaim({
    statement: edge.link.statement,
    origin: o.memory.actor,
    kind: "formal",
    parentId: edge.from,
    gloss: `link lemma of the ${edge.kind} edge ${edgeId}`,
    ...(header !== undefined ? { header } : {}),
  });
  const accept = (validationId: string, reason: string): EdgeCheck => {
    o.memory.setEdgeStatus(edgeId, "lean_checked", { reason, validationId });
    o.log?.(`edge ${edgeId} (${edge.kind}) is lean_checked: ${reason}`);
    return { edgeId, checked: true, reason, lemmaId: lemma.claimId, validationId, tried };
  };
  let tried = 0;
  const earlier = o.memory.validations(lemma.claimId).find((v) => v.verdict === "valid" && !v.negation);
  if (earlier !== undefined) return accept(earlier.validationId, `its lemma ${edge.link.name} was checked before`);

  const failures: string[] = [];
  const attempt = async (proposal: Proposal): Promise<EdgeCheck | undefined> => {
    tried += 1;
    const result = await o.validate({
      claimId: lemma.claimId,
      proof: proposal.proof,
      ...(proposal.aux !== undefined ? { aux: proposal.aux } : {}),
      ...(o.attemptId !== undefined ? { attemptId: o.attemptId } : {}),
    });
    if (result.verdict === "valid" && result.validationId !== undefined) return accept(result.validationId, `its lemma ${edge.link?.name} passed the check`);
    failures.push(...(failureLines(result).length > 0 ? failureLines(result) : ["the check failed"]));
    // A lemma that does not even compile cannot be proved by trying other tactics.
    if (result.report === undefined) return { edgeId, checked: false, reason: `the lemma does not compile: ${failures.at(-1)}`, lemmaId: lemma.claimId, tried };
    return undefined;
  };
  for (const proof of o.closers ?? closersFor(edge.kind)) {
    const outcome = await attempt({ proof });
    if (outcome !== undefined) return outcome;
  }
  for (const proposal of (await o.propose?.({ claimId: lemma.claimId, statement: edge.link.statement, failures })) ?? []) {
    const outcome = await attempt(proposal);
    if (outcome !== undefined) return outcome;
  }
  return { edgeId, checked: false, reason: `no proof of the lemma ${edge.link.name} passed (${tried} tried)`, lemmaId: lemma.claimId, tried };
}
