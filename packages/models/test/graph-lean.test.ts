import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { forbiddenTokensIn, leanTextProblems, maskCommentsAndStrings } from "@seshat/core";
import type { ValidateRequest } from "@seshat/lines";
import { degreeSequence, graphAux, graphCertificateLean, graphNegationProofs, graphObject, leanErrorClass, recognizeGraphStatement, submitGraphRefutation, type GraphStatement } from "../src/index.ts";

const HAM = "(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] (h : G.Connected) (h3 : 3 ≤ Fintype.card V) : ∃ p : G.Walk _ _, p.IsHamiltonian";
const star = graphObject(4, [[0, 1], [0, 2], [0, 3]]);

function statementOf(text: string): GraphStatement {
  const r = recognizeGraphStatement(text);
  assert.ok("statement" in r, JSON.stringify(r));
  return r.statement;
}

describe("the reading of a statement about graphs", () => {
  it("reads the binders up to the hypotheses", () => {
    const s = statementOf(HAM);
    assert.deepEqual(s.parameters.map((p) => p.role), ["type", "instance", "instance", "graph", "instance"]);
    assert.equal(s.parameters[4]?.adjacency, true);
  });
  it("leaves other statements alone, with a reason", () => {
    assert.ok("reason" in recognizeGraphStatement("(n : ℕ) : n = n"));
    assert.ok("reason" in recognizeGraphStatement("(V : Type) (G H : SimpleGraph V) : G = H"));
    assert.ok("reason" in recognizeGraphStatement("(V : Type) (n : ℕ) (G : SimpleGraph V) : True"));
  });
});

describe("the Lean text of a witness", () => {
  it("passes the text guards, uses decide, and round-trips the edge list", () => {
    for (const sort of ["Type", "Type*"]) {
      const s = statementOf(HAM.replace("Type)", `${sort})`));
      for (const p of graphNegationProofs(s, star)) {
        const text = `${p.aux}\n${p.proof}`;
        assert.deepEqual(leanTextProblems(text), []);
        assert.doesNotMatch(text, /native_decide|bv_decide|sorry|axiom/);
        assert.match(p.proof, /decide/);
        assert.match(p.aux, /\(0, 1\), \(0, 2\), \(0, 3\)/);
      }
    }
    assert.match(graphAux(star), /^abbrev aux_g_/);
    assert.match(graphNegationProofs(statementOf(HAM.replace("Type)", "Type*)")), star)[0]?.proof ?? "", /ULift \(Fin 4\)/);
    assert.match(graphCertificateLean(star, { degrees: degreeSequence(star), connected: true }), /degreeSeq witness = \[3, 1, 1, 1\]/);
  });
  it("is checked on the templates themselves", () => {
    for (const file of ["Graph", "Witness"]) {
      const text = readFileSync(new URL(`../../../lean/SeshatLib/Finite/${file}.lean`, import.meta.url), "utf8").replace(/^import .*$/gm, "").replace(/\/-[\s\S]*?-\//g, "");
      assert.deepEqual(forbiddenTokensIn(maskCommentsAndStrings(text, { strict: true })), [], file);
      assert.doesNotMatch(text, /native_decide|bv_decide/);
    }
  });
  it("sends the negation through validate and classifies a refusal", async () => {
    const requests: ValidateRequest[] = [];
    const attempts = await submitGraphRefutation(
      async (r) => {
        requests.push(r);
        return { verdict: "invalid", status: "open", reasons: ["failed to synthesize Decidable"] };
      },
      { claimId: "c", statement: statementOf(HAM), graph: star },
    );
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.negation === true));
    assert.equal(attempts[0]?.errorClass, "instance");
    assert.equal(leanErrorClass(["decide failed: the proposition is false"]), "decide_false");
  });
});
