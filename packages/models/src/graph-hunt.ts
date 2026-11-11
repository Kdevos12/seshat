import { hash32, type Json, sha256Hex } from "@seshat/core";
import { completeJson, isInterrupted, type Llm, type ProblemContext, withAntiSycophancy } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import type { JsonSchema } from "@seshat/registry";
import { type Battery, makeBattery, MAX_BATTERY_OBJECTS } from "./battery.ts";
import { degreeSequence, graphCertificateLean, submitGraphRefutation } from "./graph-lean.ts";
import type { GraphStatement } from "./graph-statement.ts";
import { graphObject, graphsUpToIso, isConnected, MAX_GRAPH_VERTICES } from "./graphs.ts";
import type { GraphObject } from "./objects.ts";
import { MAX_PROGRAM_LENGTH, runProgram } from "./sandbox.ts";
import { type SageRun, sageGraphBattery, sageThroughRegistry } from "./sage.ts";

const ACTOR = "line:M11";

function describeGraph(graph: GraphObject): string {
  return `the graph on ${graph.n} vertices with ${graph.edges.length === 0 ? "no edge" : `the edges ${graph.edges.map(([u, v]) => `${u}-${v}`).join(", ")}`} (graph6 ${graph.graph6})`;
}

/** Every bound of the work on graphs: constants, in one place. */
export const GRAPH_HUNT = {
  /** Graphs are listed to this many vertices by the code, and to `maxVertices` through SageMath's generator. */
  exhaustiveVertices: MAX_GRAPH_VERTICES,
  maxVertices: 10,
  /** Requests to the model for one problem, the repairs of a program and the search's rounds together (a request whose answer is malformed is retried once by `completeJson`, and both are charged). */
  modelRequests: 6,
  /** Of those, the most that repair a program that does not run. */
  repairRequests: 2,
  /** The most hits of a battery that are sent to Lean, one after the other, until one passes. */
  hits: 3,
  /** Limits of the predicate's run in the sandbox (`runPredicate`). */
  predicateCallMs: 200,
  predicateTotalMs: 60_000,
  /** Lean's answer is asked for at most this many seconds through SageMath's tool. */
  sageTimeoutSec: 300,
} as const;

/** The bounds of the search beyond the lists (CA20): names, and the values the line uses. */
export const GRAPH_SEARCH_BOUNDS = {
  /** Steps of one climb, restarts, and the wall time of the whole search in milliseconds. */
  steps: 120,
  restarts: 6,
  wallMs: 20_000,
  /** The most vertices of a graph the search builds. */
  maxVertices: 12,
  /** Moves tried in one step: the best one is taken. */
  neighbors: 24,
  /** The parameters a family is run on. */
  familyParameters: [1, 2, 3, 4, 5, 6, 7, 8],
  /** A graph whose score reaches this is a counterexample. */
  hitScore: 1,
} as const;

/** The explicit data that choose the graphs a program is tried on; recorded with every result. */
export type GraphFilter = {
  connected: boolean;
  minVertices: number;
  maxVertices: number;
  minEdges: number;
  /** Null: no upper bound. */
  maxEdges: number | null;
};

export function passesFilter(graph: { n: number; edges: readonly unknown[] } & { edges: readonly (readonly [number, number])[] }, filter: GraphFilter): boolean {
  return (
    graph.n >= filter.minVertices &&
    graph.n <= filter.maxVertices &&
    graph.edges.length >= filter.minEdges &&
    (filter.maxEdges === null || graph.edges.length <= filter.maxEdges) &&
    (!filter.connected || isConnected(graph))
  );
}

/** The filter the model asked for, made to fit the bounds; the notes say what was changed. */
export function normalizeFilter(raw: unknown, sage: boolean): { filter: GraphFilter; notes: string[] } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const notes: string[] = [];
  const int = (key: string, fallback: number, lo: number, hi: number): number => {
    const v = r[key];
    if (typeof v !== "number" || !Number.isInteger(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  };
  const ceiling = sage ? GRAPH_HUNT.maxVertices : GRAPH_HUNT.exhaustiveVertices;
  const asked = int("maxVertices", Math.min(6, ceiling), 1, GRAPH_HUNT.maxVertices);
  const maxVertices = Math.min(asked, ceiling);
  if (maxVertices < asked) notes.push(`vertices above ${ceiling} need the host's compute.sage; the filter stops at ${ceiling}`);
  const minVertices = Math.min(int("minVertices", 1, 1, GRAPH_HUNT.maxVertices), maxVertices);
  const minEdges = int("minEdges", 0, 0, 45);
  const maxEdges = typeof r.maxEdges === "number" && Number.isInteger(r.maxEdges) && r.maxEdges >= minEdges ? Math.min(45, r.maxEdges) : null;
  return { filter: { connected: r.connected === true, minVertices, maxVertices, minEdges, maxEdges }, notes };
}

/** The graphs of the filter, one for each isomorphism class: from the code to 8 vertices, from SageMath's generator above. */
export async function graphHuntBattery(
  filter: GraphFilter,
  sage: SageRun | undefined,
  signal?: AbortSignal,
): Promise<{ battery?: Battery<GraphObject>; covered: GraphFilter; notes: string[] }> {
  const notes: string[] = [];
  const objects: GraphObject[] = [];
  let coveredTo = filter.minVertices - 1;
  for (let n = filter.minVertices; n <= filter.maxVertices; n++) {
    let part: GraphObject[];
    if (n <= GRAPH_HUNT.exhaustiveVertices) {
      part = graphsUpToIso(n).filter((g) => passesFilter(g, filter));
    } else if (sage === undefined) {
      break;
    } else {
      const edges = filter.minEdges > 0 || filter.maxEdges !== null ? ` ${filter.minEdges}:${filter.maxEdges ?? ""}` : "";
      try {
        const geng = await sageGraphBattery(sage, { vertices: n, flags: `${filter.connected ? "-c" : ""}${edges}`.trim() }, signal, { maxObjects: MAX_BATTERY_OBJECTS - objects.length });
        part = geng.objects.filter((g) => passesFilter(g, filter));
      } catch (error) {
        if (isInterrupted(error) || signal?.aborted === true) throw error;
        notes.push(`the graphs on ${n} vertices were not listed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
        break;
      }
    }
    if (objects.length + part.length > MAX_BATTERY_OBJECTS) {
      notes.push(`the graphs on ${n} vertices would make more than ${MAX_BATTERY_OBJECTS} objects; the battery stops before them`);
      break;
    }
    objects.push(...part);
    coveredTo = n;
  }
  const covered: GraphFilter = { ...filter, maxVertices: Math.max(coveredTo, filter.minVertices - 1) };
  if (objects.length === 0) return { covered, notes };
  const id = `graphs:hunt:${sha256Hex(JSON.stringify(covered)).slice(0, 12)}`;
  return { battery: makeBattery({ id, family: "graphs", objects, generator: { name: "graph-hunt", params: covered } }), covered, notes };
}

// --- The search service of CA20 (written in @seshat/induction) ------------------------------------

export interface GraphSearchInput {
  problem: ProblemContext;
  /** Returns true when a graph is a counterexample. */
  predicate: string;
  /** Returns a number, higher the nearer to a counterexample; at least `hitScore` for one. */
  score: string;
  filter: GraphFilter;
  /** The seed of every draw, taken from the run's; journaled with the result. */
  seed: number;
  bounds: typeof GRAPH_SEARCH_BOUNDS;
  /** The model, through the line's access: every request is counted against the problem's cap. */
  llm: Llm;
  requestsLeft: () => number;
}

export interface GraphSearchHit {
  graph: { n: number; edges: Array<[number, number]> };
  source: "local_search" | "family";
  detail: string;
}

export interface GraphSearchResult {
  hits: GraphSearchHit[];
  /** What the search did, as data: steps, restarts, graphs scored, programs tried. */
  effort: { [key: string]: Json };
  notes: string[];
}

export type GraphSearchRunner = (input: GraphSearchInput) => Promise<GraphSearchResult>;

// --- The model's programs --------------------------------------------------------------------

const PROGRAMS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    predicate: { type: "string", minLength: 1, maxLength: MAX_PROGRAM_LENGTH, description: "One JavaScript function expression of a graph that returns true exactly when the graph is a counterexample." },
    score: { type: "string", maxLength: MAX_PROGRAM_LENGTH, description: "Optional: a JavaScript function expression of a graph that returns a number, higher when nearer to a counterexample, at least 1 exactly when the graph is one." },
    filter: {
      type: "object",
      properties: {
        connected: { type: "boolean", description: "Try connected graphs only." },
        minVertices: { type: "integer", minimum: 1, maximum: GRAPH_HUNT.maxVertices },
        maxVertices: { type: "integer", minimum: 1, maximum: GRAPH_HUNT.maxVertices },
        minEdges: { type: "integer", minimum: 0, maximum: 45 },
        maxEdges: { type: "integer", minimum: 0, maximum: 45, description: "Omit for no bound." },
      },
      required: ["connected", "minVertices", "maxVertices", "minEdges"],
      additionalProperties: false,
    },
  },
  required: ["predicate", "filter"],
  additionalProperties: false,
};

function programsPrompt(statement: GraphStatement, repair?: string): string {
  return (
    `A Lean statement about simple graphs:\n${statement.text}\n\n` +
    "A graph reaches your programs as {n, edges}: the vertices are 0..n-1 and edges is a list of [u, v] with u < v. " +
    "Write `predicate`, a JavaScript function expression of a graph that returns true exactly when the graph is a counterexample to the statement: " +
    "its hypotheses hold on the graph and its conclusion fails. Decide it by computing on the edges; it must be pure and fast, with no randomness. " +
    "Write `score` if you can, a function of a graph that returns a number, higher the nearer the graph is to a counterexample, and 1 or more exactly when it is one; a local search climbs it on graphs too large to list. " +
    "Give `filter`: whether to try connected graphs only, the range of vertices (1 to 10) and of edges, to cut the graphs the statement cannot fail on. " +
    "Your programs are run on every graph up to isomorphism in that range; a hit is checked by Lean afterwards." +
    (repair !== undefined ? `\n\nYour last predicate did not run: ${repair}. Write it again.` : "")
  );
}

/** Requests to the model for one problem, counted against `GRAPH_HUNT.modelRequests`. */
export function countedLlm(llm: Llm, cap: number): { llm: Llm; left: () => number } {
  let used = 0;
  const take = (): void => {
    if (used >= cap) throw new Error(`the cap of ${cap} model requests for graphs was reached`);
    used++;
  };
  const counted: Llm = {
    complete: async (request) => {
      take();
      return llm.complete(request);
    },
    completeJson: async (request) => {
      take();
      return completeJson(llm, request);
    },
  };
  return { llm: counted, left: () => cap - used };
}

// --- Records ---------------------------------------------------------------------------------

export const GRAPH_HIT_KIND = "graph_hit";
export const GRAPH_SEARCH_KIND = "graph_search";

export interface GraphHitData {
  graph6: string;
  n: number;
  edges: Array<[number, number]>;
  description: string;
  source: "battery" | "local_search" | "family";
  filter: GraphFilter;
  programHash: string;
  /** The hash of the certificate in the run's blob store. */
  certificate: string;
  /** `confirmed`: a Lean proof of the negation passed `validate`. `unconfirmed`: Lean did not accept one, and the hit is evidence only. */
  confirmation: "confirmed" | "unconfirmed";
  errorClass?: string;
  leanReason?: string;
  validationId?: string;
  attempts: Json;
  seed?: number;
  [key: string]: Json | undefined;
}

export interface GraphSearchData {
  method: "battery" | "local_search" | "family";
  /** `none_found`: every object had a verdict and none was a counterexample. `incomplete`: some had none. `hit`: see the hit nodes. `not_run`: why in `notes`. */
  outcome: "none_found" | "incomplete" | "hit" | "not_run";
  filter: GraphFilter;
  battery?: { id: string; size: number; digest: string };
  unknown?: number;
  programHash: string;
  statementHash: string;
  seed?: number;
  bounds?: Json;
  effort?: Json;
  notes: string[];
  [key: string]: Json | undefined;
}

function recordHit(
  problem: ProblemContext,
  input: { graph: GraphObject; source: GraphHitData["source"]; filter: GraphFilter; program: string; score?: string; statement: GraphStatement; seed?: number; detail?: string },
  attempts: Awaited<ReturnType<typeof submitGraphRefutation>>,
): GraphHitData {
  const valid = attempts.find((a) => a.verdict === "valid");
  const last = attempts[attempts.length - 1];
  const programHash = sha256Hex(input.program);
  const degrees = degreeSequence(input.graph);
  const certificate = problem.memory.blobs.putJson({
    format: "seshat.graph-counterexample/1",
    claimId: problem.claimId,
    statement: input.statement.text,
    graph6: input.graph.graph6,
    n: input.graph.n,
    edges: input.graph.edges,
    degrees,
    source: input.source,
    filter: input.filter,
    predicate: input.program,
    programHash,
    ...(input.score !== undefined ? { score: input.score } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    lean: graphCertificateLean(input.graph, { degrees, connected: isConnected(input.graph) }),
    refutation: attempts as unknown as Json,
  });
  return {
    graph6: input.graph.graph6,
    n: input.graph.n,
    edges: input.graph.edges,
    description: describeGraph(input.graph),
    source: input.source,
    filter: input.filter,
    programHash,
    certificate,
    confirmation: valid !== undefined ? "confirmed" : "unconfirmed",
    ...(valid === undefined && last?.errorClass !== undefined ? { errorClass: last.errorClass } : {}),
    ...(valid === undefined && last !== undefined ? { leanReason: (last.reasons[0] ?? last.verdict).slice(0, 300) } : {}),
    ...(valid?.validationId !== undefined ? { validationId: valid.validationId } : {}),
    attempts: attempts as unknown as Json,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
 * A hit is rechecked by Lean: the negation built from the graph goes through `validate`, and only
 * that can change the claim. The record says what came of it; a hit Lean does not accept is evidence
 * marked unconfirmed, with the class of Lean's error. Returns true when Lean accepted a proof.
 */
async function confirmHit(
  problem: ProblemContext,
  statement: GraphStatement,
  input: { graph: GraphObject; source: GraphHitData["source"]; filter: GraphFilter; program: string; score?: string; seed?: number; detail?: string },
): Promise<boolean> {
  const memory: MemoryStore = problem.memory;
  if (memory.nodes(GRAPH_HIT_KIND, { claimId: problem.claimId }).some((n) => (n.data as GraphHitData).graph6 === input.graph.graph6)) return false;
  problem.log(`M11: a program says the statement fails on ${describeGraph(input.graph)}; Lean is asked to check it`);
  const attempts = await submitGraphRefutation(problem.validate, { claimId: problem.claimId, statement, graph: input.graph });
  const data = recordHit(problem, { ...input, statement }, attempts);
  const node = memory.recordNode({ kind: GRAPH_HIT_KIND, claimId: problem.claimId, data: data as unknown as Json });
  if (data.confirmation === "confirmed") {
    memory.addEdge({
      kind: "refuted_by",
      from: problem.claimId,
      to: node.nodeId,
      status: "computed",
      note: `the statement fails on ${data.description}; a Lean proof of the negation passed the fast check (validation ${data.validationId ?? "not recorded"})`,
    });
    memory.recordObstruction({ claimId: problem.claimId, reason: "counterexample", detail: `the statement fails on ${data.description}` });
    problem.log(`M11: a proof of the negation passed the fast check (validation ${data.validationId ?? "not recorded"}); the claim is open until the certifier replays it`);
    return true;
  }
  problem.log(`M11: Lean did not accept the negation built from the graph (${data.errorClass ?? "other"}: ${data.leanReason ?? ""}); the hit stays evidence, unconfirmed`);
  return false;
}

function recordSearch(problem: ProblemContext, data: GraphSearchData): void {
  problem.memory.recordNode({ kind: GRAPH_SEARCH_KIND, claimId: problem.claimId, data: data as unknown as Json });
}

export interface GraphHuntServices {
  search?: GraphSearchRunner;
  /** A stand-in for SageMath's generator; the registry's `compute.sage` when absent and the host offers it. */
  sage?: SageRun;
}

/** The seed of a problem's draws: the run's, the problem's, and this work's name. */
export function graphSeed(problem: ProblemContext): number {
  return hash32(`${problem.seed ?? problem.runId}/${problem.problemId}/M11.graphs`);
}

/**
 * The work on a statement about graphs (CA18, CA20): the model writes a predicate (and a score), the
 * sandbox runs it on every graph of the filter, a hit goes to Lean, and "none found" is evidence with
 * the filters. If nothing was found and a score was given, the local search and the families run.
 */
export async function huntGraphs(problem: ProblemContext, statement: GraphStatement, services: GraphHuntServices): Promise<void> {
  const memory = problem.memory;
  const statementHash = sha256Hex(statement.text);
  if (memory.nodes(GRAPH_SEARCH_KIND, { claimId: problem.claimId }).some((n) => (n.data as { statementHash?: string }).statementHash === statementHash)) {
    problem.log("M11: the graphs of this statement were already tried");
    return;
  }
  const { llm, left } = countedLlm(problem.llm, GRAPH_HUNT.modelRequests);
  const sageOffered = services.sage !== undefined || (typeof problem.registry.offers === "function" && problem.registry.offers("compute.sage"));
  const sage = services.sage ?? (sageOffered ? sageThroughRegistry(problem.registry, { scope: `${problem.runId}/${problem.problemId}`, actor: ACTOR }) : undefined);
  const spent = (): boolean => problem.budget.exhausted || problem.signal.aborted;

  // 1. The programs. A predicate that does not run on a few small graphs is asked for again, twice at most.
  const probe = [1, 2, 3].flatMap((n) => graphsUpToIso(n));
  let programs: { predicate: string; score?: string; filter: unknown } | undefined;
  let repair: string | undefined;
  for (let attempt = 0; attempt <= GRAPH_HUNT.repairRequests; attempt++) {
    if (spent() || left() <= 0) break;
    try {
      const answer = await completeJson<{ predicate: string; score?: string; filter: unknown }>(llm, {
        system: withAntiSycophancy("You write short JavaScript programs that test a conjecture about graphs. Your answer is read by a program."),
        prompt: programsPrompt(statement, repair),
        schema: PROGRAMS_SCHEMA as never,
        site: "models.graph.programs",
        reuse: true,
      });
      programs = answer.value;
    } catch (error) {
      if (isInterrupted(error) || problem.signal.aborted) throw error;
      problem.log(`M11: no program for the graphs: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return;
    }
    const run = await runProgram(programs.predicate, probe, limits(), problem.signal);
    if (run.verdicts.some((v) => v !== null)) {
      repair = undefined;
      break;
    }
    repair = run.stopped ?? run.notes.find((n) => n !== undefined) ?? "it gave no verdict";
    programs = undefined;
  }
  if (programs === undefined) {
    problem.log(`M11: no predicate on graphs that runs${repair !== undefined ? ` (${repair})` : ""}`);
    return;
  }
  const programHash = sha256Hex(programs.predicate);
  const { filter, notes } = normalizeFilter(programs.filter, sageOffered);

  // 2. The battery and the run.
  const built = await graphHuntBattery(filter, sage, problem.signal);
  notes.push(...built.notes);
  if (built.battery === undefined) {
    recordSearch(problem, { method: "battery", outcome: "not_run", filter: built.covered, programHash, notes: [...notes, "no graph matches the filter"], statementHash });
    problem.log("M11: no graph matches the filter; nothing was tried");
    return;
  }
  const battery = built.battery;
  const run = await runProgram(programs.predicate, battery.objects, limits(), problem.signal);
  if (problem.signal.aborted) return;
  const hits = run.verdicts.flatMap((v, i) => (v === true ? [i] : []));
  const unknown = run.verdicts.filter((v) => v === null).length;
  const base = { filter: built.covered, battery: { id: battery.id, size: battery.objects.length, digest: battery.digest }, programHash, statementHash };
  problem.log(`M11: the predicate on ${battery.id} (${battery.objects.length} graphs): ${hits.length} hits, ${unknown} without a verdict${run.stopped !== undefined ? ` (${run.stopped})` : ""}`);

  // 3. The hits, to Lean.
  if (hits.length > 0) {
    recordSearch(problem, { ...base, method: "battery", outcome: "hit", unknown, notes });
    for (const index of hits.slice(0, GRAPH_HUNT.hits)) {
      const graph = battery.objects[index] as GraphObject;
      if (await confirmHit(problem, statement, { graph, source: "battery", filter: built.covered, program: programs.predicate, ...(programs.score !== undefined ? { score: programs.score } : {}) })) return;
      if (spent()) return;
    }
    return;
  }
  recordSearch(problem, {
    ...base,
    method: "battery",
    outcome: unknown === 0 ? "none_found" : "incomplete",
    unknown,
    notes: [...notes, "not a proof: the statement may still fail on a graph outside the filter"],
  });

  // 4. Beyond the lists.
  if (services.search === undefined || programs.score === undefined || spent() || left() <= 0) return;
  const seed = graphSeed(problem);
  const searchFilter: GraphFilter = { ...filter, maxVertices: GRAPH_SEARCH_BOUNDS.maxVertices };
  let result;
  try {
    result = await services.search({ problem, predicate: programs.predicate, score: programs.score, filter: searchFilter, seed, bounds: GRAPH_SEARCH_BOUNDS, llm, requestsLeft: left });
  } catch (error) {
    if (isInterrupted(error) || problem.signal.aborted) throw error;
    problem.log(`M11: the search beyond the lists failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return;
  }
  recordSearch(problem, {
    method: result.hits[0]?.source ?? "local_search",
    outcome: result.hits.length > 0 ? "hit" : "none_found",
    filter: searchFilter,
    programHash,
    statementHash,
    seed,
    bounds: GRAPH_SEARCH_BOUNDS as unknown as Json,
    effort: result.effort,
    notes: [...result.notes, "a search that finds nothing says nothing about the statement"],
  });
  problem.log(`M11: the search beyond the lists (seed ${seed}) found ${result.hits.length} graphs that the score calls counterexamples`);
  for (const hit of result.hits.slice(0, GRAPH_HUNT.hits)) {
    let graph: GraphObject;
    try {
      graph = graphObject(hit.graph.n, hit.graph.edges);
    } catch {
      continue;
    }
    if (await confirmHit(problem, statement, { graph, source: hit.source, filter: searchFilter, program: programs.predicate, score: programs.score, seed, detail: hit.detail })) return;
    if (spent()) return;
  }
}

function limits() {
  return { callMs: GRAPH_HUNT.predicateCallMs, totalMs: GRAPH_HUNT.predicateTotalMs };
}

/** What the line found about a claim on graphs, in words, for a session's opening message. */
export function describeGraphFindings(memory: MemoryStore, claimId: string): string | undefined {
  const hits = memory.nodes(GRAPH_HIT_KIND, { claimId }).map((n) => n.data as unknown as GraphHitData);
  const searches = memory.nodes(GRAPH_SEARCH_KIND, { claimId }).map((n) => n.data as unknown as GraphSearchData);
  if (hits.length === 0 && searches.length === 0) return undefined;
  const lines: string[] = [];
  for (const hit of hits) {
    lines.push(
      hit.confirmation === "confirmed"
        ? `A program found a counterexample, ${hit.description}, and a Lean proof of the negation built from it passed the fast check (validation ${hit.validationId ?? "not recorded"}): the statement is false as written. Do not spend the session proving it.`
        : `A program called ${hit.description} a counterexample, but Lean did not accept the negation built from it (${hit.errorClass ?? "other"}): look at the statement and the graph before relying on it.`,
    );
  }
  for (const s of searches) {
    if (s.outcome === "none_found" && s.method === "battery" && s.battery !== undefined) {
      const f = s.filter;
      lines.push(
        `No counterexample among the ${f.connected ? "connected " : ""}graphs on ${f.minVertices} to ${f.maxVertices} vertices${f.minEdges > 0 || f.maxEdges !== null ? ` with ${f.minEdges} to ${f.maxEdges ?? "any number of"} edges` : ""} (${s.battery.size} graphs up to isomorphism, a program of hash ${s.programHash.slice(0, 12)}). This is evidence and no proof, and it does not say the statement is true.`,
      );
    }
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}
