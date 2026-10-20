import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allMagmas,
  compileMagmaStatement,
  leanArguments,
  leanDefinition,
  leanMagmaInstance,
  type MagmaStatement,
  recognizeStatement,
  type RecognizedStatement,
  statementBody,
  statementSignature,
  statementStructure,
} from "../src/index.ts";

function recognized(text: string): RecognizedStatement {
  const result = recognizeStatement(text);
  assert.ok("statement" in result, `not recognized: ${"reason" in result ? result.reason : ""}`);
  return result.statement;
}

function reason(text: string): string {
  const result = recognizeStatement(text);
  assert.ok("reason" in result, `recognized: ${text}`);
  return result.reason;
}

describe("recognizing a statement of magmas", () => {
  it("reads hypotheses as binders, as premises, or none at all", () => {
    const binders = recognized("(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y z : M, x * y * z = x * (y * z)") as MagmaStatement;
    assert.equal(binders.kind, "magma");
    assert.equal(binders.type, "M");
    assert.equal(binders.operation, "Mul");
    assert.equal(binders.hypotheses.length, 1);
    assert.equal(statementBody(binders), "(∀ x y : M, x * y = x) → ∀ x y z : M, x * y * z = x * (y * z)");

    const premises = recognized("(M : Type) [Mul M] : (∀ x y : M, x * y = x) → ∀ x y z : M, x * y * z = x * (y * z)");
    assert.equal(statementBody(premises), statementBody(binders));

    const bare = recognized("(M : Type) [Mul M] : ∀ x y : M, x * y = y * x") as MagmaStatement;
    assert.equal(bare.hypotheses.length, 0);
    assert.equal(statementSignature(bare), "(M : Type) [Mul M] : ∀ x y : M, x * y = y * x");
    assert.equal(statementSignature(binders), "(M : Type) [Mul M] (h1 : ∀ x y : M, x * y = x) : ∀ x y z : M, x * y * z = x * (y * z)");
  });

  it("takes the forms of the equational theories project: implicit types, Magma and ◇, two hypotheses", () => {
    const etp = recognized("{G : Type*} [Magma G] (h1 : ∀ x y : G, x ◇ y = x) (h2 : ∀ x : G, x ◇ x = x) : ∀ x y : G, y ◇ x = y") as MagmaStatement;
    assert.equal(etp.operation, "Magma");
    assert.equal(etp.hypotheses.length, 2);
    assert.equal(leanDefinition(etp), "abbrev m11_stmt (G : Type) [Magma G] : Prop := (∀ x y : G, x ◇ y = x) → (∀ x : G, x ◇ x = x) → ∀ x y : G, y ◇ x = y");
    assert.equal(recognized("(M : Type u) [inst : Mul M] : ∀ x : M, x * x = x").kind, "magma");
  });

  it("says why it does not recognize a statement", () => {
    assert.match(reason("(M : Type) [Group M] : ∀ x : M, x * 1 = x"), /needs the instance \[Mul M\] or \[Magma M\]/);
    assert.match(reason("(M : Type) [Mul M] (x : M) : x * x = x"), /hypothesis x is not a law/);
    assert.match(reason("(M : Type) [Mul M] (h : ∀ x : M, x + x = x) : ∀ x : M, x * x = x"), /'\+' is not part/);
    assert.match(reason("(M : Type) [Mul M] : ∀ x : N, x * x = x"), /quantifies over N, not over M/);
    assert.match(reason("(x y : ℤ) : x + y = y + x"), /neither a type for a magma nor a natural number/);
    assert.match(reason(": 1 + 1 = 2"), /no variable to try/);
    assert.match(reason("(n : ℕ"), /not closed/);
  });

  it("evaluates a statement on magmas: it holds, holds vacuously, or fails with a witness", () => {
    const statement = recognized("(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x") as MagmaStatement;
    const check = compileMagmaStatement(statement);
    const verdicts = new Map(allMagmas(2).map((m) => [m.id, check(m).verdict] as const));
    // The left-zero magma satisfies the hypothesis and is not commutative; a commutative magma with a right zero does not satisfy it.
    assert.equal(check({ size: 2, table: [0, 0, 1, 1] }).verdict, "fails");
    assert.deepEqual(check({ size: 2, table: [0, 0, 1, 1] }).witness, [0, 1]);
    assert.equal(check({ size: 2, table: [0, 1, 1, 0] }).verdict, "vacuous");
    assert.equal(check({ size: 1, table: [0] }).verdict, "holds");
    assert.equal([...verdicts.values()].filter((v) => v === "fails").length, 1);
  });
});

describe("the sort of the type of a magma statement", () => {
  it("is kept as written", () => {
    for (const sort of ["Type", "Type 0", "Type*", "Type _", "Type u", "Type 1"]) {
      assert.equal((recognized(`(M : ${sort}) [Mul M] : ∀ x y : M, x * y = y * x`) as MagmaStatement).sort, sort);
    }
  });

  it("is in the structure of a universe-polymorphic statement (Type*), and not in the definition the evaluator tries on Fin n", () => {
    const starred = recognized("(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x");
    assert.equal(statementStructure(starred), "(M : Type*) [Mul M]");
    assert.equal(statementStructure(recognized("(M : Type u) [Mul M] : ∀ x : M, x * x = x")), "(M : Type*) [Mul M]");
    assert.equal(statementStructure(recognized("(M : Type) [Mul M] : ∀ x : M, x * x = x")), "(M : Type) [Mul M]");
    assert.equal(statementStructure(recognized("(M : Type 0) [Mul M] : ∀ x : M, x * x = x")), "(M : Type) [Mul M]");
    // The evaluator instantiates the definition at `Fin n : Type`, whatever the claim's sort.
    assert.equal(leanDefinition(starred), "abbrev m11_stmt (M : Type) [Mul M] : Prop := (∀ x y : M, x * y = x) → ∀ x y : M, x * y = y * x");
  });
});

describe("an arrow inside the scope of a quantifier", () => {
  // Lean reads `∀ x : M, p → ∀ y : M, q` as `∀ x : M, (p → ∀ y : M, q)`: the body of a quantifier
  // reaches as far right as the text goes. Splitting at the arrow would turn it into an implication
  // between two laws, which is another statement.
  it("is not read as an implication between the laws on its sides", () => {
    assert.match(reason("(M : Type) [Mul M] : ∀ x : M, x * x = x → ∀ y : M, y * y = y"), /the arrow after '∀ x : M, x \* x = x' is inside the scope of the quantifier/);
    assert.match(reason("(M : Type) [Mul M] (h : ∀ x : M, x * x = x) : (∀ x y : M, x * y = x) → ∀ z : M, z * z = z → ∀ w : M, w * w = w"), /the arrow after/);
    assert.match(reason("(M : Type) [Mul M] : ∀ x y : M, x * y = y * x -> ∀ z : M, z * z = z"), /the arrow after/);
    // ∃ and fun have a body that reaches to the end too, and an identifier that merely starts with fun is no binder.
    assert.match(reason("(M : Type) [Mul M] : ∃ x : M, x * x = x → ∀ y : M, y * y = y"), /the arrow after '∃ x : M, x \* x = x'/);
    assert.match(reason("(M : Type) [Mul M] : fun x : M => x * x = x → ∀ y : M, y * y = y"), /the arrow after 'fun x : M => x \* x = x'/);
    assert.doesNotMatch(reason("(M : Type) [Mul M] : funny → ∀ y : M, y * y = y"), /the arrow after/);
  });

  it("is read as one when the premise is in parentheses", () => {
    const parenthesized = recognized("(M : Type) [Mul M] : (∀ x : M, x * x = x) → ∀ y : M, y * y = y") as MagmaStatement;
    assert.deepEqual(parenthesized.hypotheses.map((h) => h.text), ["∀ x : M, x * x = x"]);
    assert.equal(parenthesized.conclusion.text, "∀ y : M, y * y = y");
    const chain = recognized("(M : Type) [Mul M] : (∀ x : M, x * x = x) → (∀ x y : M, x * y = x) → ∀ z : M, z * z = z") as MagmaStatement;
    assert.equal(chain.hypotheses.length, 2);
  });
});

describe("recognizing a statement about a natural number", () => {
  it("makes the hypotheses premises of the conclusion", () => {
    const withHypothesis = recognized("(n : ℕ) (hn : n % 2 = 1) : n * n % 2 = 1");
    assert.deepEqual(withHypothesis, { kind: "nat", variable: "n", body: "(n % 2 = 1) → (n * n % 2 = 1)" });
    assert.deepEqual(recognized("(n : ℕ) : n + 0 = n"), { kind: "nat", variable: "n", body: "n + 0 = n" });
    assert.deepEqual(recognized(": ∀ n : ℕ, n < 5 → n * n < 25"), { kind: "nat", variable: "n", body: "n < 5 → n * n < 25" });
    assert.deepEqual(recognized("{n : Nat} : n ≤ n * n"), { kind: "nat", variable: "n", body: "n ≤ n * n" });
    assert.equal(leanDefinition(withHypothesis), "abbrev m11_stmt (n : Nat) : Prop := (n % 2 = 1) → (n * n % 2 = 1)");
    assert.equal(statementSignature(withHypothesis), "(n : ℕ) : (n % 2 = 1) → (n * n % 2 = 1)");
  });

  it("does not try a statement about two numbers, or one that uses the proof of a hypothesis", () => {
    assert.match(reason("(n : ℕ) (m : ℕ) : n + m = m + n"), /second variable/);
    assert.match(reason("(n : ℕ) (h : 0 < n) : n ≠ 0 ∧ h = h"), /proof h of a hypothesis/);
    assert.match(reason("(n : ℕ) [Fact (0 < n)] : 0 < n"), /not a hypothesis/);
  });
});

describe("a statement that holds a token the validator forbids", () => {
  // The body of a statement about a number is written into `abbrev m11_stmt ... := <body>` in a Lean
  // file: a body that ends the declaration could add commands, and the prover's regions are screened
  // for exactly these tokens by the validator.
  const hostile = "(n : ℕ) : n = n\n#eval IO.Process.exit 7\nmacro_rules | `(tactic| rfl) => `(tactic| skip)";

  it("is not recognized, and the reason names the tokens", () => {
    const why = reason(hostile);
    assert.match(why, /^the statement holds the tokens '#eval', 'macro_rules', 'tactic', 'IO', and a statement with a token that the validator refuses in a proof is not written into a Lean file$/);
    assert.match(reason("(n : ℕ) (h : n = n #exit) : n = n"), /the statement holds the token '#exit'/);
    assert.match(reason(": ∀ n : ℕ, n = n #eval 1"), /the statement holds the token '#eval'/);
    assert.match(reason("(n : ℕ) : _root_.Lean.Meta.foo n = 1"), /the statement holds the token 'Lean',/);
    assert.match(reason("(M : Type) [Mul M] : ∀ x : M, x * x = x\n#eval 1"), /the statement holds the token '#eval'/);
  });

  it("is judged on the text Lean will read: a token in a comment or a string is blanked, and does not count", () => {
    assert.deepEqual(recognized("(n : ℕ) : n = n -- #eval 1"), { kind: "nat", variable: "n", body: "n = n" });
    assert.deepEqual(recognized("(n : ℕ) : n = n /- macro_rules -/ ∧ True"), { kind: "nat", variable: "n", body: "n = n ∧ True" });
  });

  it("leaves a statement with names that only contain the tokens alone", () => {
    assert.equal(recognized("(n : ℕ) (h : Nat.Prime n) : n = 2 ∨ n % 2 = 1").kind, "nat");
    assert.equal(recognized("(n : ℕ) : Nat.sqrt n * Nat.sqrt n ≤ n").kind, "nat");
    assert.equal(recognized("(n : ℕ) : n.sorry_free = n.IOx").kind, "nat");
  });
});

describe("the Lean text for an object", () => {
  it("writes a magma as an instance on Fin, and a number as itself", () => {
    const magma = { size: 2, table: [0, 1, 1, 0] };
    assert.equal(leanMagmaInstance(magma), "⟨fun a b => ([0, 1, 1, 0] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩");
    const statement = recognized("(M : Type) [Mul M] : ∀ x y : M, x * y = y * x");
    assert.equal(leanArguments(statement, magma), "(Fin 2) ⟨fun a b => ([0, 1, 1, 0] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩");
    assert.equal(leanArguments(recognized("(n : ℕ) : n = n"), 7), "7");
    assert.throws(() => leanArguments(statement, 7), /magmas/);
  });
});
