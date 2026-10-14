import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeKind } from "@seshat/core";
import { composeProof, type EdgeAtom, Engine, type Fact, type ProofSource } from "../src/index.ts";

const P = (claim: string): Fact => ({ goal: "proved", claim });
const R = (claim: string): Fact => ({ goal: "refuted", claim });
const edge = (id: string, kind: EdgeKind, from: string, ...to: string[]): EdgeAtom => ({ id, kind, from, to });

/** Statements are `(n : ℕ) : T<claim> n`, proofs `exact p_<claim>` (`r_` for a refutation), links `exact link`. */
function source(edges: EdgeAtom[], proofs: (claim: string, goal: Fact["goal"]) => string | undefined = (c, g) => `exact ${g === "proved" ? "p" : "r"}_${c}`): ProofSource {
  return {
    statementOf: (id) => `(n : ℕ) : T${id} n`,
    proofOf: (id, goal) => {
      const proof = proofs(id, goal);
      return proof === undefined ? undefined : { aux: "", proof };
    },
    link: async (edgeId) => {
      const found = edges.find((e) => e.id === edgeId);
      return found === undefined ? undefined : { statement: `: L_${edgeId}`, submission: { aux: "", proof: "exact link" }, to: [...found.to] };
    },
  };
}

async function compose(edges: EdgeAtom[], given: Fact[], goal: Fact, src: ProofSource = source(edges)) {
  const engine = new Engine();
  for (const e of edges) engine.addEdge(e);
  for (const fact of given) engine.addBase(fact);
  const tree = engine.explain(goal);
  assert.ok(tree !== undefined, `the engine does not derive ${goal.goal} ${goal.claim}`);
  return composeProof(tree, src, () => "import Mathlib");
}

describe("composed proofs", () => {
  // The tactic of each rule, from the link lemma `aux_m2_l1` and the proofs of the premises.
  const table: Array<[rule: string, edges: EdgeAtom[], given: Fact[], goal: Fact, proof: string]> = [
    ["implies/proved", [edge("e", "implies", "A", "B")], [P("A")], P("B"), "exact aux_m2_l1 aux_m2_p1 n"],
    ["implies/refuted", [edge("e", "implies", "A", "B")], [R("B")], R("A"), "exact fun h => aux_m2_r1 (aux_m2_l1 h)"],
    ["strengthens/proved", [edge("e", "strengthens", "A", "B")], [P("A")], P("B"), "exact aux_m2_l1 aux_m2_p1 n"],
    ["strengthens/refuted", [edge("e", "strengthens", "A", "B")], [R("B")], R("A"), "exact fun h => aux_m2_r1 (aux_m2_l1 h)"],
    ["special_case_of/proved", [edge("e", "special_case_of", "A", "B")], [P("B")], P("A"), "exact aux_m2_l1 aux_m2_p1 n"],
    ["special_case_of/refuted", [edge("e", "special_case_of", "A", "B")], [R("A")], R("B"), "exact fun h => aux_m2_r1 (aux_m2_l1 h)"],
    ["instance_of/proved", [edge("e", "instance_of", "A", "B")], [P("B")], P("A"), "exact aux_m2_l1 aux_m2_p1 n"],
    ["instance_of/refuted", [edge("e", "instance_of", "A", "B")], [R("A")], R("B"), "exact fun h => aux_m2_r1 (aux_m2_l1 h)"],
    ["equiv/proved-forward", [edge("e", "equiv", "A", "B")], [P("A")], P("B"), "exact aux_m2_l1.mp aux_m2_p1 n"],
    ["equiv/proved-backward", [edge("e", "equiv", "A", "B")], [P("B")], P("A"), "exact aux_m2_l1.mpr aux_m2_p1 n"],
    ["equiv/refuted-forward", [edge("e", "equiv", "A", "B")], [R("A")], R("B"), "exact fun h => aux_m2_r1 (aux_m2_l1.mpr h)"],
    ["equiv/refuted-backward", [edge("e", "equiv", "A", "B")], [R("B")], R("A"), "exact fun h => aux_m2_r1 (aux_m2_l1.mp h)"],
    ["negation_of/proved", [edge("e", "negation_of", "A", "B")], [P("A")], R("B"), "exact aux_m2_l1.mp aux_m2_p1"],
    ["negation_of/refuted", [edge("e", "negation_of", "A", "B")], [R("A")], P("B"), "exact Classical.not_not.mp (fun h => aux_m2_r1 (aux_m2_l1.mpr h)) n"],
    ["negation_of/proved-back", [edge("e", "negation_of", "A", "B")], [P("B")], R("A"), "exact fun h => (aux_m2_l1.mp h) aux_m2_p1"],
    ["negation_of/refuted-back", [edge("e", "negation_of", "A", "B")], [R("B")], P("A"), "exact aux_m2_l1.mpr aux_m2_r1 n"],
    ["decomposes_into/parts", [edge("e", "decomposes_into", "A", "B", "C")], [P("B"), P("C")], P("A"), "exact aux_m2_l1 aux_m2_p1 aux_m2_p2 n"],
    ["decomposes_into/last-part (second)", [edge("e", "decomposes_into", "A", "B", "C")], [R("A"), P("B")], R("C"), "exact fun h => aux_m2_r1 (aux_m2_l1 aux_m2_p1 h)"],
    ["decomposes_into/last-part (first)", [edge("e", "decomposes_into", "A", "B", "C")], [R("A"), P("C")], R("B"), "exact fun h => aux_m2_r1 (aux_m2_l1 h aux_m2_p1)"],
    ["refuted_by/counterexample", [edge("e", "refuted_by", "A", "B")], [P("B")], R("A"), "exact aux_m2_l1 aux_m2_p1"],
  ];

  for (const [rule, edges, given, goal, proof] of table) {
    it(`${rule}: ${proof}`, async () => {
      const composed = await compose(edges, given, goal);
      assert.ok(composed.ok, composed.ok ? "" : composed.reason);
      assert.equal(composed.submission.proof, proof);
      assert.equal(composed.negation, goal.goal === "refuted");
      // Every piece is a theorem of its own: the link lemma, and the proof of each premise.
      assert.match(composed.submission.aux, /theorem aux_m2_l1 : L_e := by\n {2}exact link/);
      for (const premise of given) {
        const name = `aux_m2_${premise.goal === "proved" ? "p" : "r"}`;
        const statement = premise.goal === "proved" ? `\\(n : ℕ\\) : T${premise.claim} n` : `: ¬ \\(∀ \\(n : ℕ\\), T${premise.claim} n\\)`;
        assert.match(composed.submission.aux, new RegExp(`theorem ${name}\\d+ ${statement} := by\\n {2}exact ${premise.goal === "proved" ? "p" : "r"}_${premise.claim}`));
      }
    });
  }

  it("declares the steps of a chain in order, and each proof once however often it is used", async () => {
    const edges = [edge("e1", "implies", "A", "B"), edge("e2", "implies", "A", "C"), edge("e3", "decomposes_into", "D", "B", "C")];
    const composed = await compose(edges, [P("A")], P("D"));
    assert.ok(composed.ok);
    const declared = [...composed.submission.aux.matchAll(/^theorem (aux_m2_\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(declared, ["aux_m2_p1", "aux_m2_l1", "aux_m2_d1", "aux_m2_l2", "aux_m2_d2", "aux_m2_l3"]);
    assert.match(composed.submission.aux, /theorem aux_m2_d1 \(n : ℕ\) : TB n := by\n {2}exact aux_m2_l1 aux_m2_p1 n/);
    assert.match(composed.submission.aux, /theorem aux_m2_d2 \(n : ℕ\) : TC n := by\n {2}exact aux_m2_l2 aux_m2_p1 n/);
    assert.equal(composed.submission.proof, "exact aux_m2_l3 aux_m2_d1 aux_m2_d2 n");
    assert.equal(composed.pieces, 6);
  });

  it("gives the auxiliary declarations of each reused proof names of their own", async () => {
    const edges = [edge("e", "implies", "A", "B")];
    const proofs = (claim: string) =>
      claim === "A" ? "refine aux_helper ?_\nexact other.aux_helper aux_helper2" : undefined;
    const src: ProofSource = {
      ...source(edges),
      proofOf: (id) =>
        proofs(id) === undefined
          ? undefined
          : { aux: "theorem aux_helper : True := trivial\nopen Nat in\ntheorem aux_helper2 : True := trivial", proof: proofs(id) as string },
    };
    const composed = await compose(edges, [P("A")], P("B"), src);
    assert.ok(composed.ok);
    assert.match(composed.submission.aux, /^theorem aux_m2_p1_helper : True := trivial\nopen Nat in\ntheorem aux_m2_p1_helper2 : True := trivial\n\ntheorem aux_m2_p1 /);
    // The proof of the premise follows the renaming; a name qualified by another namespace is left alone.
    assert.match(composed.submission.aux, /refine aux_m2_p1_helper \?_\n {2}exact other\.aux_helper aux_m2_p1_helper2/);
  });

  it("fails, saying why, when a piece is missing or the claims are not read in the same context", async () => {
    const edges = [edge("e", "implies", "A", "B")];
    const noProof = await compose(edges, [P("A")], P("B"), source(edges, () => undefined));
    assert.deepEqual(noProof, { ok: false, reason: "claim A has no proof on record" });
    const noRefutation = await compose([edge("e", "implies", "A", "B")], [R("B")], R("A"), source(edges, (_, g) => (g === "proved" ? "exact p" : undefined)));
    assert.deepEqual(noRefutation, { ok: false, reason: "claim B has no proof of its negation on record" });
    const noLink = await compose(edges, [P("A")], P("B"), { ...source(edges), link: async () => undefined });
    assert.deepEqual(noLink, { ok: false, reason: "edge e has no link proof on record" });
    const noStatement = await compose(edges, [P("A")], P("B"), { ...source(edges), statementOf: () => undefined });
    assert.equal(noStatement.ok, false);

    const engine = new Engine();
    engine.addEdge(edges[0] as EdgeAtom);
    engine.addBase(P("A"));
    const tree = engine.explain(P("B")) as NonNullable<ReturnType<Engine["explain"]>>;
    const headers = await composeProof(tree, source(edges), (id) => (id === "A" ? "import Mathlib" : "import Mathlib\nopen Nat"));
    assert.deepEqual(headers, { ok: false, reason: "the claims do not share a header" });
    // Whitespace is not a difference.
    assert.ok((await composeProof(tree, source(edges), (id) => (id === "A" ? "import   Mathlib" : "import Mathlib"))).ok);
    // A fact with a proof of its own has nothing to compose.
    const base = engine.explain(P("A")) as NonNullable<ReturnType<Engine["explain"]>>;
    assert.deepEqual(await composeProof(base, source(edges), () => ""), { ok: false, reason: "the fact has a proof of its own" });
  });
});
