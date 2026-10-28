import assert from "node:assert/strict";
import { test } from "node:test";
import { linkProof, readSketch } from "../src/index.ts";

const aux = `lemma aux_a (n : Nat) : n + 0 = n := by
  sorry

lemma aux_b (n : Nat) : 0 + n = n := by
  sorry

lemma helper (n : Nat) : n = n := rfl`;

test("named sorry lemmas are holes; the other aux commands are kept", () => {
  const r = readSketch({ aux, proof: "exact fun n => by simp" });
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.holes.map((h) => h.name), ["aux_a", "aux_b"]);
  assert.equal(r.others.length, 1);
  assert.match(r.others[0] as string, /helper/);
});

test("a sketch the scheduler cannot split says why", () => {
  assert.match(readSketch({ aux: "lemma helper (n : Nat) : n = n := rfl", proof: "simp" }).problem ?? "", /no named hole/);
  assert.match(readSketch({ aux, proof: "sorry" }).problem ?? "", /sorry of its own/);
  const dep = `lemma aux_a (n : Nat) : n = n := by\n  sorry\n\nlemma later (n : Nat) : n = n := aux_a n`;
  assert.match(readSketch({ aux: dep, proof: "simp" }).problem ?? "", /rests on the hole aux_a/);
  const chain = `lemma aux_a (n : Nat) : n = n := by\n  sorry\n\nlemma aux_b (n : Nat) (h : aux_a = aux_a) : n = n := by\n  sorry`;
  assert.match(readSketch({ aux: chain, proof: "simp" }).problem ?? "", /names aux_a/);
});

test("the link proof introduces the holes under their own names", () => {
  const sub = { aux, proof: "exact aux_a 1" };
  const r = readSketch(sub);
  const link = linkProof(sub, r, "{m : Nat} (n : Nat)");
  assert.equal(link.proof, "intro h_aux_1 h_aux_2\nrefine fun {m : Nat} (n : Nat) => ?_\nhave aux_a := h_aux_1\nhave aux_b := h_aux_2\nexact aux_a 1");
  assert.match(link.aux, /helper/);
  assert.doesNotMatch(link.aux, /aux_a/);
});
