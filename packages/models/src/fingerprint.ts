import type { EdgeLink, Json } from "@seshat/core";
import type { Edge, MemoryNode, MemoryStore } from "@seshat/memory";
import type { Battery, BatteryFamily } from "./battery.ts";
import type { Magma } from "./objects.ts";
import { compileMagmaStatement, type MagmaStatement, type RecognizedStatement, statementBody, statementStructure } from "./statement.ts";

/** How a verdict was reached. */
export type EvaluatorKind = "law" | "lean" | "program";

/**
 * The fingerprint of a statement on a battery: one character for each object, in the battery's
 * order. `1`: the statement holds on the object. `0`: it fails there, with its hypotheses true: the
 * object is a counter-model. `?`: no verdict.
 */
export function verdictString(verdicts: ReadonlyArray<boolean | null>): string {
  return verdicts.map((v) => (v === null ? "?" : v ? "1" : "0")).join("");
}

export type VerdictCounts = { holds: number; fails: number; unknown: number };

export function countVerdicts(fingerprint: string): VerdictCounts {
  const counts = { holds: 0, fails: 0, unknown: 0 };
  for (const c of fingerprint) {
    if (c === "1") counts.holds++;
    else if (c === "0") counts.fails++;
    else counts.unknown++;
  }
  return counts;
}

/**
 * How two fingerprints of one battery compare, on the objects where both have a verdict:
 * - `equivalent`: equal, and not constant;
 * - `implies`: the first is below the second everywhere (where the first holds the second does) and
 *   they differ, the first holds somewhere and the second fails somewhere;
 * - `implied_by`: the same the other way round;
 * - `unrelated`: neither is below the other;
 * - `uninformative`: one of the two cases above except that a fingerprint is constant, which says
 *   nothing: a statement that holds on every object is implied by every statement and equal to
 *   every other, and one that fails on every object implies every statement.
 */
export type Relation = "equivalent" | "implies" | "implied_by" | "unrelated" | "uninformative";

export function relate(first: string, second: string): Relation {
  if (first.length !== second.length) throw new RangeError(`fingerprints of ${first.length} and ${second.length} objects are not of one battery`);
  let firstBelow = true;
  let secondBelow = true;
  let equal = true;
  let known = 0;
  const seen = { first1: false, first0: false, second1: false, second0: false };
  for (let i = 0; i < first.length; i++) {
    const a = first.charAt(i);
    const b = second.charAt(i);
    if (a === "?" || b === "?") continue;
    known++;
    if (a === "1") seen.first1 = true;
    else seen.first0 = true;
    if (b === "1") seen.second1 = true;
    else seen.second0 = true;
    if (a !== b) equal = false;
    if (a === "1" && b === "0") firstBelow = false;
    if (a === "0" && b === "1") secondBelow = false;
  }
  if (known === 0) return "uninformative";
  if (equal) return seen.first1 && seen.first0 ? "equivalent" : "uninformative";
  if (firstBelow) return seen.first1 && seen.second0 ? "implies" : "uninformative";
  if (secondBelow) return seen.second1 && seen.first0 ? "implied_by" : "uninformative";
  return "unrelated";
}

/**
 * The verdicts of a statement of magmas on magmas, in TypeScript: `true` where it holds (also where a
 * hypothesis fails, so that it holds vacuously), `false` on a counter-model, with the values of the
 * conclusion's variables that break it.
 */
export function evaluateMagmaStatement(statement: MagmaStatement, magmas: readonly Magma[]): { verdicts: boolean[]; witnesses: Array<number[] | undefined> } {
  const check = compileMagmaStatement(statement);
  const results = magmas.map((m) => check(m));
  return { verdicts: results.map((r) => r.verdict !== "fails"), witnesses: results.map((r) => r.witness) };
}

// --- The records -------------------------------------------------------------------------------

/** The data of a node of kind `battery`: which battery a run used, and how to make it again. */
export interface BatteryData {
  id: string;
  family: BatteryFamily;
  digest: string;
  size: number;
  generator: { name: string; params: Json };
  [key: string]: Json;
}

/** The data of a node of kind `fingerprint`, about one claim. */
export interface FingerprintData {
  /** The id and digest of the battery: fingerprints of the same digest compare position by position. */
  battery: string;
  digest: string;
  evaluator: EvaluatorKind;
  /** One character for each object of the battery: `1`, `0` or `?`. */
  verdicts: string;
  counts: VerdictCounts;
  /** The node of the battery. */
  batteryNode: string;
  [key: string]: Json;
}

export function batteryData(battery: Battery): BatteryData {
  return {
    id: battery.id,
    family: battery.family,
    digest: battery.digest,
    size: battery.objects.length,
    generator: { name: battery.generator.name, params: battery.generator.params as Json },
  };
}

/** The node of a battery, recorded the first time a run uses it. */
export function recordBattery(memory: MemoryStore, battery: Battery): MemoryNode {
  const known = memory.nodes("battery").find((n) => (n.data as BatteryData).digest === battery.digest && (n.data as BatteryData).id === battery.id);
  return known ?? memory.recordNode({ kind: "battery", data: batteryData(battery) });
}

/**
 * Records the fingerprint of a claim. A fingerprint the claim already has, on the same battery by
 * the same evaluator with the same verdicts, is not recorded twice.
 */
export function recordFingerprint(
  memory: MemoryStore,
  input: { claimId: string; battery: Battery; batteryNode: string; verdicts: ReadonlyArray<boolean | null>; evaluator: EvaluatorKind },
): MemoryNode {
  const verdicts = verdictString(input.verdicts);
  const known = fingerprintsOf(memory, input.claimId).find((f) => f.data.digest === input.battery.digest && f.data.evaluator === input.evaluator && f.data.verdicts === verdicts);
  if (known !== undefined) return memory.node(known.nodeId) as MemoryNode;
  const data: FingerprintData = {
    battery: input.battery.id,
    digest: input.battery.digest,
    evaluator: input.evaluator,
    verdicts,
    counts: countVerdicts(verdicts),
    batteryNode: input.batteryNode,
  };
  return memory.recordNode({ kind: "fingerprint", claimId: input.claimId, data });
}

/** The fingerprints recorded for a claim, in the order they were recorded. */
export function fingerprintsOf(memory: MemoryStore, claimId: string): Array<{ nodeId: string; data: FingerprintData }> {
  return memory.nodes("fingerprint", { claimId }).map((n) => ({ nodeId: n.nodeId, data: n.data as FingerprintData }));
}

// --- Candidate relations -----------------------------------------------------------------------

/** A claim with its fingerprint on one battery, for comparing. */
export interface Compared {
  claimId: string;
  /** The claim's statement as recognized, which gives the edge its link lemma when both statements have one structure. */
  statement?: RecognizedStatement;
  verdicts: string;
}

export interface PlannedEdge {
  kind: "equiv" | "implies";
  from: string;
  to: string;
  note: string;
  link?: EdgeLink;
}

/**
 * The lemma that makes a candidate edge true, when both statements are about the same structure:
 * for each object, the first statement's proposition about it implies (or is equivalent to) the
 * second's. If both claims are universal statements over the objects, the lemma gives the edge.
 */
export function pointwiseLink(kind: "equiv" | "implies", from: RecognizedStatement, to: RecognizedStatement, name: string): EdgeLink | undefined {
  if (from.kind !== to.kind || statementStructure(from) !== statementStructure(to)) return undefined;
  const structure = statementStructure(from);
  const a = statementBody(from);
  const b = statementBody(to);
  return {
    name,
    statement: kind === "implies" ? `${structure} (h : ${a}) : ${b}` : `${structure} : (${a}) ↔ (${b})`,
  };
}

function lemmaName(kind: string, a: string, b: string): string {
  return `m11_${kind}_${a}_${b}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * The candidate relations of a claim with others whose fingerprints are of the same battery: an
 * `equiv` edge for equal fingerprints and an `implies` edge for included ones, each only where the
 * comparison tells something (`relate`). They are candidates: they come from a finite battery,
 * and the edges are `computed`, never `lean_checked`.
 */
export function planRelations(source: Compared, others: readonly Compared[], battery: { id: string; size: number }): PlannedEdge[] {
  const plans: PlannedEdge[] = [];
  for (const other of others) {
    if (other.claimId === source.claimId) continue;
    const relation = relate(source.verdicts, other.verdicts);
    if (relation === "unrelated" || relation === "uninformative") continue;
    const a = countVerdicts(source.verdicts);
    const b = countVerdicts(other.verdicts);
    const on = `fingerprints on ${battery.id} (${battery.size} objects)`;
    const kind = relation === "equivalent" ? "equiv" : "implies";
    const [from, to] = relation === "implied_by" ? [other, source] : [source, other];
    const note =
      relation === "equivalent"
        ? `candidate equivalence: the ${on} are equal (the statement holds on ${a.holds} objects and fails on ${a.fails})`
        : `candidate implication: in the ${on}, the first holds on ${(relation === "implies" ? a : b).holds} objects where the second holds on ${(relation === "implies" ? b : a).holds}, and the second fails on ${(relation === "implies" ? b : a).fails}`;
    const link = from.statement !== undefined && to.statement !== undefined ? pointwiseLink(kind, from.statement, to.statement, lemmaName(kind, from.claimId, to.claimId)) : undefined;
    plans.push({ kind, from: from.claimId, to: to.claimId, note, ...(link !== undefined ? { link } : {}) });
  }
  return plans;
}

/** Adds the planned edges as `computed`, except those the memory already has (an `equiv` in either direction). */
export function addPlannedEdges(memory: MemoryStore, plans: readonly PlannedEdge[]): Edge[] {
  const added: Edge[] = [];
  for (const plan of plans) {
    const exists = (from: string, to: string) => memory.edges({ from, to, kinds: [plan.kind] }).length > 0;
    if (exists(plan.from, plan.to) || (plan.kind === "equiv" && exists(plan.to, plan.from))) continue;
    added.push(
      memory.addEdge({
        kind: plan.kind,
        from: plan.from,
        to: plan.to,
        status: "computed",
        note: plan.note,
        ...(plan.link !== undefined ? { link: plan.link } : {}),
      }),
    );
  }
  return added;
}
