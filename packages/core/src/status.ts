/**
 * Epistemic statuses (plan §2). Only a Lean-checked proof makes a claim `proved`; tool output
 * without a Lean certificate is `computed` and never propagates to `proved`.
 *
 * The user's four statuses map as: conjecture = open, réfutée = refuted,
 * preuve candidate = computed, preuve certifiée = proved.
 */
export const CLAIM_STATUSES = ["open", "computed", "refuted", "proved", "proved_informal", "retracted"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const EDGE_STATUSES = ["proposed", "computed", "lean_checked", "informal_checked", "human_signed"] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

/**
 * Edge statuses by how far a formal proof may trust them, lowest first. `lean_checked` is last, so
 * that "at least `lean_checked`" means exactly the edges a Lean lemma checked, the only ones that
 * propagate proofs; an informal check or a human signature ranks below it.
 */
const EDGE_STATUS_ORDER: readonly EdgeStatus[] = ["proposed", "computed", "informal_checked", "human_signed", "lean_checked"];

export function isEdgeStatus(value: unknown): value is EdgeStatus {
  return typeof value === "string" && (EDGE_STATUSES as readonly string[]).includes(value);
}

/** The rank of an edge status in that order, from 0 for `proposed`. */
export function edgeStatusRank(status: EdgeStatus): number {
  return EDGE_STATUS_ORDER.indexOf(status);
}

const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  open: ["computed", "refuted", "proved", "proved_informal"],
  computed: ["open", "refuted", "proved", "proved_informal"],
  proved_informal: ["proved", "refuted", "retracted"],
  // A Lean proof or refutation can only be withdrawn by revocation (a dependency was retracted).
  proved: ["retracted"],
  refuted: ["retracted"],
  retracted: ["open"],
};

export function isClaimStatus(value: unknown): value is ClaimStatus {
  return typeof value === "string" && (CLAIM_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal claim status transition ${from} -> ${to}`);
}
