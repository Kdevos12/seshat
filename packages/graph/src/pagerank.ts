import { type ClaimStatus, type EdgeKind, type EdgeStatus, edgeStatusRank } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";

/** What a walk needs of an edge: `Edge` of the memory has all of it. */
export interface WalkEdge {
  kind: EdgeKind;
  from: string;
  to: readonly string[];
  status: EdgeStatus;
}

export interface PageRankOptions {
  /**
   * Where the walk restarts: claim ids, or a weight for each claim. Without seeds every claim
   * is one, which is the plain PageRank.
   */
  seeds?: readonly string[] | ReadonlyMap<string, number>;
  /** The probability of following an edge rather than restarting at a seed. Default 0.85. */
  damping?: number;
  /**
   * Which way the walk follows an edge: `both` (default; two claims are related whichever way the
   * edge points), `forward` (from the `from` claim to its targets) or `backward`.
   */
  direction?: "both" | "forward" | "backward";
  /** Only the edges of these kinds. Default: all. */
  kinds?: readonly EdgeKind[];
  /** A weight for each kind of edge, 1 where not given. Zero removes the kind. */
  kindWeights?: Partial<Record<EdgeKind, number>>;
  /** Only the edges of at least this status. Default: all. */
  minStatus?: EdgeStatus;
  /** Default 200. */
  maxIterations?: number;
  /** The walk stops when the scores move by less than this in total. Default 1e-12. */
  tolerance?: number;
}

export interface Ranked {
  claim: string;
  score: number;
}

export interface PageRankResult {
  /** The scores, which add up to 1. */
  scores: ReadonlyMap<string, number>;
  /** The claims by decreasing score, ties by id. */
  ranking: Ranked[];
  iterations: number;
  converged: boolean;
}

/**
 * Personalized PageRank (plan §3.2): the long-run chance that a random walk is at each claim, when
 * at every step it follows an edge with probability `damping` and otherwise restarts at a seed.
 * A claim scores high when many short paths of edges lead to it from the seeds, which is how the
 * context compiler and the scheduler find the claims near a problem. A claim with no edge to follow
 * sends its whole share back to the seeds. Power iteration, so the result is exact up to
 * `tolerance` and does not depend on the order of the edges.
 */
export function personalizedPageRank(edges: Iterable<WalkEdge>, options: PageRankOptions = {}): PageRankResult {
  const damping = options.damping ?? 0.85;
  if (!(damping >= 0 && damping < 1)) throw new Error(`personalizedPageRank: the damping ${damping} is not in [0, 1)`);
  const direction = options.direction ?? "both";
  const minimum = options.minStatus === undefined ? undefined : edgeStatusRank(options.minStatus);

  const arcs = new Map<string, Map<string, number>>();
  const nodes = new Set<string>();
  const arc = (source: string, target: string, weight: number) => {
    nodes.add(source);
    nodes.add(target);
    if (weight === 0) return;
    const row = arcs.get(source) ?? new Map<string, number>();
    arcs.set(source, row);
    row.set(target, (row.get(target) ?? 0) + weight);
  };
  for (const edge of edges) {
    if (options.kinds !== undefined && !options.kinds.includes(edge.kind)) continue;
    if (minimum !== undefined && edgeStatusRank(edge.status) < minimum) continue;
    const weight = options.kindWeights?.[edge.kind] ?? 1;
    if (weight < 0) throw new Error(`personalizedPageRank: the weight of ${edge.kind} edges is negative`);
    for (const target of edge.to) {
      if (direction !== "backward") arc(edge.from, target, weight);
      if (direction !== "forward") arc(target, edge.from, weight);
    }
  }

  const given = options.seeds;
  const seeds: ReadonlyMap<string, number> | undefined =
    given === undefined ? undefined : "get" in given ? given : new Map(given.map((id) => [id, 1] as const));
  for (const id of seeds?.keys() ?? []) nodes.add(id);
  const order = [...nodes].sort();
  const index = new Map(order.map((id, k) => [id, k]));
  if (order.length === 0) return { scores: new Map(), ranking: [], iterations: 0, converged: true };

  const restart = new Float64Array(order.length);
  if (seeds === undefined || seeds.size === 0) restart.fill(1 / order.length);
  else {
    let total = 0;
    for (const [id, weight] of seeds) {
      if (!(weight >= 0)) throw new Error(`personalizedPageRank: the weight of seed ${id} is negative`);
      total += weight;
    }
    if (total === 0) throw new Error("personalizedPageRank: the seeds weigh nothing");
    for (const [id, weight] of seeds) restart[index.get(id) as number] = weight / total;
  }
  const rows = order.map((id) => {
    const row = arcs.get(id);
    const sum = row === undefined ? 0 : [...row.values()].reduce((a, b) => a + b, 0);
    return { sum, targets: row === undefined ? [] : [...row].map(([target, weight]) => [index.get(target) as number, weight / sum] as const) };
  });

  let rank = Float64Array.from(restart);
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-12;
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations && !converged) {
    iterations += 1;
    const next = new Float64Array(order.length);
    let dangling = 0;
    rows.forEach((row, i) => {
      const mass = rank[i] as number;
      if (row.sum === 0) dangling += mass;
      else for (const [j, share] of row.targets) next[j] = (next[j] as number) + damping * mass * share;
    });
    let moved = 0;
    for (let j = 0; j < next.length; j++) {
      next[j] = (next[j] as number) + (1 - damping) * (restart[j] as number) + damping * dangling * (restart[j] as number);
      moved += Math.abs((next[j] as number) - (rank[j] as number));
    }
    rank = next;
    converged = moved < tolerance;
  }

  const scores = new Map(order.map((id, k) => [id, rank[k] as number]));
  const ranking = order.map((claim, k) => ({ claim, score: rank[k] as number })).sort((a, b) => b.score - a.score || (a.claim < b.claim ? -1 : 1));
  return { scores, ranking, iterations, converged };
}

export interface NearbyOptions extends PageRankOptions {
  /** The most claims to return. Default 10. */
  limit?: number;
  /** Keep the claims with these statuses only (`open` for the lemmas still to prove). */
  statuses?: readonly ClaimStatus[];
  /** Keep the seeds in the ranking. Default false. */
  includeSeeds?: boolean;
}

/**
 * The claims nearest to some seeds in the graph of the memory, best first: the walk of
 * `personalizedPageRank` over every edge the memory holds.
 */
export function nearbyClaims(memory: MemoryStore, seeds: readonly string[], options: NearbyOptions = {}): Ranked[] {
  const { limit = 10, statuses, includeSeeds = false, ...walk } = options;
  const result = personalizedPageRank(memory.edges(), { ...walk, seeds: walk.seeds ?? seeds });
  const own = new Set(seeds);
  return result.ranking
    .filter(({ claim }) => (includeSeeds || !own.has(claim)) && (statuses === undefined || statuses.includes(memory.claim(claim)?.status as ClaimStatus)))
    .slice(0, limit);
}
