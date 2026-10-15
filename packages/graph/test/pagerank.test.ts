import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeKind, EdgeStatus } from "@seshat/core";
import { nearbyClaims, personalizedPageRank, proposeEdge, type WalkEdge } from "../src/index.ts";
import { claim, link, prove, world } from "./helpers.ts";

const edge = (from: string, to: string, kind: EdgeKind = "implies", status: EdgeStatus = "proposed"): WalkEdge => ({ kind, from, to: [to], status });
const close = (actual: number | undefined, expected: number, message = "") => assert.ok(Math.abs((actual ?? NaN) - expected) < 1e-9, `${message} ${actual} is not ${expected}`);
const D = 0.85;

describe("personalized PageRank", () => {
  it("matches the closed form on two claims, a to b, walked forward from a", () => {
    // r_a = (1-d) + d·r_b (b has no edge to follow, so its share goes back to the seed), r_b = d·r_a.
    const result = personalizedPageRank([edge("a", "b")], { seeds: ["a"], direction: "forward" });
    close(result.scores.get("a"), 1 / (1 + D), "a");
    close(result.scores.get("b"), D / (1 + D), "b");
    assert.equal(result.converged, true);
    assert.deepEqual(result.ranking.map((r) => r.claim), ["a", "b"]);
  });

  it("matches the closed form on a path a - b - c, walked either way from a", () => {
    const result = personalizedPageRank([edge("a", "b"), edge("b", "c")], { seeds: ["a"] });
    // r_b = d/(1+d), r_c = d²/(2(1+d)), r_a = (1-d) + r_c: the walk at b goes to a or c with equal chance.
    close(result.scores.get("b"), D / (1 + D), "b");
    close(result.scores.get("c"), (D * D) / (2 * (1 + D)), "c");
    close(result.scores.get("a"), 1 - D + (D * D) / (2 * (1 + D)), "a");
    close([...result.scores.values()].reduce((x, y) => x + y, 0), 1, "the scores add up to 1");
    // The walk keeps coming back through b, which is in the middle: b outranks the seed itself.
    assert.deepEqual(result.ranking.map((r) => r.claim), ["b", "a", "c"]);
  });

  it("follows an edge backward when asked, and weighs the seeds as given", () => {
    const backward = personalizedPageRank([edge("a", "b")], { seeds: ["b"], direction: "backward" });
    close(backward.scores.get("b"), 1 / (1 + D));
    close(backward.scores.get("a"), D / (1 + D));
    // With no edge to follow the walk restarts at the seeds in proportion to their weights.
    const weighted = personalizedPageRank([], { seeds: new Map([["x", 3], ["y", 1]]) });
    close(weighted.scores.get("x"), 0.75);
    close(weighted.scores.get("y"), 0.25);
  });

  it("is the plain PageRank without seeds: the claim many others point to ranks first", () => {
    const star = [edge("a", "hub"), edge("b", "hub"), edge("c", "hub")];
    const result = personalizedPageRank(star, { direction: "forward" });
    assert.equal(result.ranking[0]?.claim, "hub");
    close(result.scores.get("a"), result.scores.get("b") as number);
    const ring = personalizedPageRank([edge("a", "b"), edge("b", "a")], { direction: "forward" });
    close(ring.scores.get("a"), 0.5);
    close(ring.scores.get("b"), 0.5);
  });

  it("walks only the edges of the kinds and statuses asked, and weighs the kinds", () => {
    const edges = [edge("a", "b", "implies", "lean_checked"), edge("a", "c", "cites", "proposed")];
    const checked = personalizedPageRank(edges, { seeds: ["a"], minStatus: "lean_checked" });
    assert.equal(checked.scores.has("c"), false, "the proposed edge is not walked");
    const implies = personalizedPageRank(edges, { seeds: ["a"], kinds: ["implies"] });
    assert.equal(implies.scores.has("c"), false);
    const weighted = personalizedPageRank(edges, { seeds: ["a"], kindWeights: { cites: 3 } });
    close((weighted.scores.get("c") as number) / (weighted.scores.get("b") as number), 3);
    const without = personalizedPageRank(edges, { seeds: ["a"], kindWeights: { cites: 0 } });
    assert.equal(without.scores.get("c"), 0, "a kind with weight zero leads nowhere");
  });

  it("refuses what has no meaning, and has nothing to rank for no claims", () => {
    assert.throws(() => personalizedPageRank([], { damping: 1 }), /damping/);
    assert.throws(() => personalizedPageRank([], { seeds: new Map([["a", -1]]) }), /negative/);
    assert.throws(() => personalizedPageRank([], { seeds: new Map([["a", 0]]) }), /weigh nothing/);
    assert.throws(() => personalizedPageRank([edge("a", "b")], { kindWeights: { implies: -1 } }), /negative/);
    assert.deepEqual(personalizedPageRank([]).ranking, []);
  });

  it("finds the claims nearest to a problem in the memory, by status", async () => {
    const w = world();
    const [root, near, far, other] = (await Promise.all([claim(w, ": PRoot"), claim(w, ": PNear"), claim(w, ": PFar"), claim(w, ": POther")])) as [string, string, string, string];
    proposeEdge(w.memory, { kind: "strengthens", from: near, to: root });
    proposeEdge(w.memory, { kind: "implies", from: far, to: near });
    proposeEdge(w.memory, { kind: "implies", from: other, to: far });
    await prove(w, near);
    assert.deepEqual(nearbyClaims(w.memory, [root]).map((r) => r.claim), [near, far, other]);
    assert.deepEqual(nearbyClaims(w.memory, [root], { limit: 1 }).map((r) => r.claim), [near]);
    assert.deepEqual(nearbyClaims(w.memory, [root], { statuses: ["open"] }).map((r) => r.claim), [far, other]);
    assert.ok(nearbyClaims(w.memory, [root], { includeSeeds: true }).some((r) => r.claim === root));
    assert.ok(nearbyClaims(w.memory, [root]).every((r) => r.claim !== root));
    // A checked edge only: nothing is walked from the root.
    assert.deepEqual(nearbyClaims(w.memory, [root], { minStatus: "lean_checked" }), []);
    await link(w, "strengthens", near, root);
    assert.deepEqual(nearbyClaims(w.memory, [root], { minStatus: "lean_checked" }).map((r) => r.claim), [near]);
    w.close();
  });
});
