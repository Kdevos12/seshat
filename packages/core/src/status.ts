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
