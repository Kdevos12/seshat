import assert from "node:assert/strict";
import { test } from "node:test";
import type { ValidationReport } from "@seshat/core";
import { readWork, stubsRegion } from "../src/index.ts";

const dep = { name: "aux_a", statement: "(n : Nat) : n + 0 = n" };
const report = (over: Partial<ValidationReport> = {}): ValidationReport => ({
  verdict: "invalid", method: "repl", reasons: [], axioms: [], messages: [], sorries: [], checked: "", submissionHash: "h", editsOutsideRegions: false, holes: true, leanStatus: "ok", ...over,
} as ValidationReport);

test("the work is done when Lean has no error and every sorry lies in a dependency stub", () => {
  const aux = `${stubsRegion([dep])}\n\nlemma helper (n : Nat) : n = n := rfl`;
  const r = readWork({ aux, proof: "exact aux_a n" }, report(), [dep]);
  assert.equal(r.done, true);
  assert.match(r.helpers, /helper/);
  assert.doesNotMatch(r.helpers, /aux_a/);
});

test("an error, a changed stub, a sorry in a helper or in the proof, or a file Lean did not check, is not done", () => {
  const stub = stubsRegion([dep]);
  const err = report({ messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "x" }] });
  assert.equal(readWork({ aux: stub, proof: "x" }, err, [dep]).done, false);
  assert.match(readWork({ aux: "lemma aux_a (n : Nat) : n = n := by\n  sorry", proof: "x" }, report(), [dep]).reason ?? "", /given lemma/);
  assert.match(readWork({ aux: "lemma aux_a (n : Nat) : n + 0 = n := by\n  simp", proof: "x" }, report(), [dep]).reason ?? "", /given lemma/);
  assert.match(readWork({ aux: `${stub}\n\nlemma h (n : Nat) : n = n := by\n  sorry`, proof: "x" }, report(), [dep]).reason ?? "", /helper lemma has a sorry/);
  assert.match(readWork({ aux: stub, proof: "sorry" }, report(), [dep]).reason ?? "", /proof has a sorry/);
  assert.equal(readWork({ aux: stub, proof: "x" }, report({ leanStatus: "server_error" }), [dep]).done, false);
  assert.equal(readWork({ aux: stub, proof: "x" }, report({ editsOutsideRegions: true }), [dep]).done, false);
});

test("a helper lemma that uses a dependency is refused, with the rule in the reason", () => {
  const stub = stubsRegion([dep]);
  const r = readWork({ aux: `${stub}\n\nlemma helper (n : Nat) : n + 0 = n := aux_a n`, proof: "exact helper n" }, report(), [dep]);
  assert.equal(r.done, false);
  assert.match(r.reason ?? "", /helper.*uses the given lemma aux_a/);
  assert.match(r.reason ?? "", /inside the proof of the hole/);
  // a longer name that merely starts with the dependency's name, and a mention in a comment, are not a use
  const ok = readWork({ aux: `${stub}\n\nlemma helper (n : Nat) : n = n := by\n  -- not aux_a\n  exact aux_ab n`, proof: "x" }, report(), [dep]);
  assert.equal(ok.done, true);
  // the hole's own proof may use it
  assert.equal(readWork({ aux: stub, proof: "exact aux_a n" }, report(), [dep]).done, true);
});
