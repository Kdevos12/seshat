import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTable, defaultColumns } from "@seshat/induction";
import { lakatosRepair, splitStatement, withPremise } from "../src/index.ts";

const numbers = Array.from({ length: 61 }, (_, i) => i);
const table = () => buildTable({ family: "integers", objects: numbers, objectIds: numbers.map(String), columns: defaultColumns("integers") });
const col = (t: Awaited<ReturnType<typeof table>>, name: string, n: number): number | boolean | null => t.rows[n]?.[t.columns.findIndex((c) => c.name === name)] as number | boolean | null;

describe("statements with a premise", () => {
  it("adds a hypothesis after the binders, outside brackets", () => {
    assert.deepEqual(splitStatement("(n : ℕ) (h : n % 2 = 1) : (Nat.divisors n).card ≤ 2"), { binders: "(n : ℕ) (h : n % 2 = 1)", type: "(Nat.divisors n).card ≤ 2" });
    assert.equal(withPremise("(n : ℕ) : n ≤ n * n", "¬ (n = 0)"), "(n : ℕ) (h_repair : ¬ (n = 0)) : n ≤ n * n");
    assert.equal(splitStatement("(n : ℕ) (h : n := 2)"), undefined);
  });
});

describe("Lakatos-style repair of a refuted conjecture", () => {
  // The conjecture "an odd number from 3 on has at most two divisors" is false of 9, 15, 21...
  const verdicts = (t: Awaited<ReturnType<typeof table>>) => numbers.map((n) => (n % 2 === 1 && n >= 3 ? ((col(t, "divisors", n) as number) <= 2 ? "1" : "0") : ".")).join("");

  it("bars the exceptions exactly when a concept of the table separates them, and keeps all that held", async () => {
    const t = await table();
    const result = lakatosRepair({ table: t, verdicts: verdicts(t), informal: "an odd number from 3 on has at most two divisors", statement: "(n : ℕ) (h : n % 2 = 1) (h3 : 3 ≤ n) : (Nat.divisors n).card ≤ 2" });
    const odd = numbers.filter((n) => n % 2 === 1 && n >= 3);
    const composite = odd.filter((n) => (col(t, "divisors", n) as number) > 2);
    assert.equal(result.counterexamples, composite.length);
    assert.equal(result.held, odd.length - composite.length);
    const [option] = result.options;
    assert.equal(option?.kind, "exception_barring");
    assert.equal(option?.exact, true);
    assert.deepEqual([option?.retained, option?.lost, option?.excluded], [result.held, 0, composite.length]);
    assert.equal(option?.concept.atoms.length, 1, "the simplest concept is one test");
    // The concept holds of every counterexample and of nothing that held.
    const tests = (n: number): boolean => option?.concept.atoms.every((a) => {
      const v = col(t, a.column, n);
      return a.op === "is" ? v === true : a.op === "isnt" ? v === false : a.op === "=" ? v === a.value : a.op === ">=" ? (v as number) >= (a.value as number) : (v as number) <= (a.value as number);
    }) ?? false;
    assert.ok(composite.every(tests));
    assert.ok(odd.filter((n) => !composite.includes(n)).every((n) => !tests(n)));
    // The repaired statement is the old one with the premise, in Lean.
    assert.match(option?.statement ?? "", /^\(n : ℕ\) \(h : n % 2 = 1\) \(h3 : 3 ≤ n\) \(h_repair : ¬ \(.+\)\) : \(Nat\.divisors n\)\.card ≤ 2$/);
    assert.match(option?.informal ?? "", /an odd number from 3 on has at most two divisors, for the objects that do not satisfy/);
  });

  it("bars the monsters with one natural concept when no concept separates the exceptions exactly", async () => {
    const t = await table();
    // Only 9, 15 and 25 are counterexamples; 21, 27, 33... are said to hold: no test of the table tells them apart exactly.
    const v = numbers.map((n) => (n % 2 === 1 && n >= 3 ? ([9, 15, 25].includes(n) ? "0" : "1") : ".")).join("");
    const result = lakatosRepair({ table: t, verdicts: v, informal: "C", maxAtoms: 1 });
    const [option] = result.options;
    assert.equal(option?.kind, "monster_barring");
    assert.equal(option?.exact, false);
    assert.ok((option?.lost ?? 0) > 0 && (option?.retained ?? 0) >= result.held / 2);
    assert.equal(option?.excluded, 3);
    assert.equal((option?.retained ?? 0) + (option?.lost ?? 0), result.held);
  });

  it("gives no repair when nothing separates, when nothing failed, or when nothing held", async () => {
    const t = await table();
    assert.match(lakatosRepair({ table: t, verdicts: ".".repeat(61) }).reason ?? "", /no counterexample/);
    assert.match(lakatosRepair({ table: t, verdicts: "0".repeat(61) }).reason ?? "", /holds on no object/);
    // A conjecture that fails on half of everything, with a half that holds, and no concept keeping half: for the other half, a length mismatch is an error.
    assert.throws(() => lakatosRepair({ table: t, verdicts: "01" }), /one for each object/);
  });

  it("writes the premise with the statement's own name for the object", async () => {
    const t = await table();
    const result = lakatosRepair({ table: t, verdicts: verdicts(t), statement: "(m : ℕ) : m = m", variable: "m" });
    assert.match(result.options[0]?.premise ?? "", /\bm\b/);
    assert.ok(!/\bn\b/.test(result.options[0]?.premise ?? ""));
  });

  it("leaves the statement out, but keeps the concept in words, when a column has no Lean form", async () => {
    const t = await buildTable({ family: "integers", objects: numbers, objectIds: numbers.map(String), columns: [{ name: "n", program: "(n) => n" }, { name: "sqfree", program: "(n) => n > 0 && [4,9,25,49].every((q) => n % q !== 0)", description: "n is squarefree" }] });
    const v = numbers.map((n) => (n >= 1 ? (n === 8 || n === 12 || n === 18 || n === 20 ? "0" : "1") : ".")).join("");
    const result = lakatosRepair({ table: t, verdicts: v, statement: "(n : ℕ) : P n", informal: "P" });
    const [option] = result.options;
    assert.ok(option !== undefined);
    assert.equal(option.statement, undefined);
    assert.equal(option.premise, undefined);
    assert.match(option.concept.text, /./);
  });
});
