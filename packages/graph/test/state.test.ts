import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphState, proposeEdge } from "../src/index.ts";
import { certify, claim, link, prove, world } from "./helpers.ts";

const A = "(n : ℕ) : n + 0 = n";
const B = "(n : ℕ) : 0 + n = n";
const C = ": 1 + 1 = 2";

describe("the state of the graph", () => {
  it("reads checked edges and statuses from the memory, and follows them as they change", async () => {
    const w = world();
    const [a, b, c] = [await claim(w, A), await claim(w, B), await claim(w, C)] as [string, string, string];
    const edge = proposeEdge(w.memory, { kind: "implies", from: a, to: b });
    const state = new GraphState(w.memory, [a]);

    // A claim reaches the claims around it through edges of any status; a proposed edge propagates nothing.
    await prove(w, a);
    state.sync();
    assert.deepEqual(state.claims().sort(), [a, b].sort());
    assert.equal(state.candidate.holds({ goal: "proved", claim: a }), true);
    assert.equal(state.candidate.holds({ goal: "proved", claim: b }), false);
    assert.equal(state.certified.holds({ goal: "proved", claim: a }), false, "a candidate is not a proof");

    // Lean checks the link lemma: the edge propagates, at the candidate level.
    await link(w, "implies", a, b);
    assert.equal(w.memory.edge(edge.edgeId)?.status, "lean_checked");
    const report = state.sync();
    assert.deepEqual(report.gained, [`edge:${edge.edgeId}`], "the report counts base facts and edges: P:b is derived");
    assert.equal(state.levelOf({ goal: "proved", claim: b }), "candidate");
    assert.deepEqual(state.explain({ goal: "proved", claim: b })?.tree.rule, "implies/proved");
    assert.equal(state.levelOf({ goal: "proved", claim: c }), undefined);
    assert.deepEqual(state.sync().gained, [], "nothing changed since the last sync");

    // A certified proof makes the derived fact certified too.
    certify(w, a);
    state.sync();
    assert.equal(w.memory.claim(a)?.status, "proved");
    assert.equal(state.levelOf({ goal: "proved", claim: b }), "certified");

    // Withdrawing the proof revokes both levels.
    w.memory.retractClaim(a, { reason: "a dependency was retracted" });
    const lost = state.sync().lost;
    assert.equal(w.memory.claim(a)?.status, "retracted");
    assert.equal(state.levelOf({ goal: "proved", claim: b }), undefined);
    assert.deepEqual(lost.sort(), [`candidate:P:${a}`, `certified:P:${a}`].sort());
    w.close();
  });

  it("counts a valid proof of the negation as a candidate refutation, and a certified one as a refutation", async () => {
    const w = world();
    const a = await claim(w, A);
    const state = new GraphState(w.memory, [a]);
    const result = await w.validate({ claimId: a, negation: true, proof: "exact trivial_proof" });
    assert.equal(result.verdict, "valid");
    assert.equal(w.memory.claim(a)?.status, "open", "a refutation changes no status until it is certified");
    state.sync();
    assert.equal(state.levelOf({ goal: "refuted", claim: a }), "candidate");
    certify(w, a, true);
    state.sync();
    assert.equal(w.memory.claim(a)?.status, "refuted");
    assert.equal(state.levelOf({ goal: "refuted", claim: a }), "certified");
    w.close();
  });

  it("follows only the claims around its seeds", async () => {
    const w = world();
    const [a, b, c] = [await claim(w, A), await claim(w, B), await claim(w, C)] as [string, string, string];
    proposeEdge(w.memory, { kind: "equiv", from: a, to: b });
    const state = new GraphState(w.memory);
    assert.deepEqual(state.claims(), []);
    state.watch(b);
    assert.deepEqual(state.claims().sort(), [a, b].sort());
    state.watch(c);
    assert.deepEqual(state.claims().sort(), [a, b, c].sort());
    w.close();
  });

  it("does not follow the edges no rule reads", async () => {
    const w = world();
    const [a, b, source, other] = [await claim(w, A), await claim(w, B), await claim(w, C), await claim(w, ": 2 + 2 = 4")] as [string, string, string, string];
    proposeEdge(w.memory, { kind: "equiv", from: a, to: b });
    w.memory.addEdge({ kind: "cites", from: a, to: [source] });
    w.memory.addEdge({ kind: "cites", from: other, to: [source] });
    const state = new GraphState(w.memory, [a]);
    assert.deepEqual(state.claims().sort(), [a, b].sort(), "the source and the other claim that cites it are not part of the graph");
    w.close();
  });
});
