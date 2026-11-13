import assert from "node:assert/strict";
import { test } from "node:test";
import { blueprintNotice, dependencyOrder, dropHeaderImports, readSketch } from "../src/index.ts";

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

test("a hole that no one uses is left out when another hole remains, and the blueprint is refused when none does", () => {
  const r = readSketch({ aux: `${A}\n\n${B()}`, proof: "exact aux_a 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.holes.map((h) => h.name), ["aux_a"]);
  assert.deepEqual(r.dropped, ["aux_b"]);
  const none = readSketch({ aux: `${A}\n\n${B()}`, proof: "exact 1" }, blueprint);
  assert.match(none.problem ?? "", /aux_a does not reach the target/);
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

test("aux_a and aux_ab in one blueprint are two holes: a name is not read inside a longer one", () => {
  const ab = hole("aux_ab", "(n : Nat) : 0 + n = n", "aux_a");
  const ok = readSketch({ aux: `${A}\n\n${ab}`, proof: "exact aux_ab 1" }, blueprint);
  assert.equal(ok.problem, undefined);
  assert.deepEqual(dependencyOrder(ok.holes, "aux_ab"), ["aux_a", "aux_ab"]);
  // the main proof names aux_ab only, and aux_ab does not declare aux_a: aux_a is not reached (aux_ab does not count as a use of it)
  const lost = readSketch({ aux: `${A}\n\n${hole("aux_ab", "(n : Nat) : 0 + n = n")}`, proof: "exact aux_ab 1" }, blueprint);
  assert.equal(lost.problem, undefined);
  assert.deepEqual(lost.dropped, ["aux_a"]);
  assert.deepEqual(lost.holes.map((h) => h.name), ["aux_ab"]);
  // a uses line naming aux_a does not declare aux_ab
  assert.deepEqual(readSketch({ aux: `${A}\n\n${ab}`, proof: "x" }).holes.map((h) => h.uses), [[], ["aux_a"]]);
});

test("a name twice in a uses line counts once", () => {
  const r = readSketch({ aux: `${A}\n\n${B("aux_a, aux_a aux_a")}`, proof: "exact aux_b 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.holes[1]?.uses, ["aux_a"]);
});

test("a uses line above a command that is not a hole is dropped, and does not carry to the next hole", () => {
  const aux = `${A}\n\n-- uses: aux_a\ndef helper : Nat := 1\n\n${B()}`;
  const r = readSketch({ aux, proof: "exact aux_a 1 ▸ aux_b 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.holes.map((h) => h.uses), [[], []]);
  assert.equal(r.others.length, 1);
  // directly above the next hole, with only the def between them and no blank line, it is the def's and not the hole's
  const tight = readSketch({ aux: `${A}\n\n-- uses: aux_a\ndef helper : Nat := 1\n${B()}`, proof: "exact aux_a 1 ▸ aux_b 1" }, blueprint);
  assert.deepEqual(tight.holes.map((h) => h.uses), [[], []]);
});

test("a hole that names itself, in its uses line or in its own statement, is refused", () => {
  assert.match(readSketch({ aux: hole("aux_a", "(n : Nat) : n + 0 = n", "aux_a"), proof: "exact aux_a 1" }, blueprint).problem ?? "", /cycle: aux_a -> aux_a/);
  const own = `lemma aux_a (n : Nat) (h : aux_a = aux_a) : n = n := by\n  sorry`;
  assert.match(readSketch({ aux: own, proof: "exact aux_a" }, blueprint).problem ?? "", /names aux_a/);
});

// The shapes of the third real run (PA16), shortened: putnam_1983_a4 had three aux lemmas, the main proof called one of them, and
// `aux_sum_mod` was meant to use `aux_choose_mod_three` without saying so.
const CHOOSE = hole("aux_choose_mod_three", "(n : Nat) : n * 1 = n");
const SUM = (uses?: string) => hole("aux_sum_mod", "(n : Nat) : n + 0 = n", uses);
const facts = { refusedBeforeLean: false, errors: 0, editsOutsideRegions: false };

test("1983 A4 as it was: aux_choose_mod_three is left out and named, the blueprint is healthy", () => {
  const r = readSketch({ aux: `${CHOOSE}\n\n${SUM()}`, proof: "exact aux_sum_mod 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.holes.map((h) => h.name), ["aux_sum_mod"]);
  assert.deepEqual(r.dropped, ["aux_choose_mod_three"]);
  const notice = blueprintNotice(r, facts);
  assert.match(notice, /^Read as a blueprint: aux_sum_mod will be worked as separate sessions\./);
  assert.match(notice, /aux_choose_mod_three is used by nothing and is left out; add `-- uses: aux_choose_mod_three` above the hole that needs it/);
});

test("1983 A4 with a uses line: both holes are kept, with the dependency edge", () => {
  const r = readSketch({ aux: `${CHOOSE}\n\n${SUM("aux_choose_mod_three")}`, proof: "exact aux_sum_mod 1" }, blueprint);
  assert.equal(r.problem, undefined);
  assert.equal(r.dropped, undefined);
  assert.deepEqual(r.holes.map((h) => [h.name, h.uses]), [["aux_choose_mod_three", []], ["aux_sum_mod", ["aux_choose_mod_three"]]]);
  assert.deepEqual(dependencyOrder(r.holes, "aux_sum_mod"), ["aux_choose_mod_three", "aux_sum_mod"]);
  assert.match(blueprintNotice(r, facts), /^Read as a blueprint: aux_choose_mod_three, aux_sum_mod will be worked/);
});

test("Lean errors keep a sketch from being read as a blueprint, and the answer says so", () => {
  const r = readSketch({ aux: `${CHOOSE}\n\n${SUM("aux_choose_mod_three")}`, proof: "exact aux_sum_mod 1" }, blueprint);
  assert.match(blueprintNotice(r, { ...facts, errors: 3 }), /^Not a blueprint yet: Lean reports 3 error\(s\)\./);
  assert.match(blueprintNotice(r, { ...facts, refusedBeforeLean: true }), /refused before Lean ran/);
});

test("a main proof that is sorry (1999 A2) gets 'write the main proof from the holes'; a file with no hole gets the format", () => {
  const r = readSketch({ aux: `${CHOOSE}\n\n${SUM()}`, proof: "sorry" }, blueprint);
  assert.match(blueprintNotice(r, facts), /^Not a blueprint yet: the main proof has a sorry of its own\.\nWrite the main proof from the holes/);
  const none = readSketch({ aux: "lemma helper (n : Nat) : n = n := rfl", proof: "exact 1" }, blueprint);
  assert.match(blueprintNotice(none, facts), /it has no named hole\.\nHow to write a blueprint:\n- A hole is an `aux_` lemma/);
});

test("a cycle is named in the answer", () => {
  const r = readSketch({ aux: `${hole("aux_a", "(n : Nat) : n + 0 = n", "aux_b")}\n\n${B("aux_a")}`, proof: "exact aux_a 1" }, blueprint);
  assert.match(blueprintNotice(r, facts), /cycle: aux_a -> aux_b -> aux_a\.\nRemove one `-- uses:` line of the cycle/);
});

test("imports the header already has are dropped from aux; others, and every other line, stay", () => {
  const header = "import Mathlib\nimport Foo.Bar Baz\n\nnamespace X\n";
  const aux = "import Mathlib\nopen Finset BigOperators\n\ndef f := 1\nimport Other";
  const cut = dropHeaderImports(aux, header);
  assert.deepEqual(cut.dropped, ["Mathlib"]);
  assert.equal(cut.aux, "open Finset BigOperators\n\ndef f := 1\nimport Other");
  assert.equal(dropHeaderImports("import Foo.Bar Baz\nlemma x := 1", header).aux, "lemma x := 1");
  assert.deepEqual(dropHeaderImports("def f := 1", header), { aux: "def f := 1", dropped: [] });
});
