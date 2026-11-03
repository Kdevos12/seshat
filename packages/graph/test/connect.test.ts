import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connect, MAX_CONNECT_DEPTH, proposeEdge, renderConnection, renderSubgraphAs, graphQuery } from "../src/index.ts";
import { claim, link, world } from "./helpers.ts";

/**
 *   A -implies-> B -implies-> C        A -uses-> X -uses-> C        C -special_case_of-> D -cites-> E -cites-> F -cites-> G
 *   Z stands alone.
 */
async function research() {
  const w = world();
  const [a, b, c, x, d, e, f, g, z] = (await Promise.all(["A", "B", "C", "X", "D", "E", "F", "G", "Z"].map((n) => claim(w, `: Q${n}`)))) as string[];
  await link(w, "implies", a as string, b as string);
  await link(w, "implies", b as string, c as string);
  proposeEdge(w.memory, { kind: "uses", from: a as string, to: x as string });
  proposeEdge(w.memory, { kind: "uses", from: x as string, to: c as string });
  proposeEdge(w.memory, { kind: "special_case_of", from: c as string, to: d as string });
  proposeEdge(w.memory, { kind: "cites", from: d as string, to: e as string });
  proposeEdge(w.memory, { kind: "cites", from: e as string, to: f as string });
  proposeEdge(w.memory, { kind: "cites", from: f as string, to: g as string });
  return { w, a: a as string, b: b as string, c: c as string, x: x as string, d: d as string, e: e as string, g: g as string, z: z as string };
}

describe("connect", () => {
  it("finds the paths that link two claims, by clusters of relations, either way along the edges", async () => {
    const { w, a, b, c, x } = await research();
    const found = connect(w.memory, { anchors: [a, c] });
    assert.equal(found.connected, true);
    assert.deepEqual(found.paths.map((p) => p.claims).sort(), [[a, b, c], [a, x, c]].sort());
    assert.deepEqual(found.paths.map((p) => p.cluster).sort(), ["implies> implies>", "uses> uses>"]);
    // Walked against the edges, the same paths come back reversed in direction.
    const back = connect(w.memory, { anchors: [c, a] });
    assert.deepEqual(back.paths.map((p) => p.cluster).sort(), ["implies< implies<", "uses< uses<"]);
    assert.ok(found.paths.every((p) => p.score > 0));
  });

  it("keeps the best few of each cluster, filters by kind, and respects the depth", async () => {
    const { w, a, c, b } = await research();
    assert.equal(connect(w.memory, { anchors: [a, c], perCluster: 1, kinds: ["implies"] }).paths.length, 1);
    assert.deepEqual(connect(w.memory, { anchors: [a, c], depth: 1 }).paths, []);
    assert.deepEqual(connect(w.memory, { anchors: [a, b], depth: 1 }).paths.map((p) => p.claims), [[a, b]]);
    assert.throws(() => connect(w.memory, { anchors: [a, c], depth: MAX_CONNECT_DEPTH + 1 }), /depth/);
  });

  it("reaches no further than three edges, and says which anchors it does not link", async () => {
    const { w, a, d, g, z } = await research();
    assert.equal(connect(w.memory, { anchors: [a, d] }).connected, true, "a to d is three edges");
    const far = connect(w.memory, { anchors: [a, g] });
    assert.deepEqual([far.connected, far.paths.length], [false, 0]);
    const three = connect(w.memory, { anchors: [a, d, z] });
    assert.deepEqual([three.connected, three.unreached], [false, [z]]);
    assert.match(renderConnection(three), /not linked/);
    assert.throws(() => connect(w.memory, { anchors: [a] }), /at least two/);
    assert.throws(() => connect(w.memory, { anchors: [a, "clm_missing"] }), /no claim/);
  });

  it("links three anchors when each pair has a path, and is deterministic", async () => {
    const { w, a, c, d } = await research();
    const one = connect(w.memory, { anchors: [a, c, d] });
    assert.equal(one.connected, true);
    assert.deepEqual(connect(w.memory, { anchors: [a, c, d] }), one);
  });

  it("writes paths as chains, merged lines or a table, and cuts at the edge budget", async () => {
    const { w, a, c } = await research();
    const found = connect(w.memory, { anchors: [a, c] });
    const chains = renderConnection(found, "chains");
    assert.match(chains, /2 paths, all the claims are linked/);
    assert.match(chains, /^\S+ -implies\[lean_checked\]-> \S+ -implies\[lean_checked\]-> \S+$/m);
    assert.match(renderConnection(found, "merged"), /-uses\[proposed\]-> /);
    const table = renderConnection(found, "table");
    assert.match(table, /\| from \| relation \| status \| to \|/);
    assert.equal(table.split("\n").filter((l) => /^\| \S+ \| (implies|uses) /.test(l)).length, 4);
    assert.equal(renderConnection(found, "table", { edges: 1 }).split("\n").filter((l) => /^\| \S+ \| (implies|uses) /.test(l)).length, 1);
    const named = renderConnection(found, "chains", { name: (id) => `N-${id.slice(-3)}` });
    assert.match(named, /N-/);
    const sub = renderSubgraphAs(graphQuery(w.memory, { from: a, depth: 1 }), "merged");
    assert.match(sub, /-uses\[proposed\]-> /);
  });
});
