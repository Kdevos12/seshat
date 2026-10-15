import type { Json } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";

/**
 * The data of an `allocation` node, which `@seshat/fleet` owns: what the fleet decided for one
 * session of one prover, and what it decided from.
 */
export type AllocationData = {
  attemptId: string;
  prover: string;
  /** The prover's session number, from 1. */
  session: number;
  /** The strategy the session was told to work on. */
  strategy?: string;
  /** `thompson`: drawn from the posteriors; `continued`: the prover's last strategy, kept because Lean got further with it. */
  rule?: "thompson" | "continued";
  /** The model the session was given, when the fleet chose one. */
  model?: string;
  /** True when the model is the stronger one, for a hard decision. */
  escalated?: boolean;
  /** The width of the subgoal when the session was admitted, and whether the prover waited for a place. */
  width: number;
  waited: boolean;
  /** The single-agent success rate of the claim and the attempts it is made of. */
  successRate: number;
  attempts: number;
  /** The draws of the strategies that were candidates, rounded. */
  draws?: { [label: string]: number };
};

export function isAllocationData(data: Json): data is AllocationData {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  return typeof data.attemptId === "string" && typeof data.prover === "string" && typeof data.session === "number" && typeof data.width === "number";
}

/** The `allocation` nodes of a claim, in the order they were recorded. */
export function allocations(memory: MemoryStore, claimId: string): Array<{ node: MemoryNode; data: AllocationData }> {
  return memory.nodes("allocation", { claimId }).flatMap((node) => (isAllocationData(node.data) ? [{ node, data: node.data }] : []));
}
