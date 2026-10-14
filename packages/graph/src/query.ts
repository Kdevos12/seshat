import { type ClaimKind, type ClaimStatus, type EdgeKind, type EdgeStatus, isClaimStatus, isEdgeKind, isEdgeStatus } from "@seshat/core";
import type { Edge, MemoryStore } from "@seshat/memory";

/**
 * Short names for ids, so that a subgraph fits in a prompt: the last characters of the id, as many
 * as it takes to tell it from every id given a name before (at least four). A name once given is
 * never changed, and `resolve` turns it back into the id. Keep one for as long as the names must
 * stay valid, for instance for the length of a session.
 */
export class ShortIds {
  private readonly names = new Map<string, string>();
  private readonly owners = new Map<string, string>();

  shorten(id: string): string {
    const known = this.names.get(id);
    if (known !== undefined) return known;
    const body = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
    let short = id;
    for (let length = Math.min(4, body.length); length <= body.length; length++) {
      const candidate = body.slice(-length);
      if (!this.owners.has(candidate)) {
        short = candidate;
        break;
      }
    }
    this.names.set(id, short);
    this.owners.set(short, id);
    return short;
  }

  /** The id a name stands for, or undefined if it was never given. A whole id resolves to itself when it is known. */
  resolve(name: string): string | undefined {
    return this.owners.get(name) ?? (this.names.has(name) ? name : undefined);
  }
}

/** A typed path query: where to start, which edges a path may follow, how far. */
export interface GraphQuery {
  /** The claims the paths start from, by id or by short name. */
  from: string | readonly string[];
  /** The kinds of edge a path may follow. Default: all. */
  kinds?: readonly EdgeKind[];
  /** The statuses of edge a path may follow. Default: all. */
  edgeStatuses?: readonly EdgeStatus[];
  /**
   * The statuses of claim a path may go through. A claim with another status is neither returned
   * nor crossed; the claims it starts from are always returned. Default: all.
   */
  claimStatuses?: readonly ClaimStatus[];
  /** `out` follows an edge from its `from` claim to its targets, `in` the other way, `both` (default) either. */
  direction?: "out" | "in" | "both";
  /** The longest path, in edges. Default 2. */
  depth?: number;
  /** The most claims returned. Default 50. */
  limit?: number;
}

export interface SubgraphClaim {
  claimId: string;
  short: string;
  status: ClaimStatus;
  kind: ClaimKind;
  statement: string;
  gloss?: string;
  /** The length of the shortest path from the start, 0 for a start claim. */
  depth: number;
}

export interface SubgraphEdge {
  edgeId: string;
  short: string;
  kind: EdgeKind;
  status: EdgeStatus;
  from: string;
  to: string[];
  /** The claims at the ends, by short name. */
  fromShort: string;
  toShort: string[];
}

/** The claims and edges the paths of a query reach. Every edge has all its ends among the claims. */
export interface Subgraph {
  claims: SubgraphClaim[];
  edges: SubgraphEdge[];
  /** True when `limit` cut the result. */
  truncated: boolean;
}

/**
 * The subgraph a typed path query reaches (plan §3.2): from the start claims, breadth first, along
 * the edges of the given kinds and statuses, through the claims of the given statuses, up to `depth`
 * edges. It reads the memory and nothing else. Only the edges a path follows are returned, not every
 * edge between the claims found. Ordered by depth, then by id, so that the same graph gives the same
 * text.
 */
export function graphQuery(memory: MemoryStore, query: GraphQuery, shorts: ShortIds = new ShortIds()): Subgraph {
  const depth = query.depth ?? 2;
  const limit = query.limit ?? 50;
  if (!Number.isInteger(depth) || depth < 0) throw new Error(`graphQuery: the depth ${depth} is not a whole number from 0`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`graphQuery: the limit ${limit} is not a whole number from 1`);
  const direction = query.direction ?? "both";
  const starts = (typeof query.from === "string" ? [query.from] : query.from).map((name) => {
    const id = shorts.resolve(name) ?? name;
    if (memory.claim(id) === undefined) throw new Error(`graphQuery: no claim ${name}`);
    return id;
  });
  if (starts.length === 0) throw new Error("graphQuery: nothing to start from");

  const reached = new Map<string, number>(starts.map((id) => [id, 0]));
  const followed = new Map<string, Edge>();
  const wanted = (edge: Edge): boolean =>
    (query.kinds === undefined || query.kinds.includes(edge.kind)) && (query.edgeStatuses === undefined || query.edgeStatuses.includes(edge.status));
  const crossable = (id: string): boolean => {
    const claim = memory.claim(id);
    return claim !== undefined && (query.claimStatuses === undefined || query.claimStatuses.includes(claim.status));
  };
  let truncated = false;
  const queue = [...reached.keys()];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const here = reached.get(id) as number;
    if (here >= depth) continue;
    const around = [
      ...(direction !== "in" ? memory.edges({ from: id }) : []),
      ...(direction !== "out" ? memory.edges({ to: id }) : []),
    ];
    for (const edge of around.sort((a, b) => a.createdSeq - b.createdSeq)) {
      if (followed.has(edge.edgeId) || !wanted(edge)) continue;
      const ends = [edge.from, ...edge.to];
      const fresh = ends.filter((end) => !reached.has(end));
      if (!fresh.every(crossable)) continue;
      if (reached.size + new Set(fresh).size > limit) {
        truncated = true;
        continue;
      }
      followed.set(edge.edgeId, edge);
      for (const end of fresh) {
        if (reached.has(end)) continue;
        reached.set(end, here + 1);
        queue.push(end);
      }
    }
  }

  const claims = [...reached]
    .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : 1))
    .map(([claimId, at]): SubgraphClaim => {
      const claim = memory.claim(claimId) as NonNullable<ReturnType<MemoryStore["claim"]>>;
      return {
        claimId,
        short: shorts.shorten(claimId),
        status: claim.status,
        kind: claim.kind,
        statement: claim.statement,
        ...(claim.gloss !== undefined ? { gloss: claim.gloss } : {}),
        depth: at,
      };
    });
  const edges = [...followed.values()]
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((edge): SubgraphEdge => ({
      edgeId: edge.edgeId,
      short: shorts.shorten(edge.edgeId),
      kind: edge.kind,
      status: edge.status,
      from: edge.from,
      to: edge.to,
      fromShort: shorts.shorten(edge.from),
      toShort: edge.to.map((id) => shorts.shorten(id)),
    }));
  return { claims, edges, truncated };
}

/**
 * A subgraph as the text a model reads: one line per claim (short name, status, statement), then
 * one per edge (`from -kind[status]-> to`). `statementWidth` cuts long statements.
 */
export function renderSubgraph(subgraph: Subgraph, options: { statementWidth?: number } = {}): string {
  const width = options.statementWidth ?? 120;
  const cut = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  };
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const lines = [`${count(subgraph.claims.length, "claim")}, ${count(subgraph.edges.length, "edge")}${subgraph.truncated ? " (cut: more exist)" : ""}`];
  for (const claim of subgraph.claims) lines.push(`${claim.short}  ${claim.status}  ${cut(claim.statement)}${claim.gloss !== undefined ? `  -- ${cut(claim.gloss)}` : ""}`);
  for (const edge of subgraph.edges) lines.push(`${edge.fromShort} -${edge.kind}[${edge.status}]-> ${edge.toShort.join(", ")}`);
  return lines.join("\n");
}

/**
 * Reads a query written as JSON (the arguments of the `graph_neighbors` tool), checking every field.
 * `claim` is the start used when the query does not name one.
 */
export function parseGraphQuery(args: Readonly<Record<string, unknown>>, claim?: string): GraphQuery {
  const list = <T extends string>(key: string, is: (value: unknown) => value is T): T[] | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every(is)) throw new Error(`${key} must be a list of valid values`);
    return value;
  };
  const start = args.from ?? args.claim ?? claim;
  if (typeof start !== "string" && !(Array.isArray(start) && start.every((s) => typeof s === "string"))) throw new Error("from must be a claim id, or a list of them");
  const number = (key: string): number | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw new Error(`${key} must be a number`);
    return value;
  };
  const direction = args.direction;
  if (direction !== undefined && direction !== "out" && direction !== "in" && direction !== "both") throw new Error("direction must be out, in or both");
  const kinds = list("kinds", isEdgeKind);
  const edgeStatuses = list("edgeStatuses", isEdgeStatus);
  const claimStatuses = list("claimStatuses", isClaimStatus);
  const depth = number("depth");
  const limit = number("limit");
  return {
    from: start as string | string[],
    ...(kinds !== undefined ? { kinds } : {}),
    ...(edgeStatuses !== undefined ? { edgeStatuses } : {}),
    ...(claimStatuses !== undefined ? { claimStatuses } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}
