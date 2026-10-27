import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalGraph,
  fromGraph6,
  graphBattery,
  graphObject,
  graphsUpToIso,
  isConnected,
  Rng,
  toGraph6,
} from "../src/index.ts";

/** The expectation of the `graphs up to isomorphism` case of compute.sage's contract: counts that nauty gave. */
function contractCounts(): number[] {
  const path = new URL("../../../capabilities/compute.sage/contract.json", import.meta.url);
  const contract = JSON.parse(readFileSync(path, "utf8")) as { cases: Array<{ name: string; expect?: Array<{ path: string; equals: string }> }> };
  const found = contract.cases.find((c) => c.name === "graphs up to isomorphism")?.expect?.find((e) => e.path === "result")?.equals;
  assert.ok(found, "the contract of compute.sage has the case 'graphs up to isomorphism'");
  return JSON.parse(found) as number[];
}

describe("graphs up to isomorphism", () => {
  it("lists 1, 2, 4, 11, 34, 156 and 1044 graphs on 1 to 7 vertices (OEIS A000088)", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => graphsUpToIso(n).length), [1, 2, 4, 11, 34, 156, 1044]);
  });

  it("gives the counts that nauty gave in the contract of compute.sage", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => graphsUpToIso(n).length), contractCounts());
  });

  it("lists 1, 1, 2, 6, 21, 112 and 853 connected graphs on 1 to 7 vertices (OEIS A001349)", () => {
    const counts = [1, 2, 3, 4, 5, 6, 7].map((n) => graphsUpToIso(n).filter(isConnected).length);
    assert.deepEqual(counts, [1, 1, 2, 6, 21, 112, 853]);
  });

  it("lists each class once, from the empty graph to the complete one", () => {
    const graphs = graphsUpToIso(5);
    assert.equal(new Set(graphs.map((g) => g.id)).size, graphs.length);
    assert.equal(graphs[0]?.edges.length, 0);
    assert.equal(graphs.at(-1)?.edges.length, 10);
    assert.equal(graphs.filter((g) => g.edges.length === 5).length, 6);
  });

  it("puts isomorphic graphs in the same canonical form, and different ones in different forms", () => {
    const rng = new Rng(5);
    for (const n of [4, 5, 6]) {
      for (const graph of graphsUpToIso(n)) {
        const perm = rng.permutation(n);
        const renamed = graphObject(n, graph.edges.map(([u, v]) => [perm[u] as number, perm[v] as number] as [number, number]));
        assert.equal(canonicalGraph(renamed).id, graph.id);
      }
    }
    // The path on 4 vertices and the star on 4 vertices have 3 edges each but are not isomorphic.
    const path = canonicalGraph({ n: 4, edges: [[0, 1], [1, 2], [2, 3]] });
    const star = canonicalGraph({ n: 4, edges: [[0, 1], [0, 2], [0, 3]] });
    assert.notEqual(path.id, star.id);
  });

  it("writes and reads graph6", () => {
    assert.equal(toGraph6(2, [[0, 1]]), "A_");
    assert.equal(toGraph6(2, []), "A?");
    assert.equal(toGraph6(3, [[0, 1], [0, 2], [1, 2]]), "Bw");
    assert.equal(toGraph6(3, [[0, 1], [1, 2]]), "Bg");
    assert.deepEqual(fromGraph6("Bw").edges, [[0, 1], [0, 2], [1, 2]]);
    assert.deepEqual(fromGraph6(">>graph6<<Bg\n").edges, [[0, 1], [1, 2]]);
    for (const graph of graphsUpToIso(6)) assert.deepEqual(fromGraph6(graph.graph6), graph);
    assert.throws(() => fromGraph6(""), /empty graph6/);
    assert.throws(() => fromGraph6("B"), /need 1 characters/);
  });

  it("refuses loops, edges out of range, and sizes it cannot list", () => {
    assert.throws(() => graphObject(3, [[1, 1]]), /no loop/);
    assert.throws(() => graphObject(3, [[0, 3]]), /not on the vertices 0..2/);
    assert.throws(() => graphsUpToIso(9), /1 to 8 vertices/);
    assert.deepEqual(graphObject(3, [[2, 1], [1, 2], [0, 1]]).edges, [[0, 1], [1, 2]]);
  });
});

describe("the battery of graphs", () => {
  it("holds the graphs on 1 to 6 vertices, or the connected ones", () => {
    const all = graphBattery(6);
    assert.equal(all.id, "graphs:6");
    assert.equal(all.objects.length, 1 + 2 + 4 + 11 + 34 + 156);
    const connected = graphBattery(5, { connected: true });
    assert.equal(connected.id, "graphs:connected:5");
    assert.equal(connected.objects.length, 1 + 1 + 2 + 6 + 21);
    assert.equal(graphBattery(6).digest, all.digest);
  });
});
