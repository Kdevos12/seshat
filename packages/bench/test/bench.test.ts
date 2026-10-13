import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildIndex, DISCRETE, readIndex, sample, scanCheckout, select, writeIndex } from "../src/index.ts";

const FILE = `/-
Copyright 2025 The Formal Conjectures Authors.
-/
import FormalConjectures.Util.ProblemImports

namespace Clean

@[category research solved, AMS 11]
theorem solved_two (n : ℕ) : n * 1 = n := by
  sorry

@[category research solved, AMS 11]
theorem proved_here (n : ℕ) : 0 + n = n := by
  simp

@[category research solved, AMS 11]
theorem unknown_answer : answer(sorry) ↔ True := by
  sorry

@[category research solved, AMS 11 30]
theorem analytic (x : ℕ) : x = x := by
  sorry

@[category research open, AMS 11]
theorem open_one : answer(sorry) ↔ ∃ n : ℕ, n = n := by
  sorry

@[simp, category API, AMS 11]
lemma api_lemma : ∀ n, n + 0 = n
  | 0 => rfl
  | n + 1 => rfl

end Clean

namespace Toy

def broken : ℕ := sorry

/-- A solved problem with a proof elsewhere. -/
@[category research solved, AMS 5 11,
formal_proof using lean4 at "https://example.org/proof.lean"]
theorem solved_one : answer(True) ↔ ∀ n : ℕ, n + 0 = n := by
  sorry

end Toy
`;

function toyCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "mh-bench-"));
  mkdirSync(join(root, "FormalConjectures", "Toy"), { recursive: true });
  writeFileSync(join(root, "FormalConjectures", "Toy", "Toy.lean"), FILE);
  writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
  return root;
}

describe("scanCheckout", () => {
  it("reads categories, AMS codes, formal proofs, answers and unprovable context", () => {
    const { problems, errors } = scanCheckout(toyCheckout());
    assert.deepEqual(errors, ["FormalConjectures/Toy/Toy.lean: theorem Clean.api_lemma: no proof found after ':='"]);
    const byName = new Map(problems.map((p) => [p.fullName, p]));
    const one = byName.get("Toy.solved_one");
    assert.equal(one?.id, "FormalConjectures/Toy/Toy.lean#Toy.solved_one");
    assert.equal(one?.category, "research solved");
    assert.deepEqual(one?.ams, [5, 11]);
    assert.deepEqual(one?.formalProof, { kind: "lean4", url: "https://example.org/proof.lean" });
    assert.equal(one?.answer, "True");
    assert.equal(one?.line, FILE.split("\n").indexOf("theorem solved_one : answer(True) ↔ ∀ n : ℕ, n + 0 = n := by") + 1);
    assert.equal(one?.statement, ": answer(True) ↔ ∀ n : ℕ, n + 0 = n");
    assert.deepEqual(one?.unprovedBefore, ["broken"]);
    assert.deepEqual(one?.imports, ["FormalConjectures.Util.ProblemImports"]);
    assert.equal(byName.get("Clean.proved_here")?.proofInFile, true);
    assert.equal(byName.get("Clean.unknown_answer")?.sorryInStatement, true);
    assert.equal(byName.get("Clean.open_one")?.category, "research open");
  });
});

describe("select and sample", () => {
  it("keeps solved discrete problems that can be proved from a clean context", () => {
    const { problems } = scanCheckout(toyCheckout());
    // proved_here is proved in the file; unknown_answer has no answer; analytic is also complex
    // analysis (AMS 30); open_one is open; solved_one sits below a sorried definition.
    assert.deepEqual(select(problems, DISCRETE).map((p) => p.fullName), ["Clean.solved_two"]);
    assert.deepEqual(
      select(problems, { ...DISCRETE, includeProofInFile: true, excludeUnprovedBefore: false }).map((p) => p.fullName),
      ["Clean.solved_two", "Clean.proved_here", "Toy.solved_one"],
    );
  });

  it("samples the same problems for the same seed", () => {
    const { problems } = scanCheckout(toyCheckout());
    assert.deepEqual(sample(problems, 3, "s1"), sample([...problems].reverse(), 3, "s1"));
    assert.equal(sample(problems, 3, "s1").length, 3);
    assert.notDeepEqual(sample(problems, 2, "s1").map((p) => p.id), sample(problems, 2, "s2").map((p) => p.id));
  });
});

describe("bench index", () => {
  it("round-trips and refuses an edited index", () => {
    const root = toyCheckout();
    const index = buildIndex(root, "toy");
    assert.equal(index.counts.selected, 1);
    assert.equal(index.source.lean, "leanprover/lean4:v4.27.0");
    const path = join(root, "toy.json");
    writeIndex(path, index);
    assert.equal(readIndex(path).hash, index.hash);
    writeFileSync(path, readFileSync(path, "utf8").replace("solved_two", "solved_2"));
    assert.throws(() => readIndex(path), /hash does not match/);
  });
});

// The committed index must be what the builder makes from the pinned snapshot.
const snapshot = process.env.FC_BENCH_V1_DIR ?? join(import.meta.dirname, "../../../../google-deepmind/formal-conjectures-bench-v1");
const committed = join(import.meta.dirname, "../../../bench/fc-bench-v1-discrete.json");

describe("the committed bench index", { skip: !existsSync(join(snapshot, "FormalConjectures")) }, () => {
  it("is reproduced from bench-v1-lean4.27.0", () => {
    const rev = execFileSync("git", ["-C", snapshot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(rev, "7a41db3d761324599812d6ca6cb6a9f311046dc7");
    const fresh = buildIndex(snapshot, "fc-bench-v1-discrete");
    assert.equal(fresh.hash, readIndex(committed).hash);
  });
});
