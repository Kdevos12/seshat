import { proveWithModel, type ModelAttemptOptions } from "./attempt.ts";
import { checkEdge, type EdgeCheckOptions } from "./edge-check.ts";
import type { GraphState, Level } from "./state.ts";
import { createVariant } from "./variants.ts";

/**
 * The prove/refute twin of a claim (plan §3.2, §9): the claim, and its negation as a claim of its own,
 * joined by a `negation_of` edge. Proving the negation refutes the claim and proving the claim refutes
 * the negation (two of the propagation rules), so when one side settles the graph says the other is
 * decided, and its attempts stop.
 */
export interface Twin {
  claimId: string;
  /** The claim `¬ claim`, a variant of it. */
  negationId: string;
  /** The `negation_of` edge; it propagates once Lean has checked its link lemma. */
  edgeId: string;
  /** Whether that edge is `lean_checked`. */
  checked: boolean;
}

/** Creates the negation of a claim and checks the edge that links them (`Iff.rfl` for the standard negation). */
export async function createTwin(o: EdgeCheckOptions, claimId: string): Promise<Twin> {
  const variant = await createVariant(o.memory, { from: claimId, relation: "negation", ...(o.header !== undefined ? { header: o.header } : {}) });
  const check = await checkEdge(o, variant.edge.edgeId);
  return { claimId, negationId: variant.claimId, edgeId: variant.edge.edgeId, checked: check.checked };
}

export type TwinSide = "proof" | "refutation";

/**
 * Which side has settled, read from the graph: the claim is proved (by a proof of its own or a
 * derivation), or refuted (its negation is proved, or a refutation was found). Syncs the state.
 */
export function twinSettled(state: GraphState, twin: Twin, level: Level = "candidate"): TwinSide | undefined {
  state.sync();
  const holds = (goal: "proved" | "refuted"): boolean => {
    const known = state.levelOf({ goal, claim: twin.claimId });
    return known === "certified" || (known === "candidate" && level === "candidate");
  };
  return holds("proved") ? "proof" : holds("refuted") ? "refutation" : undefined;
}

export interface TwinRunOptions extends ModelAttemptOptions {
  state: GraphState;
  twin: Twin;
  /** The most model attempts on the refutation side. */
  attempts: number;
  /** The weakest level at which a side counts as settled. Default `candidate`. */
  level?: Level;
}

export interface TwinResult {
  /** Which side settled, or why the refutation side stopped without a result. */
  end: TwinSide | "exhausted" | "stopped";
  attempts: number;
}

/**
 * The refutation side of the twin: the model tries to prove the negation, with the neutral framing
 * of plan §9, until it does, the attempts are spent, or the other side settles (read from the graph
 * between tries). The proof side is the provers' own work; this runs alongside it.
 */
export async function runTwin(o: TwinRunOptions): Promise<TwinResult> {
  const settled = () => twinSettled(o.state, o.twin, o.level);
  const first = settled();
  if (first !== undefined) return { end: first, attempts: 0 };
  let attempts = 0;
  try {
    attempts = (await proveWithModel({ ...o, stop: () => settled() !== undefined }, o.twin.negationId, "refute", o.attempts)).tries;
  } catch (error) {
    if (o.signal?.aborted !== true) throw error;
  }
  const side = settled();
  if (side !== undefined) return { end: side, attempts };
  return { end: o.signal?.aborted === true ? "stopped" : "exhausted", attempts };
}
