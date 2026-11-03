import type { ClaimStatus, EdgeKind, EdgeStatus } from "@seshat/core";
import type { Edge, MemoryStore } from "@seshat/memory";
import { personalizedPageRank } from "./pagerank.ts";
import { type Subgraph, type SubgraphClaim, ShortIds } from "./query.ts";

/** The longest path `connect` looks for, in edges. */
export const MAX_CONNECT_DEPTH = 3;

/** A query for the paths that link all the given claims (plan change PC5 item 3). */
export interface ConnectQuery {
  /** The claims to link, by id or short name: at least two. */
  anchors: readonly string[];
  kinds?: readonly EdgeKind[];
  edgeStatuses?: readonly EdgeStatus[];
  /** The statuses of claim a path may cross; the anchors are always allowed. Default: all. */
  claimStatuses?: readonly ClaimStatus[];
  /** The longest path, in edges, from 1 to 3. Default 3. */
  depth?: number;
  /** The most paths returned. Default 12. */
  maxPaths?: number;
  /** The most paths kept from each cluster (paths with the same sequence of relations). Default 2. */
  perCluster?: number;
  /** The most paths enumerated before scoring, so that a dense graph cannot blow up. Default 2000. */
  maxEnumerated?: number;
}

/** One edge of a path, in the direction the path walks it. */
export interface PathStep {
  edgeId: string;
  short: string;
  kind: EdgeKind;
  status: EdgeStatus;
  /** The claim the path leaves and the one it reaches. */
  from: string;
  to: string;
  /** True when the path walks the edge from its `from` claim to a target, false against it. */
  forward: boolean;
}

export interface ConnectedPath {
  /** The two anchors the path links, in the order of `anchors`. */
  between: [string, string];
  /** The claims on the path, from the first anchor to the second. */
  claims: string[];
  steps: PathStep[];
  /** The mean personalized-PageRank score (seeded at the anchors) of the claims on the path, per edge. */
  score: number;
  /** The path's sequence of relations and directions: paths with the same one are one cluster. */
  cluster: string;
}

export interface Connection {
  paths: ConnectedPath[];
  /** The claims on the returned paths, anchors first. */
  claims: SubgraphClaim[];
  /** True when the returned paths join all the anchors into one connected set. */
  connected: boolean;
  /** The anchors that no returned path joins to the first one. */
  unreached: string[];
  /** True when `maxEnumerated` or `maxPaths` cut the result. */
  truncated: boolean;
}

interface Hop {
  edge: Edge;
  to: string;
  forward: boolean;
}

/**
 * The paths that link all the anchors (plan change PC5 item 3; Paths-over-Graph's multi-anchor search, in code and not in
 * the model). For each pair of anchors the simple paths of at most `depth` edges are found by a bidirectional breadth-first
 * search (the two halves meet in the middle), each path is scored by the personalized PageRank of the claims it crosses from
 * the anchors, the paths are clustered by their sequence of relations, and the best few of each cluster are kept. The answer
 * says whether the returned paths join all the anchors, and which anchors they do not reach. Deterministic: ties by text.
 */
export function connect(memory: MemoryStore, query: ConnectQuery, shorts: ShortIds = new ShortIds()): Connection {
  const depth = query.depth ?? MAX_CONNECT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_CONNECT_DEPTH) throw new Error(`connect: the depth ${depth} is not a whole number from 1 to ${MAX_CONNECT_DEPTH}`);
  const maxPaths = query.maxPaths ?? 12;
  const perCluster = query.perCluster ?? 2;
  const maxEnumerated = query.maxEnumerated ?? 2000;
  for (const [name, value] of [["maxPaths", maxPaths], ["perCluster", perCluster], ["maxEnumerated", maxEnumerated]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`connect: ${name} ${value} is not a whole number from 1`);
  }
  const anchors = [
    ...new Set(
      query.anchors.map((name) => {
        const id = shorts.resolve(name) ?? name;
        if (memory.claim(id) === undefined) throw new Error(`connect: no claim ${name}`);
        return id;
      }),
    ),
  ];
  if (anchors.length < 2) throw new Error("connect: give at least two different claims to link");
  const anchorSet = new Set(anchors);
  const wanted = (edge: Edge): boolean =>
    (query.kinds === undefined || query.kinds.includes(edge.kind)) && (query.edgeStatuses === undefined || query.edgeStatuses.includes(edge.status));
  const crossable = (id: string): boolean => anchorSet.has(id) || query.claimStatuses === undefined || query.claimStatuses.includes(memory.claim(id)?.status as ClaimStatus);

  const hopsCache = new Map<string, Hop[]>();
  const hops = (id: string): Hop[] => {
    const known = hopsCache.get(id);
    if (known !== undefined) return known;
    const out: Hop[] = [];
    for (const edge of memory.edges({ from: id })) if (wanted(edge)) for (const to of edge.to) out.push({ edge, to, forward: true });
    for (const edge of memory.edges({ to: id })) if (wanted(edge)) out.push({ edge, to: edge.from, forward: false });
    const sorted = out.filter((h) => h.to !== id && crossable(h.to)).sort((a, b) => a.edge.createdSeq - b.edge.createdSeq || (a.to < b.to ? -1 : 1));
    hopsCache.set(id, sorted);
    return sorted;
  };

  // Half-paths from an anchor, by the node they end at: breadth first, up to `reach` edges.
  const expand = (start: string, reach: number): Map<string, Array<{ nodes: string[]; hops: Hop[] }>> => {
    const byEnd = new Map<string, Array<{ nodes: string[]; hops: Hop[] }>>();
    let frontier = [{ nodes: [start], hops: [] as Hop[] }];
    byEnd.set(start, [...frontier]);
    for (let level = 0; level < reach; level++) {
      const next: typeof frontier = [];
      for (const half of frontier) {
        const at = half.nodes[half.nodes.length - 1] as string;
        for (const hop of hops(at)) {
          if (half.nodes.includes(hop.to)) continue;
          next.push({ nodes: [...half.nodes, hop.to], hops: [...half.hops, hop] });
        }
      }
      for (const half of next) {
        const end = half.nodes[half.nodes.length - 1] as string;
        byEnd.set(end, [...(byEnd.get(end) ?? []), half]);
      }
      frontier = next;
      if (byEnd.size > maxEnumerated * 4) break;
    }
    return byEnd;
  };

  let truncated = false;
  const found = new Map<string, ConnectedPath>();
  const ppr = personalizedPageRank(memory.edges(), { seeds: anchors }).scores;
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const s = anchors[i] as string;
      const t = anchors[j] as string;
      const forward = expand(s, Math.ceil(depth / 2));
      const backward = expand(t, Math.floor(depth / 2));
      for (const [meet, firsts] of [...forward].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const seconds = backward.get(meet);
        if (seconds === undefined) continue;
        for (const a of firsts) {
          for (const b of seconds) {
            // Simple: the halves share only the meeting node, and no edge twice.
            const claims = [...a.nodes, ...[...b.nodes].reverse().slice(1)];
            if (new Set(claims).size !== claims.length || a.hops.length + b.hops.length === 0) continue;
            const steps: PathStep[] = [
              ...a.hops.map((h, k) => ({ edgeId: h.edge.edgeId, kind: h.edge.kind, status: h.edge.status, from: a.nodes[k] as string, to: h.to, forward: h.forward })),
              ...[...b.hops].reverse().map((h, k) => ({ edgeId: h.edge.edgeId, kind: h.edge.kind, status: h.edge.status, from: [...b.nodes].reverse()[k] as string, to: [...b.nodes].reverse()[k + 1] as string, forward: !h.forward })),
            ].map((x) => ({ ...x, short: shorts.shorten(x.edgeId) }));
            if (new Set(steps.map((x) => x.edgeId)).size !== steps.length) continue;
            const key = `${s}\u0000${t}\u0000${steps.map((x) => `${x.edgeId}${x.forward ? ">" : "<"}`).join(",")}`;
            if (found.has(key)) continue;
            if (found.size >= maxEnumerated) {
              truncated = true;
              continue;
            }
            const score = claims.reduce((sum, id) => sum + (ppr.get(id) ?? 0), 0) / steps.length;
            found.set(key, { between: [s, t], claims, steps, score, cluster: steps.map((x) => `${x.kind}${x.forward ? ">" : "<"}`).join(" ") });
          }
        }
      }
    }
  }

  const ordered = [...found].sort(([ka, a], [kb, b]) => b.score - a.score || (ka < kb ? -1 : 1));
  const taken = new Map<string, number>();
  const kept: ConnectedPath[] = [];
  for (const [, path] of ordered) {
    const key = `${path.between.join("|")}|${path.cluster}`;
    const n = taken.get(key) ?? 0;
    if (n >= perCluster) continue;
    taken.set(key, n + 1);
    kept.push(path);
  }
  // The best path of each pair is kept first, so that no pair is crowded out by the others.
  const bestOfPair = new Set<ConnectedPath>();
  for (const path of kept) if (![...bestOfPair].some((p) => p.between[0] === path.between[0] && p.between[1] === path.between[1])) bestOfPair.add(path);
  const rest = kept.filter((p) => !bestOfPair.has(p));
  const all = [...bestOfPair, ...rest];
  if (all.length > maxPaths) truncated = true;
  const paths = all.slice(0, Math.max(maxPaths, bestOfPair.size)).sort((a, b) => b.score - a.score || (a.cluster < b.cluster ? -1 : a.cluster > b.cluster ? 1 : 0));

  // Which anchors the returned paths join to the first one.
  const parent = new Map<string, string>(anchors.map((a) => [a, a]));
  const root = (x: string): string => ((parent.get(x) as string) === x ? x : root(parent.get(x) as string));
  for (const p of paths) parent.set(root(p.between[0]), root(p.between[1]));
  const unreached = anchors.filter((a) => root(a) !== root(anchors[0] as string));

  const ids = [...new Set([...anchors, ...paths.flatMap((p) => p.claims)])];
  const claims = ids.map((claimId): SubgraphClaim => {
    const claim = memory.claim(claimId) as NonNullable<ReturnType<MemoryStore["claim"]>>;
    return { claimId, short: shorts.shorten(claimId), status: claim.status, kind: claim.kind, statement: claim.statement, ...(claim.gloss !== undefined ? { gloss: claim.gloss } : {}), depth: anchorSet.has(claimId) ? 0 : 1 };
  });
  return { paths, claims, connected: unreached.length === 0, unreached, truncated };
}

/** How paths and subgraphs are written for a model (plan §13: chosen by A/B on the bench). */
export type PathStyle = "chains" | "merged" | "table";

const cut = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

interface Row {
  from: string;
  kind: EdgeKind;
  status: EdgeStatus;
  to: string;
}

/** The rows of a set of steps, each edge once, as `from kind to` in the direction it points. */
function rowsOf(steps: readonly PathStep[], name: (id: string) => string): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const s of steps) {
    if (seen.has(`${s.edgeId}\u0000${s.to}`)) continue;
    seen.add(`${s.edgeId}\u0000${s.to}`);
    rows.push(s.forward ? { from: name(s.from), kind: s.kind, status: s.status, to: name(s.to) } : { from: name(s.to), kind: s.kind, status: s.status, to: name(s.from) });
  }
  return rows;
}

/** Edges as lines grouped by (head, relation): `A -implies[lean_checked]-> B, C`, which merges what shares a head and a relation (KnowledgeNavigator). */
function mergedLines(rows: readonly Row[]): string[] {
  const groups = new Map<string, { head: string; kind: string; status: string; tails: string[] }>();
  for (const r of rows) {
    const key = `${r.from}\u0000${r.kind}\u0000${r.status}`;
    const group = groups.get(key) ?? { head: r.from, kind: r.kind, status: r.status, tails: [] };
    groups.set(key, group);
    if (!group.tails.includes(r.to)) group.tails.push(r.to);
  }
  return [...groups.values()].map((g) => `${g.head} -${g.kind}[${g.status}]-> ${g.tails.join(", ")}`);
}

function tableLines(rows: readonly Row[]): string[] {
  return ["| from | relation | status | to |", "|---|---|---|---|", ...rows.map((r) => `| ${r.from} | ${r.kind} | ${r.status} | ${r.to} |`)];
}

/**
 * A connection as text: a header that says whether the anchors are joined, the claims (id, status, statement), then the paths
 * as `chains` (one arrow chain per line, GNN-RAG), `merged` (the edges grouped by head and relation) or a markdown `table`.
 * `name` gives the id a model reads for a claim id (default: the claim's short name), `edges` caps the edges shown.
 */
export function renderConnection(connection: Connection, style: PathStyle = "chains", options: { statementWidth?: number; edges?: number; name?: (claimId: string) => string } = {}): string {
  const width = options.statementWidth ?? 120;
  const byId = new Map(connection.claims.map((c) => [c.claimId, c]));
  const name = options.name ?? ((id: string) => byId.get(id)?.short ?? id);
  const lines: string[] = [];
  const n = connection.paths.length;
  lines.push(
    connection.paths.length === 0
      ? "No path links these claims within the depth."
      : `${n} path${n === 1 ? "" : "s"}${connection.connected ? ", all the claims are linked" : `, not linked: ${connection.unreached.map(name).join(", ")}`}${connection.truncated ? " (cut: more exist)" : ""}`,
  );
  for (const c of connection.claims) lines.push(`${name(c.claimId)}  ${c.status}  ${cut(c.statement, width)}${c.gloss !== undefined ? `  -- ${cut(c.gloss, width)}` : ""}`);
  let budget = options.edges ?? Number.POSITIVE_INFINITY;
  if (style === "chains") {
    for (const p of connection.paths) {
      if (budget <= 0) break;
      const steps = p.steps.slice(0, budget);
      budget -= steps.length;
      lines.push(steps.reduce((text, s, k) => `${text}${s.forward ? ` -${s.kind}[${s.status}]-> ` : ` <-${s.kind}[${s.status}]- `}${name(s.to)}`, name(p.steps[0]?.from ?? p.claims[0] as string)).concat(steps.length < p.steps.length ? " …" : ""));
    }
    return lines.join("\n");
  }
  const rows = rowsOf(connection.paths.flatMap((p) => p.steps), name).slice(0, budget);
  return [...lines, ...(style === "merged" ? mergedLines(rows) : tableLines(rows))].join("\n");
}

/** A subgraph with its edges written as `merged` lines or a markdown `table`; `list` is `renderSubgraph`'s own form. */
export function renderSubgraphAs(subgraph: Subgraph, style: "merged" | "table", options: { statementWidth?: number; edges?: number; name?: (claimId: string) => string } = {}): string {
  const width = options.statementWidth ?? 120;
  const name = options.name ?? ((id: string) => subgraph.claims.find((c) => c.claimId === id)?.short ?? id);
  const count = (k: number, noun: string) => `${k} ${noun}${k === 1 ? "" : "s"}`;
  const lines = [`${count(subgraph.claims.length, "claim")}, ${count(subgraph.edges.length, "edge")}${subgraph.truncated ? " (cut: more exist)" : ""}`];
  for (const c of subgraph.claims) lines.push(`${name(c.claimId)}  ${c.status}  ${cut(c.statement, width)}${c.gloss !== undefined ? `  -- ${cut(c.gloss, width)}` : ""}`);
  const rows: Row[] = subgraph.edges.flatMap((e) => e.to.map((to) => ({ from: name(e.from), kind: e.kind, status: e.status, to: name(to) }))).slice(0, options.edges ?? Number.POSITIVE_INFINITY);
  return [...lines, ...(style === "merged" ? mergedLines(rows) : tableLines(rows))].join("\n");
}
