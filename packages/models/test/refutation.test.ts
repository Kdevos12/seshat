import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, DEFAULT_POLICY, Journal, structuralCheck } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import {
  describeCounterModel,
  evaluateMagmaStatement,
  magmaBattery,
  type MagmaStatement,
  negationProofs,
  recognizeStatement,
  type RecognizedStatement,
  recordBattery,
  recordCounterModel,
  submitRefutation,
} from "../src/index.ts";

function statementOf(text: string): RecognizedStatement {
  const result = recognizeStatement(text);
  assert.ok("statement" in result);
  return result.statement;
}

const COMMUTES = "(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x";
const leftZero2 = { kind: "magma" as const, id: "2:0011", size: 2, table: [0, 0, 1, 1] };

describe("the proof of a negation from a counter-model", () => {
  it("instantiates the claim on the object and lets decide show that it is false", () => {
    const [direct, withAux] = negationProofs(statementOf(COMMUTES), leftZero2);
    assert.deepEqual(direct, {
      form: "have-revert",
      aux: "",
      proof: "intro hall\nhave key := @hall (Fin 2) ⟨fun a b => ([0, 0, 1, 1] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩\nrevert key\ndecide",
    });
    assert.equal(withAux?.form, "absurd");
    assert.match(withAux?.aux ?? "", /^def aux_m11_[0-9a-f]{12} \(a b : Fin 2\) : Fin 2 := \(\[0, 0, 1, 1\] : List \(Fin 2\)\)\.getD \(a\.val \* 2 \+ b\.val\) 0$/);
    const name = /^def (aux_m11_[0-9a-f]{12})/.exec(withAux?.aux ?? "")?.[1];
    assert.equal(withAux?.proof, `intro hall\nexact absurd (@hall (Fin 2) ⟨${name}⟩) (by decide)`);
  });

  it("is a proof for a statement about a number too", () => {
    const [direct, withAux] = negationProofs(statementOf("(n : ℕ) (h : n % 2 = 1) : n < 5"), { kind: "integer", id: "7", value: 7 });
    assert.equal(direct?.proof, "intro hall\nhave key := @hall 7\nrevert key\ndecide");
    assert.equal(withAux?.proof, "intro hall\nexact absurd (@hall 7) (by decide)");
    assert.equal(withAux?.aux, "");
  });

  it("passes the validator's structural check: no forbidden token, no string, aux declarations named aux_", () => {
    for (const statement of [COMMUTES, "(M : Type) [Mul M] : ∀ x : M, x * x = x", "(n : ℕ) : n < 5"]) {
      const object = statement.startsWith("(n") ? ({ kind: "integer", id: "9", value: 9 } as const) : leftZero2;
      for (const proof of negationProofs(statementOf(statement), object)) {
        assert.deepEqual(structuralCheck({ aux: proof.aux, proof: proof.proof }, DEFAULT_POLICY), [], `${proof.form} of ${statement}`);
      }
    }
  });

  it("refuses an object of the wrong kind", () => {
    assert.throws(() => negationProofs(statementOf(COMMUTES), { kind: "integer", id: "1", value: 1 }), /refuted by a magma/);
    assert.throws(() => negationProofs(statementOf("(n : ℕ) : n < 5"), leftZero2), /refuted by a number/);
  });

  it("describes the object in words", () => {
    assert.equal(describeCounterModel({ kind: "integer", id: "7", value: 7 }), "the number 7");
    assert.equal(describeCounterModel(leftZero2), "the magma of size 2 with the table [[0,0],[1,1]] (row a, column b: a * b)");
  });
});

describe("the proof of a negation for a claim over a universe-polymorphic type", () => {
  // Inside the negation theorem the universe of `Type*` is a rigid parameter `u_1`, so `Fin 2 : Type`
  // does not fit `hall`'s first argument; `ULift (Fin 2)` does, for any universe.
  const polymorphic = (sort: string) => `(M : ${sort}) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x`;
  const lifted = "ULift.up (([0, 0, 1, 1] : List (Fin 2)).getD (a.down.val * 2 + b.down.val) 0)";

  it("builds the counter-model over ULift (Fin n), transporting the table through down and up, in both forms", () => {
    for (const sort of ["Type*", "Type _", "Type u", "Type 1"]) {
      const [direct, withAux] = negationProofs(statementOf(polymorphic(sort)), leftZero2);
      assert.equal(direct?.form, "have-revert", sort);
      assert.equal(direct?.aux, "", sort);
      assert.equal(direct?.proof, `intro hall\nhave key := @hall (ULift (Fin 2)) ⟨fun a b => ${lifted}⟩\nrevert key\ndecide`, sort);
      // The table stays a definition on Fin 2, as for a plain type: only the instance wraps it.
      const name = /^def (aux_m11_[0-9a-f]{12}) \(a b : Fin 2\) : Fin 2 := \(\[0, 0, 1, 1\] : List \(Fin 2\)\)\.getD \(a\.val \* 2 \+ b\.val\) 0$/.exec(withAux?.aux ?? "")?.[1];
      assert.ok(name !== undefined, `${sort}: ${withAux?.aux}`);
      assert.equal(withAux?.form, "absurd", sort);
      assert.equal(withAux?.proof, `intro hall\nexact absurd (@hall (ULift (Fin 2)) ⟨fun a b => ULift.up (${name} a.down b.down)⟩) (by decide)`, sort);
    }
  });

  it("keeps the plain forms for Type and Type 0, where Fin n has the right type", () => {
    for (const sort of ["Type", "Type 0"]) {
      const [direct, withAux] = negationProofs(statementOf(polymorphic(sort)), leftZero2);
      assert.match(direct?.proof ?? "", /^intro hall\nhave key := @hall \(Fin 2\) ⟨fun a b => \(\[0, 0, 1, 1\]/, sort);
      assert.doesNotMatch(`${direct?.proof}${withAux?.proof}`, /ULift/, sort);
    }
  });

  it("passes the validator's structural check, for a magma statement and a hypothesis-free one", () => {
    for (const statement of [polymorphic("Type*"), "(M : Type u) [Mul M] : ∀ x : M, x * x = x"]) {
      for (const proof of negationProofs(statementOf(statement), leftZero2)) {
        assert.deepEqual(structuralCheck({ aux: proof.aux, proof: proof.proof }, DEFAULT_POLICY), [], `${proof.form} of ${statement}`);
      }
    }
  });

  it("is the form submitted for a claim over Type*", async () => {
    const requests: ValidateRequest[] = [];
    await submitRefutation(async (request) => (requests.push(request), { verdict: "valid", status: "open", reasons: [] }), { claimId: "clm_1", statement: statementOf(polymorphic("Type*")), object: leftZero2 });
    assert.match(requests[0]?.proof ?? "", /^intro hall\nhave key := @hall \(ULift \(Fin 2\)\) /);
  });
});

describe("submitting a refutation", () => {
  const answer = (verdict: "valid" | "invalid", extra: Partial<ValidateResult> = {}): ValidateResult => ({ verdict, status: "open", reasons: verdict === "valid" ? [] : ["unsolved goals"], ...extra });

  it("sends the negation through validate, with the first form, and stops at the first that is valid", async () => {
    const requests: ValidateRequest[] = [];
    const attempts = await submitRefutation(async (request) => (requests.push(request), answer("valid", { validationId: "val_1" })), { claimId: "clm_1", statement: statementOf(COMMUTES), object: leftZero2, attemptId: "att_1" });
    assert.equal(requests.length, 1);
    assert.deepEqual({ ...requests[0], proof: undefined }, { claimId: "clm_1", negation: true, proof: undefined, attemptId: "att_1" });
    assert.match(requests[0]?.proof ?? "", /^intro hall\nhave key := @hall \(Fin 2\)/);
    assert.deepEqual(attempts, [{ form: "have-revert", verdict: "valid", validationId: "val_1", status: "open", reasons: [] }]);
  });

  it("tries the other form when the first is invalid, and reports both", async () => {
    const requests: ValidateRequest[] = [];
    const attempts = await submitRefutation(
      async (request) => {
        requests.push(request);
        return requests.length === 1 ? answer("invalid") : answer("valid", { validationId: "val_2" });
      },
      { claimId: "clm_1", statement: statementOf(COMMUTES), object: leftZero2 },
    );
    assert.deepEqual(attempts.map((a) => [a.form, a.verdict]), [["have-revert", "invalid"], ["absurd", "valid"]]);
    assert.equal(requests[0]?.aux, undefined);
    assert.match(requests[1]?.aux ?? "", /^def aux_m11_/);
    assert.equal(requests[1]?.attemptId, undefined);
    const neither = await submitRefutation(async () => answer("invalid"), { claimId: "clm_1", statement: statementOf(COMMUTES), object: leftZero2 });
    assert.deepEqual(neither.map((a) => a.verdict), ["invalid", "invalid"]);
  });
});

describe("recording a counter-model", () => {
  it("makes a node and a computed refuted_by edge, and leaves the claim open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-models-"));
    const memory = new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
    const { claimId } = await memory.ensureClaim({ statement: COMMUTES, origin: "test" });
    const battery = magmaBattery({ samples: 0 });
    const evaluated = evaluateMagmaStatement(statementOf(COMMUTES) as MagmaStatement, battery.objects);
    const index = evaluated.verdicts.indexOf(false);
    const object = battery.objects[index];
    assert.ok(object !== undefined);
    recordBattery(memory, battery);
    const { node, edge } = recordCounterModel(memory, { claimId, battery, index, object, evaluator: "law", ...(evaluated.witnesses[index] !== undefined ? { witness: evaluated.witnesses[index] } : {}) });
    assert.equal(node.kind, "counter_model");
    assert.equal(node.claimId, claimId);
    assert.deepEqual(node.data, {
      battery: "magmas:3",
      digest: battery.digest,
      index,
      object: { kind: "magma", size: object.size, table: object.table },
      description: describeCounterModel(object),
      evaluator: "law",
      witness: evaluated.witnesses[index],
    });
    // The smallest magma that has a left zero and does not commute: size 2, x * y = x.
    assert.equal(object.size, 2);
    assert.deepEqual(object.table, [0, 0, 1, 1]);
    assert.deepEqual([edge.kind, edge.from, edge.to, edge.status], ["refuted_by", claimId, [node.nodeId], "computed"]);
    assert.match(edge.note ?? "", /a refutation needs a Lean proof of the negation/);
    assert.equal(memory.claim(claimId)?.status, "open");
    assert.deepEqual(memory.validations(claimId), []);
  });
});
