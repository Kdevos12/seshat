import type { Json } from "@seshat/core";

/**
 * The memory nodes line M12 writes (documentation/scheduler.md, "What M12 records"). Each is a fact of what
 * happened, written once after it happened; nothing here is learned from outcomes, so none is stamped (Global
 * Constraint 16): the posteriors the scheduler uses are computed from these records when they are read.
 */

/** A sketch an outer session ended with: its named holes as claims, and whether the sketch is healthy. */
export const SKETCH_KIND = "m12_sketch";

export interface SketchRecord {
  problemId: string;
  attemptId: string;
  /** The blob of the sketch as the session submitted it, `{aux, proof}`. */
  submission: string;
  /** The lemma names (`aux_bound`). */
  names: string[];
  /** The sketch checked with only its named holes open: no Lean error, and no sorry outside the holes. */
  healthy: boolean;
  /** Why the sketch cannot be split, when it cannot. */
  problem?: string;
  /** `restates_target` when a blueprint is refused because a hole states the target again (CA9). */
  failureClass?: string;
  /** The sketch was read as a blueprint (option `blueprints`): its holes may declare dependencies. */
  blueprint?: boolean;
  /** For a blueprint, the holes each hole declares it may use (`-- uses:`), as names, parallel to `names`. */
  uses?: string[][];
  /**
   * False when the session just ended and the scheduler has not yet made the claims and the edge (that work
   * is Lean's, and starts between sessions, so that a record written by a session that ended is all a cut can lose).
   */
  registered: boolean;
  /** The claims made of the holes' statements, parallel to `names`, once registered. */
  holes: string[];
  /** The `decomposes_into` edge from the problem's claim to the holes, once made. */
  edgeId?: string;
}

/** One inner session of the scheduler's prover on a subgoal. */
export const SESSION_KIND = "m12_session";

export interface SessionRecord {
  problemId: string;
  taskId: string;
  claimId: string;
  /** The session's number for its task, from 1. */
  session: number;
  /** Lean accepted the proof (the claim is a candidate or better). */
  ok: boolean;
  usd: number;
  /** Why it failed, a few lines. */
  reasons: string[];
  validationId?: string;
  /** A hole session (blueprints, CA10): why it ended (`SessionStop`) and its model responses. */
  stop?: string;
  turns?: number;
  /**
   * The hole's work was done on the small file (no Lean error, every `sorry` in a dependency stub): the proof and the helper lemmas it used, as the blob of
   * `{aux, proof}`, and the hash of that text. It is a fact about a file, not a status: the claim becomes `computed` only through `validate`.
   */
  workDone?: boolean;
  work?: string;
  workHash?: string;
  /** The session's verdict (`hole_verdict` nodes carry the same). */
  verdict?: "proved" | "statement_wrong" | "too_hard";
  /** `statement_wrong`: Lean accepted the proof of the negation through `validate`; and the prover's argument. The `hole_verdict` node is made again from these if a cut lost it. */
  negationValidated?: boolean;
  argument?: string;
}

/** The pre-flight of a hole, before any paid session (CA11): what the battery, `plausible` and the battery on the negation found. An evidence node. */
export const PREFLIGHT_KIND = "m12_preflight";

export interface PreflightRecord {
  problemId: string;
  claimId: string;
  proved: boolean;
  refuted: boolean;
  plausible?: string;
  notes: string[];
}

/** A subsumption the scheduler tried: an `instance_of` edge between two claims, and whether Lean checked it. */
export const SUBSUMPTION_KIND = "m12_subsumption";

export interface SubsumptionRecord {
  problemId: string;
  /** `forward`: a new claim was an instance of a known fact. `backward`: a new fact covers an open claim. */
  direction: "forward" | "backward";
  /** The special case, and the general fact. */
  instance: string;
  general: string;
  edgeId: string;
  checked: boolean;
}

export const asRecord = <T>(data: Json): T => data as unknown as T;
