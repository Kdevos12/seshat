import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allMagmas,
  compileMagmaStatement,
  evaluateWithLean,
  integerBattery,
  type MagmaStatement,
  recognizeStatement,
  type RecognizedStatement,
} from "../src/index.ts";
import { type Instance, SimulatedDecide } from "./simulated-lean.ts";

function statementOf(text: string): RecognizedStatement {
  const result = recognizeStatement(text);
  assert.ok("statement" in result);
  return result.statement;
}

const integers = (max: number) => integerBattery(max).objects;

describe("the Lean evaluator", () => {
  it("tries a statement about a number on each number: one file, then none for the negation", async () => {
    const lean = new SimulatedDecide({ truth: (i) => i.kind === "nat" && (i.value % 2 !== 1 || (i.value * i.value) % 2 === 1) });
    const result = await evaluateWithLean(lean, {
      header: "import Mathlib",
      statement: statementOf("(n : ℕ) (hn : n % 2 = 1) : n * n % 2 = 1"),
      objects: integers(20),
    });
    assert.deepEqual(result.verdicts, Array.from({ length: 21 }, () => true));
    assert.equal(result.unusable, undefined);
    // 21 numbers: a probe of 16, then the other 5.
    assert.equal(result.checks, 2);
    const file = lean.calls[0]?.code ?? "";
    assert.match(file, /^import Mathlib\n\nabbrev m11_stmt \(n : Nat\) : Prop := \(n % 2 = 1\) → \(n \* n % 2 = 1\)\nexample : @m11_stmt 0 := by decide\nexample : @m11_stmt 1 := by decide\n/);
    assert.equal(file.split("\n").filter((l) => l.startsWith("example")).length, 16);
  });

  it("asks for the negation of the statements that fail, and finds false what Lean proves false", async () => {
    const lean = new SimulatedDecide({ truth: (i) => i.kind === "nat" && i.value < 5 });
    const result = await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n < 5"), objects: integers(9), }, { batch: 4 });
    assert.deepEqual(result.verdicts, [true, true, true, true, true, false, false, false, false, false]);
    const negations = lean.calls.filter((c) => c.code.includes("example : ¬ @m11_stmt"));
    assert.equal(negations.length, 2);
    assert.ok(negations.every((c) => !c.code.includes("example : @m11_stmt")));
    // The file has no header line when the claim has none.
    assert.ok((lean.calls[0]?.code ?? "").startsWith("abbrev m11_stmt (n : Nat) : Prop := n < 5\n"));
  });

  it("leaves without a verdict what decide settles in neither way", async () => {
    const lean = new SimulatedDecide({ truth: (i) => (i.kind === "nat" && i.value === 7 ? undefined : true) });
    const result = await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : 0 ≤ n"), objects: integers(10) });
    assert.deepEqual(result.verdicts, [true, true, true, true, true, true, true, null, true, true, true]);
    assert.match(result.notes[7] ?? "", /settles neither the statement nor its negation: failed to reduce/);
    assert.equal(result.notes[6], undefined);
  });

  it("stops at the first file when the definition does not elaborate, or decide settles nothing", async () => {
    const broken = new SimulatedDecide({ truth: () => true, preambleError: "unknown identifier 'Foo'" });
    const first = await evaluateWithLean(broken, { header: "", statement: statementOf("(n : ℕ) : Foo n"), objects: integers(50) });
    assert.match(first.unusable ?? "", /does not elaborate: unknown identifier 'Foo'/);
    assert.equal(first.checks, 1);
    assert.ok(first.verdicts.every((v) => v === null));
    assert.ok(first.notes.every((n) => n?.includes("unknown identifier")));

    const hopeless = new SimulatedDecide({ truth: () => undefined });
    const second = await evaluateWithLean(hopeless, { header: "", statement: statementOf("(n : ℕ) : Nat.Prime n"), objects: integers(50) });
    assert.match(second.unusable ?? "", /decide settles none of the first 16 objects/);
    assert.equal(second.checks, 2);
    assert.equal(second.notes.length, 51);
    assert.ok(second.notes.every((n) => n !== undefined));
  });

  it("splits a file that goes over its time, down to one object if need be", async () => {
    const lean = new SimulatedDecide({ truth: () => true, timeoutAbove: 3 });
    const result = await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: integers(15) }, { batch: 16 });
    assert.ok(result.verdicts.every((v) => v === true));
    assert.ok(lean.calls.every((c) => c.code.split("\n").filter((l) => l.startsWith("example")).length <= 16));
    assert.ok(result.checks > 5);
    const never = new SimulatedDecide({ truth: () => true, timeoutAbove: 0 });
    const stuck = await evaluateWithLean(never, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: integers(2) }, { timeoutSec: 5 });
    assert.ok(stuck.verdicts.every((v) => v === null));
    assert.match(stuck.notes[0] ?? "", /went over 5 s/);
  });

  it("agrees with the TypeScript evaluator on the magmas of size 1 and 2, for a statement of laws", async () => {
    const statement = statementOf("(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x") as MagmaStatement;
    const check = compileMagmaStatement(statement);
    const truth = (i: Instance) => (i.kind === "magma" ? check(i.magma).verdict !== "fails" : undefined);
    const lean = new SimulatedDecide({ truth });
    const magmas = [...allMagmas(1), ...allMagmas(2)];
    const result = await evaluateWithLean(lean, { header: "import Mathlib", statement, objects: magmas });
    assert.deepEqual(result.verdicts, magmas.map((m) => check(m).verdict !== "fails"));
    assert.equal(result.verdicts.filter((v) => v === false).length, 1);
    assert.match(lean.calls[0]?.code ?? "", /abbrev m11_stmt \(M : Type\) \[Mul M\] : Prop := \(∀ x y : M, x \* y = x\) → ∀ x y : M, x \* y = y \* x\nexample : @m11_stmt \(Fin 1\) ⟨fun a b => \(\[0\] : List \(Fin 1\)\)\.getD \(a\.val \* 1 \+ b\.val\) 0⟩ := by decide/);
  });

  it("sends no more files than the cap, and says which objects have no verdict for that reason", async () => {
    const lean = new SimulatedDecide({ truth: (i) => i.kind === "nat" && i.value % 2 === 0 });
    const result = await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n % 2 = 0"), objects: integers(100) }, { maxFiles: 9 });
    // Without a cap the 101 numbers take 11 files: 2 for the probe, 6 for the others, 3 more for the negations.
    assert.equal(lean.calls.length, 9);
    assert.equal(result.checks, 9);
    const bare = result.verdicts.flatMap((v, i) => (v === null ? [i] : []));
    assert.ok(bare.length > 0 && bare.length < 101, `${bare.length} objects without a verdict`);
    assert.equal(result.capped, bare.length);
    for (const i of bare) assert.match(result.notes[i] ?? "", /no verdict: the limit of 9 files was reached/);
    // The verdicts that exist are Lean's, and right.
    result.verdicts.forEach((v, i) => {
      if (v !== null) assert.equal(v, i % 2 === 0, `number ${i}`);
    });
    assert.equal(result.unusable, undefined);
    // A cap that is not reached changes nothing.
    const free = await evaluateWithLean(new SimulatedDecide({ truth: (i) => i.kind === "nat" && i.value % 2 === 0 }), { header: "", statement: statementOf("(n : ℕ) : n % 2 = 0"), objects: integers(100) }, { maxFiles: 11 });
    assert.equal(free.checks, 11);
    assert.equal(free.capped, undefined);
    assert.ok(free.verdicts.every((v) => v !== null));
  });

  it("gives up on a statement whose files keep timing out when the cap is reached, and says so", async () => {
    const never = new SimulatedDecide({ truth: () => true, timeoutAbove: 0 });
    const result = await evaluateWithLean(never, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: integers(200) }, { maxFiles: 20 });
    // Without a cap the probe alone takes 31 files to split down to one object, and the negations 31 more.
    assert.equal(never.calls.length, 20);
    assert.match(result.unusable ?? "", /the limit of 20 files was reached before any object had a verdict/);
    assert.ok(result.verdicts.every((v) => v === null));
  });

  it("sends nothing when the cap is zero", async () => {
    const lean = new SimulatedDecide({ truth: () => true });
    const result = await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: integers(5) }, { maxFiles: 0 });
    assert.equal(lean.calls.length, 0);
    assert.equal(result.checks, 0);
    assert.match(result.unusable ?? "", /the limit of 0 files was reached before any object had a verdict/);
  });

  it("refuses objects that do not fit the statement", async () => {
    const lean = new SimulatedDecide({ truth: () => true });
    await assert.rejects(evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: allMagmas(1) }), /non-negative integers/);
    await assert.rejects(evaluateWithLean(lean, { header: "", statement: statementOf("(M : Type) [Mul M] : ∀ x : M, x = x"), objects: integers(2) }), /on magmas/);
    assert.deepEqual((await evaluateWithLean(lean, { header: "", statement: statementOf("(n : ℕ) : n = n"), objects: [] })).verdicts, []);
  });
});
