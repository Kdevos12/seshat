import assert from "node:assert/strict";
import { test } from "node:test";
import type { ValidationReport } from "@seshat/core";
import { HOLE_HEADER_CHARS, HOLE_HISTORY_CHARS, boundHistory, cutHeader, holeSessionLimit, readWork, stubsRegion } from "../src/index.ts";

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

test("Lean's own report is read: an added axiom, or a sorry outside the stubs, is not done", () => {
  const stub = stubsRegion([dep]);
  const aux = `${stub}\n\nlemma helper (n : Nat) : n = n := rfl`;
  const file = `import Mathlib\n\n${aux}\n\ntheorem hole (n : Nat) : n = n := by\n  exact helper n\n`;
  const lineOf = (needle: string): number => file.split("\n").findIndex((l) => l.includes(needle)) + 1;
  // the normal case: sorryAx through the stub, a sorry at the stub's line
  const good = report({ checked: file, axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: lineOf("sorry"), column: 2 }, goal: "" }] });
  assert.equal(readWork({ aux, proof: "exact helper n" }, good, [dep]).done, true);
  // an added axiom
  const axiom = report({ checked: file, axioms: ["propext", "sorryAx", "myAxiom"] });
  assert.match(readWork({ aux, proof: "exact helper n" }, axiom, [dep]).reason ?? "", /myAxiom/);
  // a sorry Lean reports in the hole's proof (the text scan was fooled, say by a macro)
  const moved = report({ checked: file, sorries: [{ pos: { line: lineOf("exact helper n"), column: 2 }, goal: "" }] });
  assert.match(readWork({ aux, proof: "exact helper n" }, moved, [dep]).reason ?? "", /sorry outside the given lemmas/);
  // a sorry Lean reports in the helper
  const inHelper = report({ checked: file, sorries: [{ pos: { line: lineOf("lemma helper"), column: 0 }, goal: "" }] });
  assert.match(readWork({ aux, proof: "exact helper n" }, inHelper, [dep]).reason ?? "", /sorry outside the given lemmas/);
});

test("the header is shown whole when short and cut after its first lines when long, and the history is bounded", () => {
  const short = "import Mathlib\nopen Nat\n";
  assert.equal(cutHeader(short), short);
  const long = ["import Mathlib", "open Nat", ...Array.from({ length: 400 }, (_, i) => `def d${i} : Nat := ${i}`)].join("\n");
  const cut = cutHeader(long);
  assert.ok(cut.startsWith("import Mathlib\nopen Nat\n"), "the imports stay");
  assert.ok(cut.length <= HOLE_HEADER_CHARS + 80);
  assert.match(cut, /more lines of the header are cut here/);
  assert.doesNotMatch(cut, /d399/);
  const entries = Array.from({ length: 10 }, (_, i) => `- session ${i + 1}: ${"x".repeat(300)}`);
  const kept = boundHistory(entries);
  assert.ok(kept.join("\n").length <= HOLE_HISTORY_CHARS);
  assert.ok(kept.length >= 1 && kept.at(-1) === entries.at(-1), "the newest is kept");
  assert.deepEqual(boundHistory(["- session 1: a"]), ["- session 1: a"]);
});

test("holeSessionLimit: one continuation with true; with \"progress\", more while each cut session brings Lean closer to done (VL3)", () => {
  const cut = (first: number, last: number) => ({ reason: "turns" as const, progress: { first, last } });
  // false and true are LP5's rule, whatever the progress.
  assert.equal(holeSessionLimit(false, 2, [cut(3, 1), cut(1, 0)]), 2);
  assert.equal(holeSessionLimit(true, 2, [cut(3, 3), cut(3, 3)]), 3);
  assert.equal(holeSessionLimit(true, 2, [cut(3, 1), { reason: "model_said" as const }]), 2);
  // Errors falling by one each session: one more session each time, past holeSessions.
  const falling = [cut(6, 5), cut(5, 4), cut(4, 3), cut(3, 2)];
  for (let k = 2; k <= falling.length; k++) assert.equal(holeSessionLimit("progress", 2, falling.slice(0, k)), k + 1, `after ${k} sessions`);
  // Flat errors: no continuation.
  assert.equal(holeSessionLimit("progress", 2, [cut(2, 2), cut(2, 2)]), 2);
  // An oscillation (fewer within the session, but not fewer than the session before) ends it, as do a session Lean did not check and one the model ended.
  assert.equal(holeSessionLimit("progress", 2, [cut(2, 1), cut(3, 1)]), 2);
  assert.equal(holeSessionLimit("progress", 2, [cut(2, 1), { reason: "turns" as const }]), 2);
  assert.equal(holeSessionLimit("progress", 2, [cut(2, 1), { reason: "model_said" as const, progress: { first: 2, last: 0 } }]), 2);
  // Before holeSessions is used up, the limit is holeSessions.
  assert.equal(holeSessionLimit("progress", 3, [cut(2, 2)]), 3);
});

test("readWork: a file whose aux holds a scratch command (#check, example) is not done", () => {
  const work = readWork({ aux: "#check Nat.succ\n\nexample : 1 = 1 := rfl", proof: "  simp" }, report({ leanStatus: "valid", holes: true }), []);
  assert.equal(work.done, false);
  assert.match(work.reason ?? "", /scratch commands/);
});
