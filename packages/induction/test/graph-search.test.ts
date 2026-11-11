import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seeded } from "@seshat/core";
import type { Llm, ProblemContext } from "@seshat/lines";
import { GRAPH_SEARCH_BOUNDS, type GraphSearchInput } from "@seshat/models";
import { familySearch, localSearch, neighbor } from "../src/graph-search.ts";

/** Counterexample: exactly 6 vertices and 7 edges. The score is nearer the closer a graph is. */
const PLANTED_SCORE = "(g) => (g.n === 6 && g.edges.length === 7 ? 1 : 0.9 / (1 + Math.abs(g.n - 6) + Math.abs(g.edges.length - 7)))";
const PLANTED_PREDICATE = "(g) => g.n === 6 && g.edges.length === 7";

function inputOf(over: Partial<GraphSearchInput> = {}, llm?: Llm): GraphSearchInput {
  const problem = { signal: new AbortController().signal, budget: { exhausted: false } } as unknown as ProblemContext;
  return {
    problem,
    predicate: PLANTED_PREDICATE,
    score: PLANTED_SCORE,
    filter: { connected: false, minVertices: 1, maxVertices: 9, minEdges: 0, maxEdges: null },
    seed: 12345,
    bounds: { ...GRAPH_SEARCH_BOUNDS, steps: 60, restarts: 4 },
    llm: llm ?? ({ complete: async () => { throw new Error("no model"); } } as Llm),
    requestsLeft: () => 0,
    ...over,
  };
}

describe("the local search over graphs", () => {
  it("finds a planted counterexample with a fixed seed, and replays to the same graph", async () => {
    const deadline = Date.now() + 60_000;
    const first = await localSearch(inputOf(), deadline);
    const second = await localSearch(inputOf(), deadline);
    assert.ok(first.hit !== undefined, "a hit");
    assert.equal(first.hit?.graph.n, 6);
    assert.equal(first.hit?.graph.edges.length, 7);
    assert.deepEqual(second.hit?.graph, first.hit?.graph);
    assert.deepEqual(second.effort, first.effort);
  });

  it("stays within its bounds: nothing found when none exists, and no graph out of the vertex range", async () => {
    const nothing = await localSearch(inputOf({ score: "(g) => 0.1", bounds: { ...GRAPH_SEARCH_BOUNDS, steps: 3, restarts: 2 } }), Date.now() + 30_000);
    assert.equal(nothing.hit, undefined);
    assert.equal(nothing.effort.restarts, 2);
    const random = seeded(3);
    let g = { n: 3, edges: [[0, 1]] as Array<[number, number]> };
    for (let i = 0; i < 300; i++) {
      g = neighbor(g, random, 2, 5);
      assert.ok(g.n >= 2 && g.n <= 5);
      assert.ok(g.edges.every(([u, v]) => u < v && v < g.n));
    }
  });
});

describe("the families", () => {
  it("runs a program the model proposes on small parameters and tests each graph with the predicate", async () => {
    let calls = 0;
    const llm = {
      complete: async () => ({ text: "", cost: { usd: 0 }, model: "p/m", modelCallId: "m" }),
      completeJson: async () => {
        calls++;
        // The star on k + 1 vertices: a family whose member k = 3 is K_{1,3}.
        return { value: { program: "(k) => ({ n: k + 1, edges: Array.from({ length: k }, (_, i) => [0, i + 1]) })" }, text: "", cost: { usd: 0 }, model: "p/m", modelCallIds: [] };
      },
    } as unknown as Llm;
    const found = await familySearch(
      inputOf({ predicate: "(g) => g.n === 4 && g.edges.length === 3 && g.edges.every((e) => e[0] === 0)", score: "(g) => 0.1", llm, requestsLeft: () => 4 }),
      Date.now() + 60_000,
    );
    assert.ok(calls >= 1);
    assert.equal(found.hit?.source, "family");
    assert.deepEqual(found.hit?.graph, { n: 4, edges: [[0, 1], [0, 2], [0, 3]] });
  });
});

describe("the filter is applied in full on both paths", () => {
  it("local search: a hit has the edges and vertices the recorded filter says", async () => {
    const filter = { connected: false, minVertices: 4, maxVertices: 8, minEdges: 5, maxEdges: 7 };
    const found = await localSearch(inputOf({ filter, score: "(g) => 1" }), Date.now() + 30_000);
    const g = found.hit?.graph;
    assert.ok(g !== undefined);
    assert.ok(g.n >= 4 && g.n <= 8 && g.edges.length >= 5 && g.edges.length <= 7, JSON.stringify(g));
  });

  it("families: a graph below the vertex or edge minimum is not a hit", async () => {
    const llm = {
      complete: async () => ({ text: "", cost: { usd: 0 }, model: "p/m", modelCallId: "m" }),
      completeJson: async () => ({ value: { program: "(k) => ({ n: k + 1, edges: Array.from({ length: k }, (_, i) => [i, i + 1]) })" }, text: "", cost: { usd: 0 }, model: "p/m", modelCallIds: [] }),
    } as unknown as Llm;
    const filter = { connected: true, minVertices: 3, maxVertices: 12, minEdges: 4, maxEdges: null };
    const found = await familySearch(inputOf({ filter, predicate: "(g) => true", score: "(g) => 0", llm, requestsLeft: () => 2 }), Date.now() + 60_000);
    assert.equal(found.hit?.graph.edges.length, 4);
    assert.equal(found.hit?.graph.n, 5);
  });
});

describe("the sandbox limits reach the search", () => {
  it("cuts a score that loops, without a hit", async () => {
    const started = Date.now();
    const found = await localSearch(inputOf({ score: "(g) => { while (true) {} }", bounds: { ...GRAPH_SEARCH_BOUNDS, steps: 2, restarts: 1, neighbors: 2, callMs: 30 } }), Date.now() + 30_000);
    assert.equal(found.hit, undefined);
    assert.ok(Date.now() - started < 20_000);
  });
});
