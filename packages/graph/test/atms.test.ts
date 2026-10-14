import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Atms, computeLabels, type Environment, GraphState, lemmaValue, rankLemmas } from "../src/index.ts";
import { claim, link, prove, world, type World } from "./helpers.ts";

/** The environments as sorted text, to compare sets of them. */
const keys = (list: Environment[]) => list.map((env) => [...env.prove.map((id) => `+${id}`), ...env.refute.map((id) => `-${id}`)].sort().join(" ")).sort();
const envs = (label: { environments: Environment[] }) => label.environments.map((e) => [...e.prove.map((id) => `+${id}`), ...e.refute.map((id) => `-${id}`)]);

/**
 * The AND/OR example: G is proved when A and B both are (decomposes_into, an AND), or when C is
 * (implies, an OR), and A is proved when D is.
 */
async function andOr(w: World) {
  const [g, a, b, c, d] = (await Promise.all(["G", "A", "B", "C", "D"].map((n) => claim(w, `: P${n}`)))) as [string, string, string, string, string];
  await link(w, "decomposes_into", g, a, b);
  await link(w, "implies", c, g);
  await link(w, "implies", d, a);
  const state = new GraphState(w.memory, [g]);
  return { g, a, b, c, d, state, atms: new Atms(state) };
}

describe("proved-modulo labels", () => {
  it("are the minimal sets of open claims a claim is proved modulo, on an AND/OR graph", async () => {
    const w = world();
    const { g, a, b, c, d, atms } = await andOr(w);
    const result = atms.refresh();
    // G: its own assumption, C alone, A and B, or D and B (D gives A).
    assert.deepEqual(envs(result.label(g)), [[`+${c}`], [`+${g}`], [`+${a}`, `+${b}`].sort(), [`+${b}`, `+${d}`].sort()].sort((x, y) => x.length - y.length || (x.join() < y.join() ? -1 : 1)));
    assert.deepEqual(envs(result.label(a)), [[`+${a}`], [`+${d}`]].sort((x, y) => (x.join() < y.join() ? -1 : 1)));
    assert.equal(result.settled(g), false);
    assert.equal(result.label(g).truncated, false);
    // Impossible sets: a claim proved while a claim it implies is refuted. Nothing is wrong with the graph itself.
    assert.deepEqual(keys(result.nogoods), [[`+${c}`, `-${g}`], [`+${a}`, `+${b}`, `-${g}`], [`+${b}`, `+${d}`, `-${g}`], [`+${d}`, `-${a}`]].map((x) => x.sort().join(" ")).sort());
    assert.deepEqual(result.contradictions, []);

    // A is proved (a candidate): G needs only B now, or C.
    await prove(w, a);
    const afterA = atms.refresh();
    assert.deepEqual(envs(afterA.label(g)), [[`+${b}`], [`+${c}`], [`+${g}`]].sort((x, y) => x.length - y.length || (x.join() < y.join() ? -1 : 1)));
    assert.deepEqual(afterA.label(a).environments, [{ prove: [], refute: [] }]);
    assert.equal(afterA.settled(a), true);
    // B too: G follows with no assumption.
    await prove(w, b);
    const afterB = atms.refresh();
    assert.equal(afterB.settled(g), true);
    assert.deepEqual(afterB.label(g).environments[0], { prove: [], refute: [] });
    w.close();
  });

  it("count a computed claim as open when only certified proofs settle", async () => {
    const w = world();
    const { g, a, b, state } = await andOr(w);
    await prove(w, a);
    const candidate = new Atms(state).refresh();
    const certified = new Atms(state, { level: "certified" }).refresh();
    assert.ok(envs(candidate.label(g)).some((e) => e.length === 1 && e[0] === `+${b}`));
    assert.ok(envs(certified.label(g)).some((e) => e.length === 2 && e.includes(`+${a}`) && e.includes(`+${b}`)));
    assert.equal(candidate.settled(a), true);
    assert.equal(certified.settled(a), false);
    w.close();
  });

  it("rank the open lemmas by what proving them would settle", async () => {
    const w = world();
    const { g, a, b, c, d, atms } = await andOr(w);
    const result = atms.refresh();
    // C settles G alone; D settles A alone and brings G one step nearer.
    const forC = lemmaValue(result, c);
    assert.deepEqual([forC.settles, forC.appears, forC.weight], [[g], [g], 1]);
    const forD = lemmaValue(result, d);
    assert.deepEqual([forD.settles, forD.appears.sort(), forD.weight], [[a], [a, g].sort(), 1.5]);
    const forA = lemmaValue(result, a);
    assert.deepEqual([forA.settles, forA.appears, forA.weight], [[], [g], 0.5]);
    assert.deepEqual(lemmaValue(result, b), { lemma: b, settles: [], appears: [g], weight: 0.5, bottleneckFor: [] });

    const ranking = rankLemmas(result);
    assert.deepEqual(ranking.slice(0, 2).map((r) => r.lemma), [d, c]);
    assert.deepEqual(ranking.slice(2).map((r) => r.lemma).sort(), [a, b].sort(), "G, which only its own label mentions, is not a lemma for anything");
    // Restricted to some candidates.
    assert.deepEqual(rankLemmas(result, { candidates: [b, c] }).map((r) => r.lemma), [c, b]);
    w.close();
  });

  it("find a lemma every proof of the target needs: a bottleneck", async () => {
    const w = world();
    const [g, a, b, d] = (await Promise.all(["G", "A", "B", "D"].map((n) => claim(w, `: Q${n}`)))) as [string, string, string, string];
    await link(w, "decomposes_into", g, a, b);
    await link(w, "implies", d, a);
    const result = new Atms(new GraphState(w.memory, [g])).refresh();
    assert.deepEqual(lemmaValue(result, b, { targets: [g] }).bottleneckFor, [g], "A and B, or D and B: B in both");
    assert.deepEqual(lemmaValue(result, a, { targets: [g] }).bottleneckFor, [], "D can stand in for A");
    assert.equal(rankLemmas(result, { targets: [g] })[0]?.lemma, b);
    w.close();
  });

  it("learn the nogoods: sets of claims that cannot all be proved, and leave out what they rule out", async () => {
    const w = world();
    // E is implied by A, and N is the negation of E; the goal G needs both A and N (an AND), or C alone.
    const [e, n, a, g, c] = (await Promise.all(["E", "N", "A", "G", "C"].map((x) => claim(w, `: R${x}`)))) as [string, string, string, string, string];
    await link(w, "implies", a, e);
    await link(w, "negation_of", n, e);
    await link(w, "decomposes_into", g, a, n);
    await link(w, "implies", c, g);
    const result = new Atms(new GraphState(w.memory, [g])).refresh();
    // E and N exclude each other, so do A (which gives E) with N, and A with a refuted E, and C with a refuted G.
    assert.deepEqual(
      keys(result.nogoods),
      [[`+${e}`, `+${n}`], [`+${a}`, `-${e}`], [`+${a}`, `+${n}`], [`-${e}`, `-${n}`], [`+${c}`, `-${g}`]].map((x) => x.sort().join(" ")).sort(),
    );
    // A and N together are impossible (A gives E, N refutes it), so that way of proving G is gone.
    assert.deepEqual(envs(result.label(g)), [[`+${c}`], [`+${g}`]].sort((x, y) => (x.join() < y.join() ? -1 : 1)));
    assert.deepEqual(result.contradictions, []);
    w.close();
  });

  it("report a claim that is proved and refuted with no assumption at all: a contradiction in the graph", async () => {
    const w = world();
    const [e, n] = (await Promise.all([claim(w, ": SE"), claim(w, ": SN")])) as [string, string];
    await link(w, "negation_of", n, e);
    await prove(w, e);
    await prove(w, n);
    const result = new Atms(new GraphState(w.memory, [e])).refresh();
    assert.deepEqual(result.contradictions, [e, n].sort());
    w.close();
  });

  it("are bounded: at most so many environments, of at most so many claims, and say when some were dropped", async () => {
    const w = world();
    const { g, c, state } = await andOr(w);
    const narrow = new Atms(state, { maxEnvironments: 1 }).refresh();
    // The smallest come first: one of the two environments of one claim (C, or G itself).
    assert.equal(narrow.label(g).environments.length, 1);
    assert.ok([`+${c}`, `+${g}`].includes(envs(narrow.label(g))[0]?.[0] as string));
    assert.equal(narrow.label(g).truncated, true);
    assert.equal(new Atms(state).refresh().label(g).truncated, false);
    const small = new Atms(state, { maxSize: 1 }).refresh();
    assert.deepEqual(envs(small.label(g)).map((e) => e.length), [1, 1], "the environments of two claims were left out");
    w.close();
  });

  it("are recomputed only for the part of the graph that changed", async () => {
    const w = world();
    const { g, a, state, atms } = await andOr(w);
    const [x, y] = (await Promise.all([claim(w, ": TX"), claim(w, ": TY")])) as [string, string];
    await link(w, "implies", x, y);
    state.watch(x);
    atms.refresh();
    assert.equal(atms.recomputed, 2, "two groups of claims, each computed once");
    atms.refresh();
    assert.equal(atms.recomputed, 2, "nothing changed");
    await prove(w, x);
    const second = atms.refresh();
    assert.equal(atms.recomputed, 3, "only the group of X and Y");
    assert.equal(second.settled(y), true);
    await prove(w, a);
    atms.refresh();
    assert.equal(atms.recomputed, 4, "only the group of G");
    // What was kept is what a fresh computation gives.
    const fresh = new Atms(state).refresh();
    const kept = atms.refresh();
    for (const id of [g, a, x, y]) {
      assert.deepEqual(kept.label(id), fresh.label(id), id);
      assert.deepEqual(kept.label(id, "refuted"), fresh.label(id, "refuted"), id);
    }
    assert.deepEqual(kept.nogoods, fresh.nogoods);
    w.close();
  });

  it("can be computed from a plain description of a graph", () => {
    const result = computeLabels({
      claims: ["x", "y"],
      open: new Set(["y"]),
      provedBase: new Set(["x"]),
      refutedBase: new Set(),
      edges: [{ id: "e", kind: "implies", from: "x", to: ["y"] }],
    });
    assert.equal(result.settled("y"), true, "y follows from x, which is proved");
    assert.deepEqual(result.claims(), ["x", "y"]);
  });
});
