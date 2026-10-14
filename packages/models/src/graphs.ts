import { permutations } from "./magma.ts";
import type { GraphObject } from "./objects.ts";

/** The most vertices for which the graphs are listed or put in canonical form: the key of a graph fits in 28 bits. */
export const MAX_GRAPH_VERTICES = 8;

type Edge = readonly [number, number];

/** The bit set of the neighbors of each vertex. */
function adjacencyOf(n: number, edges: readonly Edge[]): number[] {
  const adj = new Array<number>(n).fill(0);
  for (const [u, v] of edges) {
    adj[u] = (adj[u] as number) | (1 << v);
    adj[v] = (adj[v] as number) | (1 << u);
  }
  return adj;
}

function sortedEdges(n: number, edges: readonly Edge[]): Array<[number, number]> {
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) throw new RangeError(`the edge ${a}-${b} is not on the vertices 0..${n - 1}`);
    if (a === b) throw new RangeError(`a simple graph has no loop, the edge ${a}-${a}`);
    const [u, v] = a < b ? [a, b] : [b, a];
    if (seen.has(u * n + v)) continue;
    seen.add(u * n + v);
    out.push([u, v]);
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** The graph6 string of a graph on up to 62 vertices (the format of nauty's `geng`). */
export function toGraph6(n: number, edges: readonly Edge[]): string {
  if (n < 0 || n > 62) throw new RangeError(`graph6 is written here for 0 to 62 vertices, not ${n}`);
  const adj = adjacencyOf(n, edges);
  const bits: number[] = [];
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) bits.push(((adj[i] as number) >> j) & 1);
  }
  while (bits.length % 6 !== 0) bits.push(0);
  let out = String.fromCharCode(63 + n);
  for (let k = 0; k < bits.length; k += 6) {
    out += String.fromCharCode(63 + bits.slice(k, k + 6).reduce((value, bit) => value * 2 + bit, 0));
  }
  return out;
}

/** A graph from its graph6 string (up to 62 vertices). */
export function fromGraph6(text: string): GraphObject {
  const body = text.trim().replace(/^>>graph6<<\s*/, "");
  if (body === "") throw new SyntaxError("an empty graph6 string");
  const n = body.charCodeAt(0) - 63;
  if (n < 0 || n > 62) throw new SyntaxError(`graph6 ${JSON.stringify(text)}: ${body[0]} does not start a graph on up to 62 vertices`);
  const bits: number[] = [];
  for (let k = 1; k < body.length; k++) {
    const value = body.charCodeAt(k) - 63;
    if (value < 0 || value > 63) throw new SyntaxError(`graph6 ${JSON.stringify(text)}: the character ${body[k]} is out of range`);
    for (let shift = 5; shift >= 0; shift--) bits.push((value >> shift) & 1);
  }
  const needed = (n * (n - 1)) / 2;
  if (bits.length < needed || bits.length - needed >= 6) throw new SyntaxError(`graph6 ${JSON.stringify(text)}: ${n} vertices need ${Math.ceil(needed / 6)} characters of edges`);
  const edges: Array<[number, number]> = [];
  let at = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (bits[at++] === 1) edges.push([i, j]);
    }
  }
  return graphObject(n, edges);
}

/** A graph on the vertices 0..n-1. */
export function graphObject(n: number, edges: readonly Edge[]): GraphObject {
  const sorted = sortedEdges(n, edges);
  const graph6 = toGraph6(n, sorted);
  return { kind: "graph", id: graph6, n, edges: sorted, graph6 };
}

/** Splits the vertices into cells that no isomorphism can mix (colour refinement), in an order that does not depend on the labels. */
function refine(n: number, adj: readonly number[]): number[][] {
  let colors = adj.map((row) => String(popcount(row)));
  let classes = new Set(colors).size;
  for (;;) {
    const signatures = colors.map((color, v) => {
      const around: string[] = [];
      for (let w = 0; w < n; w++) {
        if (((adj[v] as number) >> w) & 1) around.push(colors[w] as string);
      }
      return `${color}|${around.sort().join(",")}`;
    });
    const ranked = [...new Set(signatures)].sort();
    colors = signatures.map((signature) => String(ranked.indexOf(signature)).padStart(3, "0"));
    if (ranked.length === classes) break;
    classes = ranked.length;
  }
  const cells = new Map<string, number[]>();
  colors.forEach((color, v) => cells.set(color, [...(cells.get(color) ?? []), v]));
  return [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, vertices]) => vertices);
}

function popcount(x: number): number {
  let count = 0;
  for (let rest = x; rest !== 0; rest &= rest - 1) count++;
  return count;
}

/**
 * The graph with its vertices renamed so that its adjacency bits, read pair by pair, are the
 * smallest among the renamings that respect the cells of the colour refinement. Two graphs are
 * isomorphic exactly when their canonical forms are equal.
 */
export function canonicalGraph(graph: { n: number; edges: readonly Edge[] }): GraphObject {
  const n = graph.n;
  if (n < 1 || n > MAX_GRAPH_VERTICES) throw new RangeError(`canonicalGraph takes 1 to ${MAX_GRAPH_VERTICES} vertices, not ${n}`);
  const adj = adjacencyOf(n, graph.edges);
  const cells = refine(n, adj);
  const order = new Array<number>(n).fill(0);
  let best = Number.POSITIVE_INFINITY;
  let bestOrder: number[] = [];
  const place = (cell: number, offset: number) => {
    if (cell === cells.length) {
      let key = 0;
      for (let i = 0; i < n; i++) {
        const row = adj[order[i] as number] as number;
        for (let j = i + 1; j < n; j++) key = key * 2 + ((row >> (order[j] as number)) & 1);
      }
      if (key < best) {
        best = key;
        bestOrder = [...order];
      }
      return;
    }
    const vertices = cells[cell] as number[];
    for (const perm of permutations(vertices.length)) {
      perm.forEach((from, k) => {
        order[offset + k] = vertices[from] as number;
      });
      place(cell + 1, offset + vertices.length);
    }
  };
  place(0, 0);
  const position = new Map(bestOrder.map((vertex, k) => [vertex, k]));
  return graphObject(
    n,
    sortedEdges(n, graph.edges).map(([u, v]) => [position.get(u) as number, position.get(v) as number]),
  );
}

const listed = new Map<number, GraphObject[]>();

/**
 * Every graph on `n` vertices, one for each isomorphism class, by adding a vertex in every possible
 * way to the graphs on n - 1 vertices and keeping one graph of each class. 1, 2, 4, 11, 34, 156,
 * 1 044, 12 346 graphs for 1 to 8 vertices (OEIS A000088). nauty's `geng` makes the same list,
 * and larger ones, through SageMath (`sage.ts`).
 */
export function graphsUpToIso(n: number): GraphObject[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_GRAPH_VERTICES) throw new RangeError(`graphsUpToIso takes 1 to ${MAX_GRAPH_VERTICES} vertices, not ${n}`);
  const known = listed.get(n);
  if (known !== undefined) return known;
  let out: GraphObject[];
  if (n === 1) {
    out = [graphObject(1, [])];
  } else {
    const classes = new Map<string, GraphObject>();
    for (const base of graphsUpToIso(n - 1)) {
      for (let neighbors = 0; neighbors < 1 << (n - 1); neighbors++) {
        const edges: Edge[] = [...base.edges];
        for (let v = 0; v < n - 1; v++) {
          if ((neighbors >> v) & 1) edges.push([v, n - 1]);
        }
        const canonical = canonicalGraph({ n, edges });
        classes.set(canonical.id, canonical);
      }
    }
    out = [...classes.values()].sort((a, b) => a.edges.length - b.edges.length || (a.id < b.id ? -1 : 1));
  }
  listed.set(n, out);
  return out;
}

/** Whether every vertex can be reached from vertex 0. */
export function isConnected(graph: { n: number; edges: readonly Edge[] }): boolean {
  if (graph.n === 0) return true;
  const adj = adjacencyOf(graph.n, graph.edges);
  let reached = 1;
  for (let frontier = 1; frontier !== 0; ) {
    let next = 0;
    for (let v = 0; v < graph.n; v++) {
      if ((frontier >> v) & 1) next |= adj[v] as number;
    }
    frontier = next & ~reached;
    reached |= next;
  }
  return reached === (1 << graph.n) - 1;
}
