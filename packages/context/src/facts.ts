import type { ClaimStatus } from "@seshat/core";
import { personalizedPageRank } from "@seshat/graph";
import type { MemoryStore } from "@seshat/memory";
import { SymbolIndex } from "./selectors.ts";
import { symbolsOf } from "./symbols.ts";

export interface FactOptions {
  /** The statuses a fact may have. */
  statuses: readonly ClaimStatus[];
  /** The graph neighbourhood, in edges, that the walk's score counts for; a claim farther away is found by similarity only. Widened after a failed session. */
  depth: number;
  /** The least score (0 to 1) a fact needs, even with room left. */
  threshold: number;
  /** The weight of the walk's score in the convex combination; the rest is symbol similarity. */
  graphWeight: number;
  /** The most facts. */
  limit: number;
  /** Claims never offered as facts (library lemmas, which the premises section carries). */
  exclude: ReadonlySet<string>;
}

export interface Fact {
  claimId: string;
  status: ClaimStatus;
  statement: string;
  gloss?: string;
  score: number;
  /** Normalized personalized PageRank from the target, and symbol similarity to it; the score combines them. */
  graph: number;
  similarity: number;
}

/** The claims within `depth` edges of the seeds, either way along any edge. */
function neighbourhood(memory: MemoryStore, seeds: readonly string[], depth: number): Set<string> {
  const reached = new Set(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of [...memory.edges({ from: id }), ...memory.edges({ to: id })]) {
        for (const end of [edge.from, ...edge.to]) {
          if (!reached.has(end)) {
            reached.add(end);
            next.push(end);
          }
        }
      }
    }
    frontier = next;
  }
  return reached;
}

/**
 * The useful facts (plan §4): the Lean-checked claims (by default `proved` and `computed`) ranked by a convex combination of the
 * personalized-PageRank score from the target (and the claims equivalent to it), within `depth` edges, and the similarity of
 * their statement to the goal's and the queries' symbols (the share of a fact's symbol weight the goal shares). Status breaks
 * ties toward `proved`. Nothing under `threshold` goes in. Deterministic.
 */
export function selectFacts(memory: MemoryStore, goalId: string, query: string, o: FactOptions): Fact[] {
  const goal = new Set(memory.equivalents(goalId).concat(goalId));
  // The link lemma of a checked edge is the graph's own machinery, not a fact about the problem.
  const links = new Set(memory.edges().flatMap((e) => (e.link === undefined ? [] : [e.link.statement])));
  const candidates = memory
    .claims({ statuses: o.statuses })
    .filter((c) => c.kind === "formal" && !goal.has(c.claimId) && !o.exclude.has(c.claimId) && !links.has(c.statement));
  if (candidates.length === 0) return [];
  const near = neighbourhood(memory, [...goal], o.depth);
  const walk = personalizedPageRank(memory.edges(), { seeds: [...goal] }).scores;
  const rawGraph = new Map(candidates.map((c) => [c.claimId, near.has(c.claimId) ? (walk.get(c.claimId) ?? 0) : 0]));
  const top = Math.max(0, ...rawGraph.values());
  const index = new SymbolIndex(candidates.map((c) => ({ id: c.claimId, text: c.statement })));
  const wanted = new Set(symbolsOf(query));
  const weight = (s: string) => 1 + 2 / Math.log((index.frequency.get(s) ?? 0) + 2);
  return candidates
    .map((c): Fact => {
      const symbols = index.symbols.get(c.claimId) as ReadonlySet<string>;
      let shared = 0;
      let all = 0;
      for (const s of symbols) {
        all += weight(s);
        if (wanted.has(s)) shared += weight(s);
      }
      const similarity = all === 0 ? 0 : shared / all;
      const graph = top === 0 ? 0 : (rawGraph.get(c.claimId) as number) / top;
      const score = o.graphWeight * graph + (1 - o.graphWeight) * similarity + (c.status === "proved" ? 0.02 : 0);
      return { claimId: c.claimId, status: c.status, statement: c.statement, ...(c.gloss !== undefined ? { gloss: c.gloss } : {}), score, graph, similarity };
    })
    .filter((f) => f.score >= o.threshold)
    .sort((a, b) => b.score - a.score || (a.claimId < b.claimId ? -1 : 1))
    .slice(0, Math.max(0, Math.floor(o.limit)));
}
