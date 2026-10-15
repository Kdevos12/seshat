import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkEdge, closersFor, EQUIVALENCE_CLOSERS, IMPLICATION_CLOSERS, proposeEdge } from "../src/index.ts";
import { claim, HEADER, proofOf, toyAnswer, world } from "./helpers.ts";

const A = "(n : ℕ) : n + 0 = n";
const B = "(n : ℕ) : 0 + n = n";

describe("checking an edge by its link lemma", () => {
  it("makes the edge lean_checked when a closer passes, and records the lemma as a claim with its proof", async () => {
    const w = world();
    const [a, b] = [await claim(w, A), await claim(w, B)] as [string, string];
    const edge = proposeEdge(w.memory, { kind: "implies", from: a, to: b });
    assert.equal(edge.status, "proposed");
    const logged: string[] = [];
    const result = await checkEdge({ memory: w.memory, validate: w.validate, header: HEADER, closers: ["bad", "exact trivial_proof"], log: (t) => logged.push(t) }, edge.edgeId);
    assert.equal(result.checked, true);
    assert.equal(result.tried, 2, "the first closer failed, the second passed");

    const checked = w.memory.edge(edge.edgeId);
    assert.deepEqual([checked?.status, checked?.validationId], ["lean_checked", result.validationId]);
    const lemma = w.memory.claim(result.lemmaId as string);
    assert.deepEqual([lemma?.statement, lemma?.parentId, lemma?.header, lemma?.status], [edge.link?.statement, a, HEADER, "computed"]);
    // The validation that made the edge lean_checked is a valid proof of the lemma itself.
    const validations = w.memory.validations(result.lemmaId as string);
    assert.deepEqual(validations.map((v) => v.verdict), ["invalid", "valid"]);
    assert.equal(validations[1]?.validationId, result.validationId);
    assert.match(logged[0] ?? "", /is lean_checked/);

    // Asked again, there is nothing to do.
    const again = await checkEdge({ memory: w.memory, validate: w.validate }, edge.edgeId);
    assert.deepEqual([again.checked, again.tried], [true, 0]);
    w.close();
  });

  it("asks for more proofs when the closers fail, telling what failed, and leaves the edge proposed when none passes", async () => {
    const w = world();
    const [a, b] = [await claim(w, A), await claim(w, B)] as [string, string];
    const edge = proposeEdge(w.memory, { kind: "equiv", from: a, to: b });
    const asked: string[][] = [];
    const none = await checkEdge(
      {
        memory: w.memory,
        validate: w.validate,
        closers: ["bad"],
        propose: async ({ failures }) => {
          asked.push(failures);
          return [{ proof: "sorry" }, { proof: "intro h\n  bad" }];
        },
      },
      edge.edgeId,
    );
    assert.equal(none.checked, false);
    assert.equal(none.tried, 3);
    assert.match(none.reason, /no proof of the lemma .* passed \(3 tried\)/);
    assert.equal(asked.length, 1);
    assert.match(asked[0]?.[0] ?? "", /unknown identifier/);
    assert.equal(w.memory.edge(edge.edgeId)?.status, "proposed");

    // A proof from the model passes; the edge is checked with it.
    const second = await checkEdge({ memory: w.memory, validate: w.validate, closers: [], propose: async () => [{ proof: "exact trivial_proof" }] }, edge.edgeId);
    assert.deepEqual([second.checked, second.tried], [true, 1]);
    assert.equal(w.memory.edge(edge.edgeId)?.status, "lean_checked");
    w.close();
  });

  it("stops at once when the lemma does not compile, and leaves alone the edges no lemma can check", async () => {
    const w = world((code) =>
      proofOf(code) === undefined && code.includes("BROKEN") ? { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "unknown identifier 'BROKEN'" }] } : toyAnswer(code),
    );
    const [a, b] = [await claim(w, ": BROKEN"), await claim(w, B)] as [string, string];
    const edge = proposeEdge(w.memory, { kind: "implies", from: a, to: b });
    const result = await checkEdge({ memory: w.memory, validate: w.validate, closers: ["exact trivial_proof", "tauto"] }, edge.edgeId);
    assert.equal(result.checked, false);
    assert.equal(result.tried, 1, "no other tactic can fix a lemma that does not elaborate");
    assert.match(result.reason, /the lemma does not compile/);

    const cite = proposeEdge(w.memory, { kind: "cites", from: a, to: b });
    assert.equal(cite.link, undefined);
    assert.deepEqual(await checkEdge({ memory: w.memory, validate: w.validate }, cite.edgeId), {
      edgeId: cite.edgeId,
      checked: false,
      reason: "no Lean lemma checks a cites edge",
      tried: 0,
    });
    await assert.rejects(checkEdge({ memory: w.memory, validate: w.validate }, "edg_nowhere"), /unknown edge/);
    w.close();
  });

  it("tries cheap tactics first, by the kind of the lemma", () => {
    assert.equal(closersFor("equiv"), EQUIVALENCE_CLOSERS);
    assert.equal(closersFor("negation_of"), EQUIVALENCE_CLOSERS);
    assert.equal(closersFor("implies"), IMPLICATION_CLOSERS);
    assert.equal(closersFor("decomposes_into"), IMPLICATION_CLOSERS);
    assert.equal(EQUIVALENCE_CLOSERS[0], "exact Iff.rfl");
  });
});
