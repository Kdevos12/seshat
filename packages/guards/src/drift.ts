import type { Json } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";

/**
 * What a guard or a detector found (plan §9). The first five are drift detectors, which stop and
 * restart a session; the others are guards, which reject a call, remove a text or note a finding.
 */
export const DRIFT_KINDS = [
  "strategy_loop",
  "session_loop",
  "statement_drift",
  "restated_target",
  "length_growth",
  "unresolved_citation",
  "sorry_as_known",
  "raw_error_text",
  "unanchored_revision",
  "non_neutral_framing",
] as const;

export type DriftKind = (typeof DRIFT_KINDS)[number];

/**
 * What was done about it: the session was stopped (and the prover starts a fresh one), a
 * `lean_check` call was rejected, a text was removed from the notes, a section was dropped from the
 * briefing, the next session was told to change course, or the finding was only noted.
 */
export const DRIFT_ACTIONS = ["stopped_session", "rejected_call", "removed_text", "dropped_section", "restarted", "noted"] as const;

export type DriftAction = (typeof DRIFT_ACTIONS)[number];

/**
 * The data of a `drift` node, which `@seshat/guards` owns (plan §2, "Drift"). A guard changes no
 * claim's status: it records this and acts on the session, never on the claim.
 */
export type DriftData = {
  kind: DriftKind;
  action: DriftAction;
  /**
   * One typed line made of this page's words, labels and counts: never a piece of an attempt. It is
   * what the next session may be told.
   */
  detail: string;
  attemptId?: string;
  prover?: string;
  /** The session's number for the prover, from 1. */
  session?: number;
  /** The check it is about, from 1, when it is about one. */
  check?: number;
  /** What was measured, for audit: counts, labels, names. Never shown to a model. */
  evidence?: { [key: string]: Json };
};

/** Records a finding as a `drift` node of the claim. The node's actor is the line that records it. */
export function recordDrift(memory: MemoryStore, claimId: string, data: DriftData): MemoryNode {
  return memory.recordNode({ kind: "drift", claimId, data });
}

/** A `drift` node read back. */
export interface DriftNode {
  nodeId: string;
  claimId?: string;
  data: DriftData;
}

const KINDS: readonly string[] = DRIFT_KINDS;
const ACTIONS: readonly string[] = DRIFT_ACTIONS;

/** Whether a node's data has the shape of `DriftData`. */
export function isDriftData(data: Json): data is DriftData {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  return typeof data.kind === "string" && KINDS.includes(data.kind) && typeof data.action === "string" && ACTIONS.includes(data.action) && typeof data.detail === "string";
}

/** The `drift` nodes of a claim, in the order they were recorded, optionally of one kind, prover or attempt. */
export function driftNodes(memory: MemoryStore, claimId: string, filter: { kind?: DriftKind; prover?: string; attemptId?: string } = {}): DriftNode[] {
  return memory
    .nodes("drift", { claimId })
    .flatMap((node): DriftNode[] => {
      const data = node.data;
      if (!isDriftData(data)) return [];
      if (filter.kind !== undefined && data.kind !== filter.kind) return [];
      if (filter.prover !== undefined && data.prover !== filter.prover) return [];
      if (filter.attemptId !== undefined && data.attemptId !== filter.attemptId) return [];
      return [{ nodeId: node.nodeId, ...(node.claimId !== undefined ? { claimId: node.claimId } : {}), data }];
    });
}
