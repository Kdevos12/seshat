import { Atms, GraphState } from "@seshat/graph";
import { type Edge, type MemoryStore, classifyStrategy } from "@seshat/memory";
import { headOf } from "./terms.ts";

/**
 * The archive of line M15 (documentation/archive.md): the alternative decompositions of a problem's claim, kept in diversity cells
 * as ProofEvolve's MAP-Elites archive keeps its partial proof DAGs (arXiv 2608.26334). A decomposition is a `decomposes_into` edge
 * that Lean checked; its DAG is the edge, the parts, and the decomposition of each part that is itself decomposed. Everything here
 * is read from the memory, so a resumed run has the archive it had.
 *
 * - **Fitness** ρ is the share of the DAG's leaves that are closed: a leaf is closed when its proved-modulo label (Task 5's ATMS)
 *   has the empty environment, that is when the claim is `computed` or `proved`, or the graph derives it through checked edges. A
 *   decomposition whose edge Lean has not checked is not in the archive: its parts say nothing about the claim.
 * - **Cells** are keyed by the depth of the DAG (1, 2, 3+), the dominant tactic family of the main proof, and a region: how many
 *   parts and the main symbol of the claim (`3p:=`).
 * - **Replacement.** A cell keeps one decomposition, its elite. A challenger replaces it only with a strictly higher ρ: on a tie the
 *   incumbent, the older, stays. ρ never falls while the statuses it counts stand, so a cell's fitness is monotone.
 */

/** A decomposition of a claim the archive holds. */
export interface Member {
  /** The `decomposes_into` edge. */
  edgeId: string;
  /** The claim it decomposes. */
  claimId: string;
  parts: string[];
  /** Closed leaves and leaves of the DAG, and their share. */
  closed: number;
  leaves: number;
  rho: number;
  /** Levels of decomposition in the DAG: 1 for a decomposition whose parts are not decomposed. */
  depth: number;
  family: string;
  region: string;
  key: string;
  createdSeq: number;
  /** The sketch it comes from, when it comes from one: the session, the names of its holes and its main proof. */
  attemptId?: string;
  names?: string[];
  mainProof?: string;
}

/** What the archive needs to know of a sketch a session submitted. */
export interface SketchEntry {
  attemptId: string;
  edgeId: string;
  names: string[];
  /** The main proof of the sketch, the tactic text. */
  mainProof: string;
}

export interface Cell {
  key: string;
  depth: string;
  family: string;
  region: string;
  /** The decomposition that stands in the cell. */
  elite: Member;
  /** Decompositions that fell in the cell, the elite included. */
  members: number;
}

export interface Archive {
  members: Member[];
  cells: Cell[];
}

export const depthBin = (depth: number): string => (depth >= 3 ? "3+" : String(Math.max(1, depth)));

/** The key of a cell. */
export const cellKey = (depth: string, family: string, region: string): string => `${depth}|${family}|${region}`;

/** The region of a decomposition: how many parts, and the main symbol of the claim it decomposes. */
export function regionOf(parts: number, statement: string): string {
  let head = "pred";
  try {
    head = headOf(statement);
  } catch {
    // A statement the token reader cannot read has no head: it is a `pred`.
  }
  return `${parts}p:${head}`;
}

const MAX_DEPTH = 4;

/** The decompositions of a claim that Lean checked, whose parts are all claims of the memory. */
export function checkedDecompositions(memory: MemoryStore, claimId: string): Edge[] {
  return memory
    .edges({ from: claimId, kinds: ["decomposes_into"], minStatus: "lean_checked" })
    .filter((e) => e.status === "lean_checked" && e.to.length > 0 && e.to.every((id) => memory.claim(id) !== undefined && id !== claimId));
}

interface Closure {
  closed: number;
  leaves: number;
  depth: number;
}

/** The closure of a decomposition's DAG, counted over its leaves. */
function closureOf(memory: MemoryStore, settled: (id: string) => boolean, edge: Edge, path: readonly string[]): Closure {
  let closed = 0;
  let leaves = 0;
  let depth = 0;
  for (const id of edge.to) {
    const part = leafClosure(memory, settled, id, [...path, edge.from]);
    closed += part.closed;
    leaves += part.leaves;
    depth = Math.max(depth, part.depth);
  }
  return { closed, leaves, depth: depth + 1 };
}

function leafClosure(memory: MemoryStore, settled: (id: string) => boolean, id: string, path: readonly string[]): Closure {
  if (settled(id)) return { closed: 1, leaves: 1, depth: 0 };
  if (path.length >= MAX_DEPTH || path.includes(id)) return { closed: 0, leaves: 1, depth: 0 };
  let best: Closure | undefined;
  for (const edge of checkedDecompositions(memory, id)) {
    if (edge.to.some((t) => path.includes(t))) continue;
    const c = closureOf(memory, settled, edge, path);
    if (best === undefined || c.closed / c.leaves > best.closed / best.leaves) best = c;
  }
  return best ?? { closed: 0, leaves: 1, depth: 0 };
}

/**
 * The archive of a claim's decompositions: each checked `decomposes_into` edge from the claim is a member, in the order the edges were
 * made, and the cells keep the elites. `sketches` tells the family and the main proof of the members that came from a sketch.
 */
export function readArchive(memory: MemoryStore, claimId: string, sketches: readonly SketchEntry[] = []): Archive {
  const root = memory.claim(claimId);
  if (root === undefined) return { members: [], cells: [] };
  const state = new GraphState(memory, [claimId]);
  state.sync();
  const atms = new Atms(state).refresh();
  const settled = (id: string): boolean => atms.settled(id);
  const members: Member[] = [];
  for (const edge of checkedDecompositions(memory, claimId)) {
    const c = closureOf(memory, settled, edge, []);
    const sketch = sketches.find((s) => s.edgeId === edge.edgeId);
    const family = sketch === undefined ? "other" : classifyStrategy({ proof: sketch.mainProof });
    const region = regionOf(edge.to.length, root.statement);
    members.push({
      edgeId: edge.edgeId, claimId, parts: [...edge.to], closed: c.closed, leaves: c.leaves, rho: c.leaves === 0 ? 0 : c.closed / c.leaves,
      depth: c.depth, family, region, key: cellKey(depthBin(c.depth), family, region), createdSeq: edge.createdSeq,
      ...(sketch !== undefined ? { attemptId: sketch.attemptId, names: sketch.names, mainProof: sketch.mainProof } : {}),
    });
  }
  members.sort((a, b) => a.createdSeq - b.createdSeq);
  const cells = new Map<string, Cell>();
  for (const m of members) {
    const cell = cells.get(m.key);
    if (cell === undefined) cells.set(m.key, { key: m.key, depth: depthBin(m.depth), family: m.family, region: m.region, elite: m, members: 1 });
    else {
      cell.members += 1;
      // The replacement rule: only a strictly higher fitness takes the cell.
      if (m.rho > cell.elite.rho) cell.elite = m;
    }
  }
  return { members, cells: [...cells.values()] };
}

/** The member of an archive for an edge. */
export const memberOf = (archive: Archive, edgeId: string): Member | undefined => archive.members.find((m) => m.edgeId === edgeId);

/** The share of distinct values in a list, as an entropy in bits: the diversity of the mechanisms the archive holds. */
export function entropy(labels: readonly string[]): number {
  if (labels.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / labels.length;
    h -= p * Math.log2(p);
  }
  return h;
}
