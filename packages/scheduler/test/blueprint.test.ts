import assert from "node:assert/strict";
import { test } from "node:test";
import { dependencyOrder, readSketch } from "../src/index.ts";

const hole = (name: string, statement: string, uses?: string): string => `${uses === undefined ? "" : `-- uses: ${uses}\n`}lemma ${name} ${statement} := by\n  sorry`;
const A = hole("aux_a", "(n : Nat) : n + 0 = n");
const B = (uses?: string) => hole("aux_b", "(n : Nat) : 0 + n = n", uses);
const C = (uses?: string) => hole("aux_c", "(n : Nat) : n * 1 = n", uses);
const target = "(n : Nat) : n + 0 + 0 = n";
const blueprint = { blueprint: true, target };

test("a `-- uses:` line directly above a hole declares what it may use; blank lines and other comments do not", () => {
  const r = readSketch({ aux: `${A}\n\n${B("aux_a")}\n\n-- uses: aux_a\n\n${C()}`, proof: "exact aux_b 1 ▸ aux_c 1" }, blueprint);
  assert.deepEqual(r.holes.map((h) => [h.name, h.uses]), [["aux_a", []], ["aux_b", ["aux_a"]], ["aux_c", []]]);
  const many = readSketch({ aux: `${A}\n\n-- note\n-- uses: aux_a, aux_c\n${B()}`, proof: "x" }).holes;
  assert.deepEqual(many[1]?.uses, ["aux_a", "aux_c"]);
});

test("a blueprint is accepted when every hole reaches the target through the holes it uses", () => {
  const r = readSketch({ aux: `${A}\n\n${B("aux_a")}\n\n${C("aux_b")}`, proof: "exact aux_c 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.deepEqual(dependencyOrder(r.holes, "aux_c"), ["aux_a", "aux_b", "aux_c"]);
});

test("a cycle is refused, with the cycle", () => {
  const r = readSketch({ aux: `${hole("aux_a", "(n : Nat) : n + 0 = n", "aux_b")}\n\n${B("aux_a")}`, proof: "exact aux_a 1" }, blueprint);
  assert.match(r.problem ?? "", /cycle: aux_a -> aux_b -> aux_a/);
  assert.match(readSketch({ aux: hole("aux_a", "(n : Nat) : n + 0 = n", "aux_a"), proof: "exact aux_a 1" }, blueprint).problem ?? "", /cycle: aux_a -> aux_a/);
});

test("a hole that no one uses does not reach the target", () => {
  const r = readSketch({ aux: `${A}\n\n${B()}`, proof: "exact aux_a 1" }, blueprint);
  assert.match(r.problem ?? "", /aux_b does not reach the target/);
});

test("a name in a uses line that is no hole of the blueprint is refused", () => {
  const r = readSketch({ aux: `${A}\n\n${B("aux_z")}`, proof: "exact aux_a 1 ▸ aux_b 1" }, blueprint);
  assert.match(r.problem ?? "", /aux_b uses aux_z, which is not a hole/);
});

test("a hole that restates the target is refused as restates_target", () => {
  const r = readSketch({ aux: hole("aux_a", "(n : Nat)  :  n + 0 + 0 = n"), proof: "exact aux_a 1" }, blueprint);
  assert.equal(r.failureClass, "restates_target");
  assert.match(r.problem ?? "", /aux_a states the target again/);
});

test("without the option the uses lines are comments and M12 reads the sketch as it did", () => {
  const r = readSketch({ aux: `${A}\n\n${B("aux_z")}`, proof: "exact aux_a 1" });
  assert.equal(r.problem, undefined);
  assert.equal(r.failureClass, undefined);
});

test("a hole's statement may not name a hole, with or without a uses line", () => {
  const named = `${A}\n\n-- uses: aux_a\nlemma aux_b (n : Nat) (h : aux_a = aux_a) : n = n := by\n  sorry`;
  assert.match(readSketch({ aux: named, proof: "exact aux_b" }, blueprint).problem ?? "", /names aux_a/);
});
