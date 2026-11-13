import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AdmissionInfrastructureError, buildGraded, gradedIndex, isGraded, lakeAdmitter, outOfReachList, readGraded, sample, tagReach, writeGraded } from "../src/index.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "mh-graded-"));

/** A formal-conjectures fixture: textbook and test theorems (grade A), solved research ones with a formal proof elsewhere (grade C). */
function fcFixture(): string {
  const root = dir();
  mkdirSync(join(root, "FormalConjectures", "Toy"), { recursive: true });
  const theorems: string[] = [];
  for (let i = 0; i < 4; i++) theorems.push(`@[category textbook, AMS 11]\ntheorem text_${i} (n : ℕ) : n + ${i} = ${i} + n := by\n  sorry\n`);
  theorems.push(`@[category test, AMS 11]\ntheorem test_0 (n : ℕ) : n = n := by\n  sorry\n`);
  theorems.push(`@[category textbook, AMS 30]\ntheorem analytic (n : ℕ) : n = n := by\n  sorry\n`);
  theorems.push(`@[category textbook, AMS 11]\ntheorem proved_here (n : ℕ) : n = n := by\n  rfl\n`);
  for (let i = 0; i < 5; i++) theorems.push(`@[category research solved, AMS 11,\nformal_proof using lean4 at "https://example.org/${i}.lean"]\ntheorem solved_${i} (n : ℕ) : n * ${i} = ${i} * n := by\n  sorry\n`);
  theorems.push(`@[category research solved, AMS 11]\ntheorem solved_no_proof (n : ℕ) : n = n := by\n  sorry\n`);
  writeFileSync(join(root, "FormalConjectures", "Toy", "Toy.lean"), `import FormalConjectures.Util.ProblemImports\n\nnamespace Toy\n\n${theorems.join("\n")}\nend Toy\n`);
  writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
  writeFileSync(join(root, "LICENSE"), "                                 Apache License\n                           Version 2.0, January 2004\n");
  return root;
}

/** A PutnamBench fixture: one file per problem, binders at column 0, three of them with an unproved answer definition. */
function putnamFixture(): string {
  const root = dir();
  mkdirSync(join(root, "lean4", "src"), { recursive: true });
  for (let i = 0; i < 12; i++) {
    const answer = i % 4 === 0 ? `abbrev putnam_${i}_solution : ℕ := sorry\n\n` : "";
    writeFileSync(join(root, "lean4", "src", `putnam_${i}.lean`), `import Mathlib\n\n${answer}/-- Problem ${i}. -/\ntheorem putnam_${i}\n(n : ℕ)\n(h : n > ${i})\n: n + 0 = n :=\nsorry\n`);
  }
  writeFileSync(join(root, "lean4", "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
  writeFileSync(join(root, "lean4", "LICENSE"), "Apache License\n");
  return root;
}

describe("buildGraded", () => {
  const fc = fcFixture();
  const putnam = putnamFixture();

  it("draws the three grades from local checkouts and records what a run needs to know", () => {
    const bench = buildGraded({ fc, putnam, seed: "s1", sizeB: 5, sizeC: 3 });
    const of = (g: string) => bench.entries.filter((e) => e.grade === g);
    assert.equal(of("A").length, 5, "textbook and test theorems with discrete codes, none proved in the file");
    assert.equal(of("B").length, 5);
    assert.equal(of("C").length, 3);
    assert.equal(bench.grades.B.candidates, 9, "the three problems whose answer is still sorry are not candidates");
    assert.equal(isGraded(bench), true);
    const entry = of("B")[0];
    assert.ok(entry);
    assert.equal(entry.source, "putnambench");
    assert.equal(entry.sourceCommit, bench.sources.putnambench?.rev);
    assert.equal(entry.licence, "Apache-2.0");
    assert.match(entry.statementHash, /^[0-9a-f]{64}$/);
    assert.equal(entry.category, "competition");
    assert.equal(bench.sources.putnambench?.lean, "leanprover/lean4:v4.27.0");
    assert.ok(bench.entries.every((e) => e.admission === "unchecked"), "no Lean: every entry is unchecked");
  });

  it("gives the same sample for the same seed and another for another seed; the sample is the seeded prefix", () => {
    const ids = (seed: string) => buildGraded({ fc, putnam, seed, sizeB: 4, sizeC: 3 }).entries.filter((e) => e.grade === "B").map((e) => e.id);
    assert.deepEqual(ids("s1"), ids("s1"));
    assert.notDeepEqual(ids("s1"), ids("s2"));
    assert.equal(buildGraded({ fc, putnam, seed: "s1" }).hash, buildGraded({ fc, putnam, seed: "s1" }).hash);
    const bench = buildGraded({ fc, putnam, seed: "s1", sizeB: 4 });
    const all = buildGraded({ fc, putnam, seed: "s1", sizeB: 100 }).entries.filter((e) => e.grade === "B");
    assert.deepEqual(bench.entries.filter((e) => e.grade === "B").map((e) => e.id), sample(all, 4, "s1\nB").map((e) => e.id));
  });

  it("admits only statements Lean reads, and fills the sample from the next ones when one is left out", () => {
    const seen: string[] = [];
    const bench = buildGraded({
      fc,
      putnam,
      seed: "s1",
      sizeB: 4,
      sizeC: 2,
      admit: (entry, snippet) => {
        seen.push(snippet);
        return !entry.fullName.endsWith("_5") && !entry.fullName.endsWith("solved_1");
      },
    });
    const b = bench.entries.filter((e) => e.grade === "B");
    assert.equal(b.length, 4);
    assert.ok(b.every((e) => e.admission === "admitted" && !e.id.includes("putnam_5")));
    assert.equal(bench.grades.B.rejected.length <= 1, true);
    assert.ok(bench.entries.filter((e) => e.grade === "C").every((e) => !e.fullName.endsWith("solved_1")));
    const snippet = seen.find((s) => s.includes("putnam_"));
    assert.ok(snippet?.trimEnd().endsWith("sorry"), "the snippet is the file up to the theorem, its proof sorry");
  });

  it("is refused by a run until its entries are admitted, unless told otherwise", () => {
    const bench = buildGraded({ fc, putnam, seed: "s1", sizeB: 3 });
    assert.throws(() => gradedIndex(bench, "B"), /never admitted/);
    const index = gradedIndex(bench, "B", { allowUnchecked: true });
    assert.equal(index.benchId, "graded-v1/B");
    assert.equal(index.problems.length, 3);
    assert.equal(index.source.repo, bench.sources.putnambench?.repo);
    assert.ok(!("grade" in (index.problems[0] as object)));
    assert.throws(() => gradedIndex(bench, "D"), /one of A, B, C/);
    const admitted = buildGraded({ fc, putnam, seed: "s1", sizeB: 3, admit: () => true });
    assert.equal(gradedIndex(admitted, "B").problems.length, 3);
  });

  it("writes a file whose hash is checked when it is read", () => {
    const file = join(dir(), "graded-v1.json");
    const bench = buildGraded({ fc, putnam, seed: "s1", sizeB: 3 });
    writeGraded(file, bench);
    assert.equal(readGraded(file).hash, bench.hash);
    writeFileSync(file, JSON.stringify({ ...bench, seed: "other" }));
    assert.throws(() => readGraded(file), /hash does not match/);
  });
});

describe("the problems out of reach at a small budget (PA6)", () => {
  const fc = fcFixture();
  const putnam = putnamFixture();
  const list = [{ id: "putnam_1", reason: "absent from Mathlib" }];

  it("commits the two problems the audit named, and an absent list means everything is in reach", () => {
    assert.deepEqual(outOfReachList().map((x) => x.id), ["putnam_1967_a5", "putnam_2025_b5"]);
    assert.deepEqual(outOfReachList(join(dir(), "none.json")), []);
  });

  it("tags the entries on build, matching the entry's full name, and leaves the others alone", () => {
    const bench = buildGraded({ fc, putnam, seed: "s", sizeB: 100, outOfReach: list });
    const tagged = bench.entries.filter((e) => e.reach !== undefined);
    assert.deepEqual(tagged.map((e) => [e.fullName, e.reach, e.reachReason]), [["putnam_1", "small_budget_out_of_reach", "absent from Mathlib"]]);
    const index = gradedIndex(bench, "B", { allowUnchecked: true });
    assert.equal(index.problems.filter((p) => p.reach !== undefined).length, 1, "the index carries the tag to the run");
  });

  it("tags on read an index built without the list, and keeps a tag it already carries", () => {
    const bench = buildGraded({ fc, putnam, seed: "s", sizeB: 100, outOfReach: [] });
    assert.ok(bench.entries.every((e) => e.reach === undefined));
    const path = join(dir(), "graded.json");
    writeGraded(path, bench);
    assert.ok(readGraded(path).entries.every((e) => e.reach === undefined), "the committed list names none of the fixture's problems");
    const read = readGraded(path, { outOfReach: list });
    assert.deepEqual(read.entries.filter((e) => e.reach !== undefined).map((e) => e.fullName), ["putnam_1"]);
    assert.equal(tagReach(read.entries, [{ id: "putnam_1", reason: "other" }]).find((e) => e.fullName === "putnam_1")?.reachReason, "absent from Mathlib");
  });
});

describe("lakeAdmitter", () => {
  const fake = (script: string): { bin: string; lake: string } => {
    const bin = dir();
    const lake = join(bin, "lake");
    writeFileSync(lake, `#!/bin/sh\n${script}\n`);
    chmodSync(lake, 0o755);
    return { bin, lake };
  };
  const entry = {} as never;

  it("admits when the fake lake exits 0 and rejects the statement Lean errors on", () => {
    const { bin, lake } = fake('grep -q BAD "$3" && { echo "error: unknown identifier" >&2; exit 1; }\nexit 0');
    const admit = lakeAdmitter(bin, { lake });
    assert.equal(admit(entry, "theorem a : True := sorry\n"), true);
    assert.equal(admit(entry, "theorem a : BAD := sorry\n"), false);
  });

  it("stops the build when the probe does not compile, instead of rejecting every statement", () => {
    const { bin, lake } = fake('echo "error: unknown package Mathlib" >&2; exit 1');
    assert.throws(() => lakeAdmitter(bin, { lake }), (e: unknown) => e instanceof AdmissionInfrastructureError && /probe statement does not compile/.test((e as Error).message));
  });

  it("treats a timeout and a missing lake as infrastructure failures, not rejections", () => {
    const slow = fake('case "$(cat "$3")" in *seshat_admission_probe*) exit 0;; esac\nsleep 5');
    const admit = lakeAdmitter(slow.bin, { lake: slow.lake, timeoutMs: 300 });
    assert.throws(() => admit(entry, "theorem a : True := sorry\n"), AdmissionInfrastructureError);
    assert.throws(() => lakeAdmitter(slow.bin, { lake: join(slow.bin, "nope") }), /not installed/);
  });

  it("makes the build fail when a grade ends with no admitted entry", () => {
    assert.throws(() => buildGraded({ fc: fcFixture(), putnam: putnamFixture(), seed: "s", sizeB: 2, sizeC: 2, admit: (e) => !e.id.includes("putnam_") }), /grade B has no admitted entry/);
  });
});
