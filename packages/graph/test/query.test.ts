import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphQuery, parseGraphQuery, proposeEdge, renderSubgraph, ShortIds } from "../src/index.ts";
import { claim, link, prove, world, type World } from "./helpers.ts";

/**
 *   S -strengthens-> R (checked)      N -negation_of-> R (proposed)
 *   U -special_case_of-> S (proposed) W -implies-> U (checked)      R -decomposes_into-> [P1, P2] (proposed)
 */
async function research(w: World) {
  const [r, s, n, u, wc, p1, p2] = (await Promise.all(["R", "S", "N", "U", "W", "P1", "P2"].map((x) => claim(w, `: Q${x}`)))) as string[] as [string, string, string, string, string, string, string];
  const strengthens = await link(w, "strengthens", s, r);
  proposeEdge(w.memory, { kind: "negation_of", from: n, to: r });
  proposeEdge(w.memory, { kind: "special_case_of", from: u, to: s });
  await link(w, "implies", wc, u);
  proposeEdge(w.memory, { kind: "decomposes_into", from: r, to: [p1, p2] });
  return { r, s, n, u, w: wc, p1, p2, strengthens };
}
const ids = (found: { claims: Array<{ claimId: string }> }) => found.claims.map((c) => c.claimId);

describe("graph queries", () => {
  it("reach the claims within a depth, along edges either way, with the depth of each", async () => {
    const w = world();
    const g = await research(w);
    const one = graphQuery(w.memory, { from: g.r, depth: 1 });
    assert.deepEqual(ids(one).sort(), [g.r, g.s, g.n, g.p1, g.p2].sort());
    assert.deepEqual(one.claims.map((c) => c.depth), [0, 1, 1, 1, 1]);
    assert.equal(one.edges.length, 3, "the strengthening, the negation and the decomposition");
    assert.equal(one.truncated, false);
    // The hyperedge has all its ends among the claims.
    const decomposition = one.edges.find((e) => e.kind === "decomposes_into");
    assert.deepEqual([decomposition?.from, decomposition?.to], [g.r, [g.p1, g.p2]]);
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, depth: 0 })), [g.r]);

    const two = graphQuery(w.memory, { from: g.r });
    assert.deepEqual(ids(two).sort(), [g.r, g.s, g.n, g.u, g.p1, g.p2].sort(), "the default depth is two");
    assert.equal(two.claims.find((c) => c.claimId === g.u)?.depth, 2);
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, depth: 9 })).length, 7);
    w.close();
  });

  it("follow only the kinds and statuses asked, and the direction asked", async () => {
    const w = world();
    const g = await research(w);
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, kinds: ["strengthens"], depth: 5 })).sort(), [g.r, g.s].sort());
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, kinds: ["strengthens", "special_case_of", "implies"], depth: 5 })).sort(), [g.r, g.s, g.u, g.w].sort());
    // Only checked edges: the path stops where the first proposed edge is.
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, edgeStatuses: ["lean_checked"], depth: 5 })).sort(), [g.r, g.s].sort());
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.w, edgeStatuses: ["lean_checked"], depth: 5 })).sort(), [g.w, g.u].sort());
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, direction: "out" })).sort(), [g.r, g.p1, g.p2].sort());
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.r, direction: "in", depth: 1 })).sort(), [g.r, g.s, g.n].sort());
    assert.deepEqual(ids(graphQuery(w.memory, { from: g.p1, direction: "in", depth: 1 })).sort(), [g.p1, g.r, g.p2].sort(), "the other parts come with the whole");
    // Several starts.
    assert.deepEqual(ids(graphQuery(w.memory, { from: [g.n, g.w], depth: 0 })).sort(), [g.n, g.w].sort());
    w.close();
  });

  it("go only through the claims of the statuses asked", async () => {
    const w = world();
    const g = await research(w);
    await prove(w, g.s);
    const open = graphQuery(w.memory, { from: g.r, claimStatuses: ["open"], depth: 3 });
    assert.deepEqual(ids(open).sort(), [g.r, g.n, g.p1, g.p2].sort(), "S is computed: it is not crossed, so U and W are out of reach");
    const computed = graphQuery(w.memory, { from: g.r, claimStatuses: ["computed"], depth: 3 });
    assert.deepEqual(ids(computed).sort(), [g.r, g.s].sort(), "the start claim is returned whatever its status");
    assert.equal(computed.claims.find((c) => c.claimId === g.s)?.status, "computed");
    w.close();
  });

  it("stop at the limit, and say so", async () => {
    const w = world();
    const g = await research(w);
    const cut = graphQuery(w.memory, { from: g.r, limit: 3 });
    // The edges are taken in the order they were added; the decomposition would bring two claims at once.
    assert.deepEqual(ids(cut).sort(), [g.r, g.s, g.n].sort());
    assert.equal(cut.truncated, true);
    assert.equal(cut.edges.length, 2);
    assert.throws(() => graphQuery(w.memory, { from: g.r, limit: 0 }), /limit/);
    assert.throws(() => graphQuery(w.memory, { from: g.r, depth: -1 }), /depth/);
    assert.throws(() => graphQuery(w.memory, { from: [] }), /nothing to start from/);
    assert.throws(() => graphQuery(w.memory, { from: "clm_nowhere" }), /no claim clm_nowhere/);
    w.close();
  });

  it("name claims and edges by short ids that stay valid and can be used to go on", async () => {
    const w = world();
    const g = await research(w);
    const shorts = new ShortIds();
    const first = graphQuery(w.memory, { from: g.r, depth: 1 }, shorts);
    for (const c of first.claims) {
      assert.ok(c.short.length >= 4 && c.short.length < c.claimId.length, c.short);
      assert.ok(c.claimId.endsWith(c.short));
      assert.equal(shorts.resolve(c.short), c.claimId);
    }
    assert.equal(new Set(first.claims.map((c) => c.short)).size, first.claims.length);
    // Going on from a short id, with the same names.
    const sShort = first.claims.find((c) => c.claimId === g.s)?.short as string;
    const next = graphQuery(w.memory, { from: sShort, depth: 1 }, shorts);
    assert.deepEqual(ids(next).sort(), [g.s, g.r, g.u].sort());
    assert.equal(next.claims.find((c) => c.claimId === g.r)?.short, first.claims.find((c) => c.claimId === g.r)?.short);
    assert.equal(first.edges[0]?.fromShort, shorts.shorten(first.edges[0]?.from as string));
    assert.equal(shorts.resolve("zzzz"), undefined);
    assert.equal(shorts.resolve(g.r), g.r, "a whole id that was named resolves to itself");
    assert.throws(() => graphQuery(w.memory, { from: "zzzz" }, shorts), /no claim zzzz/);
    w.close();
  });

  it("extend a short name only as far as the ids it must be told from", () => {
    const shorts = new ShortIds();
    assert.equal(shorts.shorten("clm_AAAA1234"), "1234");
    assert.equal(shorts.shorten("clm_BBBB1234"), "B1234", "the same last four characters: one more");
    assert.equal(shorts.shorten("clm_CCCCBB1234"), "BB1234", "and one more again when that is taken too");
    assert.equal(shorts.shorten("clm_AAAA1234"), "1234", "a name once given does not change");
    assert.equal(shorts.resolve("1234"), "clm_AAAA1234");
    assert.equal(shorts.resolve("B1234"), "clm_BBBB1234");
    assert.equal(shorts.shorten("abc"), "abc", "an id shorter than four characters is its own name");
  });

  it("are written as text a model can read", async () => {
    const w = world();
    const g = await research(w);
    const found = graphQuery(w.memory, { from: g.r, depth: 1, kinds: ["strengthens", "negation_of"] });
    const text = renderSubgraph(found);
    const short = (id: string) => found.claims.find((c) => c.claimId === id)?.short;
    // Claims at one depth are listed by id, and two ids made in the same millisecond differ only in their random part.
    const atOne = ([[g.s, "QS"], [g.n, "QN"]] as Array<[string, string]>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, statement]) => `${short(id)}  open  : ${statement}`);
    assert.deepEqual(text.split("\n"), [
      "3 claims, 2 edges",
      `${short(g.r)}  open  : QR`,
      ...atOne,
      `${short(g.s)} -strengthens[lean_checked]-> ${short(g.r)}`,
      `${short(g.n)} -negation_of[proposed]-> ${short(g.r)}`,
    ]);
    const cut = renderSubgraph(graphQuery(w.memory, { from: g.r, limit: 2 }), { statementWidth: 3 });
    assert.match(cut, /^2 claims, 1 edge \(cut: more exist\)\n\w+  open  : …\n\w+  open  : …\n/);
    assert.match(renderSubgraph(graphQuery(w.memory, { from: g.r, depth: 0 })), /^1 claim, 0 edges\n\w+  open  : QR$/);
    w.close();
  });

  it("are read from the arguments of a tool, which are checked", () => {
    assert.deepEqual(parseGraphQuery({}, "clm_1"), { from: "clm_1" });
    assert.deepEqual(parseGraphQuery({ from: "abcd", kinds: ["implies"], edgeStatuses: ["lean_checked"], claimStatuses: ["open"], direction: "out", depth: 3, limit: 9 }), {
      from: "abcd",
      kinds: ["implies"],
      edgeStatuses: ["lean_checked"],
      claimStatuses: ["open"],
      direction: "out",
      depth: 3,
      limit: 9,
    });
    assert.deepEqual(parseGraphQuery({ claim: "abcd" }, "clm_1"), { from: "abcd" });
    assert.throws(() => parseGraphQuery({}), /from must be a claim id/);
    assert.throws(() => parseGraphQuery({ kinds: ["flies"] }, "c"), /kinds must be a list of valid values/);
    assert.throws(() => parseGraphQuery({ edgeStatuses: "lean_checked" }, "c"), /edgeStatuses must be a list/);
    assert.throws(() => parseGraphQuery({ claimStatuses: ["done"] }, "c"), /claimStatuses/);
    assert.throws(() => parseGraphQuery({ direction: "up" }, "c"), /direction must be out, in or both/);
    assert.throws(() => parseGraphQuery({ depth: "2" }, "c"), /depth must be a number/);
  });
});
