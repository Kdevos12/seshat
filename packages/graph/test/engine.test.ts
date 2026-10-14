import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeKind } from "@seshat/core";
import { type EdgeAtom, Engine, type Fact, factKey, instancesOf, LOGIC_KINDS, parseFactKey, RULES } from "../src/index.ts";

const P = (claim: string): Fact => ({ goal: "proved", claim });
const R = (claim: string): Fact => ({ goal: "refuted", claim });
const edge = (id: string, kind: EdgeKind, from: string, ...to: string[]): EdgeAtom => ({ id, kind, from, to });
const keys = (facts: Fact[]) => facts.map(factKey);

describe("the propagation rules", () => {
  // Each rule on the smallest graph that fires it: the edge, what is given, what follows.
  const table: Array<[rule: string, e: EdgeAtom, given: Fact[], derives: Fact[]]> = [
    ["implies/proved", edge("e", "implies", "A", "B"), [P("A")], [P("B")]],
    ["implies/refuted", edge("e", "implies", "A", "B"), [R("B")], [R("A")]],
    ["strengthens/proved", edge("e", "strengthens", "A", "B"), [P("A")], [P("B")]],
    ["strengthens/refuted", edge("e", "strengthens", "A", "B"), [R("B")], [R("A")]],
    ["special_case_of/proved", edge("e", "special_case_of", "A", "B"), [P("B")], [P("A")]],
    ["special_case_of/refuted", edge("e", "special_case_of", "A", "B"), [R("A")], [R("B")]],
    ["instance_of/proved", edge("e", "instance_of", "A", "B"), [P("B")], [P("A")]],
    ["instance_of/refuted", edge("e", "instance_of", "A", "B"), [R("A")], [R("B")]],
    ["equiv/proved-forward", edge("e", "equiv", "A", "B"), [P("A")], [P("B")]],
    ["equiv/proved-backward", edge("e", "equiv", "A", "B"), [P("B")], [P("A")]],
    ["equiv/refuted-forward", edge("e", "equiv", "A", "B"), [R("A")], [R("B")]],
    ["equiv/refuted-backward", edge("e", "equiv", "A", "B"), [R("B")], [R("A")]],
    ["negation_of/proved", edge("e", "negation_of", "A", "B"), [P("A")], [R("B")]],
    ["negation_of/refuted", edge("e", "negation_of", "A", "B"), [R("A")], [P("B")]],
    ["negation_of/proved-back", edge("e", "negation_of", "A", "B"), [P("B")], [R("A")]],
    ["negation_of/refuted-back", edge("e", "negation_of", "A", "B"), [R("B")], [P("A")]],
    ["decomposes_into/parts", edge("e", "decomposes_into", "A", "B", "C"), [P("B"), P("C")], [P("A")]],
    ["decomposes_into/last-part", edge("e", "decomposes_into", "A", "B", "C"), [R("A"), P("B")], [R("C")]],
    ["refuted_by/counterexample", edge("e", "refuted_by", "A", "B"), [P("B")], [R("A")]],
  ];

  it("are nineteen, one for each line of the table, each on its own edge kind", () => {
    assert.deepEqual(RULES.map((rule) => rule.id).sort(), table.map(([rule]) => rule).sort());
    assert.deepEqual([...LOGIC_KINDS].sort(), ["decomposes_into", "equiv", "implies", "instance_of", "negation_of", "refuted_by", "special_case_of", "strengthens"]);
  });

  for (const [rule, e, given, derives] of table) {
    it(`${rule}: ${given.map(factKey).join(", ")} gives ${derives.map(factKey).join(", ")}`, () => {
      const engine = new Engine();
      engine.addEdge(e);
      for (const fact of given) engine.addBase(fact);
      assert.deepEqual(keys(engine.derivedFacts()), keys(derives));
      // The provenance names the rule, the edge and the premises of the step.
      const why = engine.explain(derives[0] as Fact);
      assert.equal(why?.rule, rule);
      assert.equal(why?.edge, "e");
      assert.deepEqual(keys((why?.premises ?? []).map((p) => p.fact)), keys(given));
      // Only the rule's own direction fires: no other fact follows from the same base facts.
      assert.deepEqual(keys(engine.facts()), [...new Set(keys([...given, ...derives]))].sort());
    });
  }

  it("decomposes_into/parts waits for every part, and last-part for the whole to be refuted", () => {
    const engine = new Engine();
    engine.addEdge(edge("e", "decomposes_into", "A", "B", "C", "D"));
    engine.addBase(P("B"));
    engine.addBase(P("C"));
    assert.equal(engine.holds(P("A")), false);
    engine.addBase(P("D"));
    assert.equal(engine.holds(P("A")), true);
    // A refuted whole with all parts but one proved refutes the missing one, whichever it is.
    for (const missing of ["B", "C", "D"]) {
      const other = new Engine();
      other.addEdge(edge("e", "decomposes_into", "A", "B", "C", "D"));
      other.addBase(R("A"));
      for (const part of ["B", "C", "D"].filter((p) => p !== missing)) other.addBase(P(part));
      assert.deepEqual(keys(other.derivedFacts()), keys([R(missing)]));
    }
    const short = new Engine();
    short.addEdge(edge("e", "decomposes_into", "A", "B", "C", "D"));
    short.addBase(R("A"));
    short.addBase(P("B"));
    assert.deepEqual(short.derivedFacts(), [], "two parts are still missing");
  });

  it("ignore an edge that does not have the arity of its kind", () => {
    assert.deepEqual(instancesOf(edge("e", "implies", "A", "B", "C")), []);
    assert.deepEqual(instancesOf(edge("e", "decomposes_into", "A")), []);
    assert.equal(instancesOf(edge("e", "equiv", "A", "B")).length, 4);
    assert.equal(instancesOf(edge("e", "decomposes_into", "A", "B", "C")).length, 3);
    assert.deepEqual(instancesOf(edge("e", "uses", "A", "B")), []);
    assert.deepEqual(parseFactKey("R:clm_1"), R("clm_1"));
    assert.throws(() => parseFactKey("X:1"), /not a fact key/);
  });
});

describe("the engine", () => {
  it("chains rules, and explains a fact as the shortest derivation tree", () => {
    const engine = new Engine();
    engine.addEdge(edge("e1", "implies", "A", "B"));
    engine.addEdge(edge("e2", "strengthens", "B", "C"));
    engine.addBase(P("A"));
    assert.deepEqual(keys(engine.derivedFacts()), keys([P("B"), P("C")]));
    const why = engine.explain(P("C"));
    assert.deepEqual([why?.rule, why?.edge, why?.base], ["strengthens/proved", "e2", false]);
    const inner = why?.premises?.[0];
    assert.deepEqual([inner?.fact, inner?.rule, inner?.edge], [P("B"), "implies/proved", "e1"]);
    assert.deepEqual(inner?.premises, [{ fact: P("A"), base: true }]);
    assert.equal(engine.explain(R("C")), undefined);
    assert.equal(engine.isBase(P("A")), true);
    assert.equal(engine.isBase(P("B")), false);
  });

  it("keeps every derivation of a fact, and a fact stays while one of them holds", () => {
    const engine = new Engine();
    engine.addEdge(edge("e1", "implies", "A", "C"));
    engine.addEdge(edge("e2", "implies", "B", "C"));
    engine.addBase(P("A"));
    engine.addBase(P("B"));
    assert.deepEqual(engine.derivations(P("C")).map((d) => [d.rule, d.edge, d.premises]), [
      ["implies/proved", "e1", ["P:A"]],
      ["implies/proved", "e2", ["P:B"]],
    ]);
    engine.removeBase(P("A"));
    assert.equal(engine.holds(P("C")), true);
    assert.deepEqual(engine.derivations(P("C")).map((d) => d.edge), ["e2"]);
    engine.removeBase(P("B"));
    assert.equal(engine.holds(P("C")), false);
    assert.deepEqual(engine.derivations(P("C")), []);
  });

  it("revokes what depended on a fact or an edge, and only that", () => {
    const engine = new Engine();
    engine.addEdge(edge("e1", "implies", "A", "B"));
    engine.addEdge(edge("e2", "implies", "B", "C"));
    engine.addEdge(edge("e3", "implies", "X", "Y"));
    engine.addBase(P("A"));
    engine.addBase(P("X"));
    assert.deepEqual(keys(engine.derivedFacts()), keys([P("B"), P("C"), P("Y")]));
    assert.equal(engine.removeEdge("e1"), true);
    assert.deepEqual(keys(engine.derivedFacts()), keys([P("Y")]), "B and C went with the edge that gave B");
    engine.addEdge(edge("e1", "implies", "A", "B"));
    assert.deepEqual(keys(engine.derivedFacts()), keys([P("B"), P("C"), P("Y")]), "a restored edge derives again");
    assert.equal(engine.removeBase(P("A")), true);
    assert.deepEqual(keys(engine.derivedFacts()), keys([P("Y")]));
    assert.equal(engine.removeBase(P("A")), false);
    assert.equal(engine.removeEdge("nope"), false);
    // A derived fact that is given too stays when its derivation goes.
    engine.addBase(P("B"));
    engine.addBase(P("A"));
    engine.removeBase(P("A"));
    assert.equal(engine.holds(P("B")), true);
    assert.equal(engine.isBase(P("B")), true);
  });

  it("does not let facts in a cycle keep each other alive", () => {
    const engine = new Engine();
    engine.addEdge(edge("e1", "implies", "A", "B"));
    engine.addEdge(edge("e2", "implies", "B", "C"));
    engine.addEdge(edge("e3", "implies", "C", "A"));
    engine.addBase(P("A"));
    assert.deepEqual(keys(engine.facts()), keys([P("A"), P("B"), P("C")]));
    engine.removeBase(P("A"));
    assert.deepEqual(engine.facts(), []);
    // An equivalence is a cycle of two rules.
    const eq = new Engine();
    eq.addEdge(edge("q", "equiv", "A", "B"));
    eq.addBase(P("A"));
    assert.equal(eq.holds(P("B")), true);
    eq.removeBase(P("A"));
    assert.deepEqual(eq.facts(), []);
    // A cycle with a second way in keeps what that way proves, and explains it without the cycle.
    engine.addBase(P("C"));
    engine.addBase(P("A"));
    engine.removeBase(P("C"));
    assert.deepEqual(keys(engine.facts()), keys([P("A"), P("B"), P("C")]));
    assert.deepEqual(engine.explain(P("C"))?.premises?.[0]?.premises?.[0]?.fact, P("A"));
  });

  it("reports a claim that is proved and refuted at once: the rule that checks consistency", () => {
    const engine = new Engine();
    engine.addEdge(edge("n", "negation_of", "NB", "B"));
    engine.addBase(P("B"));
    assert.deepEqual(engine.contradictions(), []);
    engine.addBase(P("NB"));
    // NB is proved so B is refuted; B is proved so NB is refuted: both claims are both.
    assert.deepEqual(engine.contradictions(), ["B", "NB"]);
    engine.removeBase(P("NB"));
    assert.deepEqual(engine.contradictions(), []);
  });

  it("derives the same facts when updated step by step as when built at once", () => {
    // A small universe and a seeded sequence of changes, compared with an engine built from scratch.
    const claims = ["a", "b", "c", "d", "e"];
    const kinds: EdgeKind[] = ["implies", "equiv", "negation_of", "special_case_of", "refuted_by"];
    let seed = 12345;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let round = 0; round < 12; round++) {
      const live = new Engine();
      const bases = new Map<string, Fact>();
      const edges = new Map<string, EdgeAtom>();
      for (let step = 0; step < 40; step++) {
        const action = random(4);
        if (action === 0) {
          const fact: Fact = { goal: random(2) === 0 ? "proved" : "refuted", claim: claims[random(claims.length)] as string };
          bases.set(factKey(fact), fact);
          live.addBase(fact);
        } else if (action === 1 && bases.size > 0) {
          const [key, fact] = [...bases][random(bases.size)] as [string, Fact];
          bases.delete(key);
          live.removeBase(fact);
        } else if (action === 2) {
          const id = `e${random(8)}`;
          const atom = edge(id, kinds[random(kinds.length)] as EdgeKind, claims[random(claims.length)] as string, claims[random(claims.length)] as string);
          edges.set(id, atom);
          live.addEdge(atom);
        } else if (edges.size > 0) {
          const [id] = [...edges][random(edges.size)] as [string, EdgeAtom];
          edges.delete(id);
          live.removeEdge(id);
        }
        const fresh = new Engine();
        for (const atom of edges.values()) fresh.addEdge(atom);
        for (const fact of bases.values()) fresh.addBase(fact);
        assert.equal(live.signature(), fresh.signature(), `round ${round}, step ${step}`);
      }
    }
  });
});
