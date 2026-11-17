import { type Json, type RandomSource, seeded } from "@seshat/core";
import { type GraphSearchHit, type GraphSearchInput, type GraphSearchResult, type GraphSearchRunner, passesFilter } from "@seshat/models";
import { type SearchOptions, type SearchSpec, makeScorer, runSearch } from "./evolve.ts";
import { booleans, numbers, runValues } from "./sandbox.ts";

/**
 * The search beyond the lists of graphs (plan change CA20), for line M11. Two searches, both driven by
 * programs a model wrote and run in this package's sandbox (`runValues`):
 *
 * - a local search: hill climbing with restarts over graphs, whose moves add or remove an edge, add or
 *   remove a vertex (within the filter's vertex range), and whose score is the model's program. The
 *   draws come from a source seeded with `input.seed`, which M11 journals, so the same seed and the
 *   same score give the same search and the same graph, unless the wall time bound cuts it;
 * - families: M16's program search (`runSearch`, the same database of programs in islands, the same
 *   prompt and sandbox) asked for programs that map a parameter to a graph, scored by the model's graph
 *   score; each program valid on the small parameters is run on them and its graphs are tested with
 *   the predicate.
 *
 * Neither changes a status: a graph that comes out is handed back, and M11 sends it to Lean.
 */

type Graph = { n: number; edges: Array<[number, number]> };

const key = (u: number, v: number): string => `${u},${v}`;

function normalize(n: number, edges: Iterable<[number, number]>): Graph {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    const [u, v] = a < b ? [a, b] : [b, a];
    if (u === v || u < 0 || v >= n || seen.has(key(u, v))) continue;
    seen.add(key(u, v));
    out.push([u, v]);
  }
  return { n, edges: out.sort((x, y) => x[0] - y[0] || x[1] - y[1]) };
}

function pick(random: RandomSource, count: number): number {
  return Math.min(count - 1, Math.floor(random() * count));
}

/** A graph one move from another: an edge added or removed, a vertex added (with one or two edges) or removed. */
export function neighbor(graph: Graph, random: RandomSource, minVertices: number, maxVertices: number): Graph {
  for (let attempt = 0; attempt < 20; attempt++) {
    const move = pick(random, 4);
    const { n, edges } = graph;
    if (move === 0 && n >= 2) {
      const u = pick(random, n);
      const v = pick(random, n);
      if (u === v || edges.some(([a, b]) => key(a, b) === key(Math.min(u, v), Math.max(u, v)))) continue;
      return normalize(n, [...edges, [u, v]]);
    }
    if (move === 1 && edges.length > 0) {
      const drop = pick(random, edges.length);
      return { n, edges: edges.filter((_, i) => i !== drop) };
    }
    if (move === 2 && n < maxVertices) {
      const added: Array<[number, number]> = [[pick(random, n), n]];
      if (random() < 0.5) added.push([pick(random, n), n]);
      return normalize(n + 1, [...edges, ...added]);
    }
    if (move === 3 && n > minVertices) {
      const gone = pick(random, n);
      const rename = (x: number): number => (x > gone ? x - 1 : x);
      return normalize(n - 1, edges.filter(([a, b]) => a !== gone && b !== gone).map(([a, b]) => [rename(a), rename(b)] as [number, number]));
    }
  }
  return graph;
}

function start(random: RandomSource, minVertices: number, maxVertices: number): Graph {
  const n = minVertices + pick(random, maxVertices - minVertices + 1);
  const edges: Array<[number, number]> = [];
  const p = 0.2 + random() * 0.4;
  for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) if (random() < p) edges.push([u, v]);
  return { n, edges };
}

/** Hill climbing with restarts, on the model's score. Each step scores `neighbors` moves in one sandbox run and takes the best, sideways included. */
export async function localSearch(input: GraphSearchInput, deadline: number): Promise<{ hit?: GraphSearchHit; effort: { [key: string]: Json } }> {
  const { bounds, filter, problem } = input;
  const random = seeded(input.seed);
  const limits = { callMs: bounds.callMs ?? 500, totalMs: 15_000, memoryMb: 128, seed: input.seed };
  const minV = Math.max(1, filter.minVertices);
  const maxV = Math.min(bounds.maxVertices, filter.maxVertices);
  let steps = 0;
  let scored = 0;
  let restarts = 0;
  let best = -Infinity;
  const effort = (): { [key: string]: Json } => ({ steps, restarts, scored, bestScore: Number.isFinite(best) ? best : null });
  const score = async (graphs: Graph[]): Promise<Array<number | null>> => {
    const run = await runValues(input.score, graphs, limits, problem.signal);
    scored += graphs.length;
    return numbers(run);
  };
  // Every field of the recorded filter is applied: vertices, edges, connectivity.
  const allowed = (g: Graph): boolean => passesFilter(g, filter);
  for (restarts = 1; restarts <= bounds.restarts; restarts++) {
    let current = start(random, minV, maxV);
    let currentScore = (await score([current]))[0] ?? -Infinity;
    best = Math.max(best, currentScore);
    if (currentScore >= bounds.hitScore && allowed(current)) return { hit: { graph: current, source: "local_search", detail: `restart ${restarts}, step 0` }, effort: effort() };
    let stale = 0;
    for (let step = 1; step <= bounds.steps && stale < 25; step++) {
      if (Date.now() > deadline || problem.signal.aborted || problem.budget.exhausted) return { effort: effort() };
      steps++;
      const moves = Array.from({ length: bounds.neighbors }, () => neighbor(current, random, minV, maxV));
      const scores = await score(moves);
      let chosen = -1;
      for (let i = 0; i < moves.length; i++) {
        const s = scores[i];
        if (s === null || s === undefined) continue;
        if (s >= bounds.hitScore && allowed(moves[i] as Graph)) return { hit: { graph: moves[i] as Graph, source: "local_search", detail: `restart ${restarts}, step ${step}` }, effort: effort() };
        if (chosen < 0 || s > (scores[chosen] as number)) chosen = i;
      }
      if (chosen < 0) {
        stale++;
        continue;
      }
      const s = scores[chosen] as number;
      if (s < currentScore) {
        stale++;
        continue;
      }
      stale = s > currentScore ? 0 : stale + 1;
      current = moves[chosen] as Graph;
      currentScore = s;
      best = Math.max(best, s);
    }
  }
  restarts = bounds.restarts;
  return { effort: effort() };
}

const FAMILY_OPTIONS: SearchOptions = { islands: 1, rounds: 2, samples: 2, shown: 1, temperature: 0.5, lengthBias: 1, resetEvery: 0, clusterSize: 4, limits: { callMs: 500, totalMs: 15_000, memoryMb: 128 } };

/** The graph a program built, when its value is {n, edges} within the bound. */
function graphOf(value: Json | undefined, maxVertices: number): Graph | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { n, edges } = value as { n?: Json; edges?: Json };
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > maxVertices || !Array.isArray(edges)) return undefined;
  const pairs: Array<[number, number]> = [];
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isInteger(e[0]) || !Number.isInteger(e[1])) return undefined;
    pairs.push([e[0] as number, e[1] as number]);
  }
  return normalize(n, pairs);
}

/** Families: M16's program search for programs that map a parameter to a graph; their graphs on the small parameters are tested with the predicate. */
export async function familySearch(input: GraphSearchInput, deadline: number): Promise<{ hit?: GraphSearchHit; effort: { [key: string]: Json } }> {
  const { problem, bounds, filter } = input;
  const parameters = [...bounds.familyParameters];
  const spec: SearchSpec = {
    description:
      "build a family of graphs: a program that maps a parameter k to a graph {n, edges} (vertices 0..n-1, edges a list of [u, v] with u < v), " +
      "for k from 1 to 8, so that a member is a counterexample to the conjecture; the score rates each graph (1 or more is a counterexample) and is summed over the parameters",
    signature: "(k) => ({ n: <number of vertices, at most " + bounds.maxVertices + ">, edges: [[u, v], ...] })",
    inputs: parameters,
    score: `(io) => { var s = (${input.score})(io.output); return typeof s === "number" ? s : null; }`,
    seeds: ["(k) => ({ n: k + 1, edges: Array.from({ length: k }, (_, i) => [i, i + 1]) })"],
    witnessInput: parameters[parameters.length - 1] as number,
  };
  const limits = { ...FAMILY_OPTIONS.limits, seed: input.seed };
  const scorer = makeScorer(spec, limits);
  const tried = new Set<string>();
  const programs: string[] = [];
  const result = await runSearch(input.llm, spec, FAMILY_OPTIONS, scorer, seeded(input.seed), {
    signal: problem.signal,
    shouldStop: () => input.requestsLeft() <= 0 || problem.budget.exhausted || Date.now() > deadline,
    events: {
      program: (e) => {
        if (e.evaluation.ok && !tried.has(e.code)) {
          tried.add(e.code);
          programs.push(e.code);
        }
      },
    },
  });
  let hit: GraphSearchHit | undefined;
  let tested = 0;
  for (const code of programs) {
    if (hit !== undefined || problem.signal.aborted) break;
    const built = await runValues(code, parameters, limits, problem.signal);
    const graphs: Array<{ k: number; graph: Graph }> = [];
    built.values.forEach((value, i) => {
      const graph = graphOf(value, bounds.maxVertices);
      if (graph !== undefined && passesFilter(graph, filter)) graphs.push({ k: parameters[i] as number, graph });
    });
    if (graphs.length === 0) continue;
    const verdicts = booleans(await runValues(input.predicate, graphs.map((g) => g.graph), limits, problem.signal));
    tested += graphs.length;
    const at = verdicts.findIndex((v) => v === true);
    if (at >= 0) {
      const found = graphs[at] as { k: number; graph: Graph };
      hit = { graph: found.graph, source: "family", detail: `parameter ${found.k} of the family ${code.slice(0, 200)}` };
    }
  }
  return { ...(hit !== undefined ? { hit } : {}), effort: { familyPrograms: programs.length, familyGraphs: tested, familyRounds: result.rounds, familyBest: result.best?.score ?? null } };
}

/** The search M11 calls when the lists found nothing: the local search, then the families, within the wall time. */
export const graphSearch: GraphSearchRunner = async (input): Promise<GraphSearchResult> => {
  const deadline = Date.now() + input.bounds.wallMs;
  const notes: string[] = [];
  const hits: GraphSearchHit[] = [];
  const local = await localSearch(input, deadline);
  if (local.hit !== undefined) hits.push(local.hit);
  let family: { hit?: GraphSearchHit; effort: { [key: string]: Json } } = { effort: {} };
  if (hits.length === 0 && input.requestsLeft() > 0 && !input.problem.budget.exhausted && Date.now() < deadline) {
    family = await familySearch(input, deadline);
    if (family.hit !== undefined) hits.push(family.hit);
  } else if (hits.length === 0) notes.push("the families were not tried: no model request, budget or time left");
  return { hits, effort: { ...local.effort, ...family.effort, seed: input.seed }, notes };
};

