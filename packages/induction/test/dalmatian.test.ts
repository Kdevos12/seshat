import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphBattery } from "@seshat/models";
import { boundStatement, dalmatian, evaluate, type Expr, exprSize, exprText, type NumericColumn } from "../src/index.ts";

/** The numeric invariants of the graphs on up to `max` vertices: order, size, the largest and smallest degrees. */
function graphColumns(max: number): { columns: NumericColumn[]; ids: string[] } {
  const graphs = graphBattery(max).objects;
  const degrees = graphs.map((g) => {
    const d = Array.from({ length: g.n }, () => 0);
    for (const [u, v] of g.edges) {
      d[u] = (d[u] as number) + 1;
      d[v] = (d[v] as number) + 1;
    }
    return d;
  });
  return {
    ids: graphs.map((g) => g.graph6),
    columns: [
      { name: "n", values: graphs.map((g) => g.n) },
      { name: "m", values: graphs.map((g) => g.edges.length) },
      { name: "maxdeg", values: degrees.map((d) => Math.max(...d)) },
      { name: "mindeg", values: degrees.map((d) => Math.min(...d)) },
    ],
  };
}

describe("expressions", () => {
  const e: Expr = { op: "*", left: { op: "+", left: { op: "var", name: "x" }, right: { op: "const", value: 1 } }, right: { op: "sqrt", arg: { op: "var", name: "y" } } };
  it("print with the parentheses they need, and have a size", () => {
    assert.equal(exprText(e), "(x + 1) * sqrt(y)");
    assert.equal(exprSize(e), 6);
    assert.equal(exprText({ op: "-", left: { op: "var", name: "a" }, right: { op: "-", left: { op: "var", name: "b" }, right: { op: "var", name: "c" } } }), "a - (b - c)");
  });
  it("evaluate, and are undefined where the arithmetic is", () => {
    assert.equal(evaluate(e, (name) => (name === "x" ? 3 : 16)), 16);
    assert.equal(evaluate({ op: "/", left: { op: "const", value: 1 }, right: { op: "var", name: "z" } }, () => 0), undefined);
    assert.equal(evaluate({ op: "sqrt", arg: { op: "var", name: "z" } }, () => -1), undefined);
  });
});

describe("the Dalmatian heuristic", () => {
  it("keeps what is true on every object and strictly better than the rest on one, and drops what a better one replaces", () => {
    // y is 1, 2, 3, 4. Bounds on y from x (3, 3, 4, 5) and z (1, 2, 5, 9): y <= x is true and tight at 3 and 4... only at objects 3 (y=3,x=4)? it is x - 0.
    const columns: NumericColumn[] = [
      { name: "y", values: [1, 2, 3, 4] },
      { name: "x", values: [3, 3, 4, 5] },
      { name: "z", values: [1, 2, 5, 9] },
    ];
    const result = dalmatian(columns, { target: "y", maxSize: 3, constants: [] });
    const texts = result.conjectures.map((c) => c.text);
    // z is exact on objects 0 and 1, x on none; both are true. z first (it is the same size), and x is better than z at objects 2 and 3, so both stay.
    assert.deepEqual(texts, ["y <= x", "y <= z"]);
    const x = result.conjectures[0];
    assert.deepEqual(x?.tight, []);
    assert.deepEqual(result.conjectures[1]?.tight, [0, 1]);
    // y <= x + z is true but never better than x or z on any object: not significant.
    assert.ok(!texts.includes("y <= x + z"));
    assert.ok(result.rejectedAsInsignificant > 0);
  });

  it("drops a conjecture that a newer one makes insignificant", () => {
    const columns: NumericColumn[] = [
      { name: "y", values: [2, 4, 6] },
      { name: "a", values: [5, 5, 7] },
      { name: "b", values: [2, 4, 6] },
    ];
    // y <= a is kept first (size 1, alphabetical); y <= b equals y exactly and is better everywhere, so a is dropped.
    const result = dalmatian(columns, { target: "y", maxSize: 1, constants: [] });
    assert.deepEqual(result.conjectures.map((c) => c.text), ["y <= b"]);
    assert.equal(result.conjectures[0]?.exact, true);
  });

  it("finds classical bounds on the degrees of the graphs on up to 5 vertices", () => {
    const { columns } = graphColumns(5);
    const upper = dalmatian(columns, { target: "maxdeg", maxSize: 5, constants: [1, 2] });
    const texts = upper.conjectures.map((c) => c.text);
    assert.ok(texts.includes("maxdeg <= n - 1"), texts.join("; "));
    assert.ok(upper.conjectures.every((c) => c.objects === 1 + 2 + 4 + 11 + 34));
    // The smallest degree is at most the mean degree 2m/n, which is better than the largest degree (the weaker bound is not kept).
    const smallest = dalmatian(columns, { target: "mindeg", maxSize: 5 });
    assert.ok(smallest.conjectures.some((c) => c.text === "mindeg <= m * (2 / n)"), smallest.conjectures.map((c) => c.text).join("; "));
    assert.ok(!smallest.conjectures.some((c) => c.text === "mindeg <= maxdeg"), "mindeg <= maxdeg is true, and never the best bound");
    // And the largest degree is at least the mean degree.
    const mean = dalmatian(columns, { target: "maxdeg", maxSize: 5, direction: "lower" });
    assert.ok(mean.conjectures.some((c) => c.text === "maxdeg >= m * (2 / n)"), mean.conjectures.map((c) => c.text).join("; "));
    // Every conjecture holds on every object, whatever it is.
    const byName = new Map(columns.map((c) => [c.name, c.values]));
    for (const c of upper.conjectures) {
      for (let i = 0; i < 50; i++) {
        const v = evaluate(c.expression, (name) => byName.get(name)?.[i] ?? undefined);
        assert.ok(v !== undefined && (byName.get("maxdeg")?.[i] as number) <= v + 1e-9);
      }
    }
  });

  it("leaves out the objects with a missing value, caps the expressions, and says so", () => {
    const columns: NumericColumn[] = [
      { name: "y", values: [1, 2, null, 4] },
      { name: "x", values: [1, 3, 5, 6] },
    ];
    const result = dalmatian(columns, { target: "y", maxSize: 3, constants: [1] });
    assert.equal(result.conjectures[0]?.objects, 3);
    const capped = dalmatian(graphColumns(4).columns, { target: "maxdeg", maxSize: 6, maxExpressions: 30 });
    assert.equal(capped.capped, true);
    assert.equal(capped.generated, 30);
    assert.throws(() => dalmatian(columns, { target: "nope" }), /no invariant "nope"/);
  });

  it("states a bound in Lean's signature form when the invariants have Lean terms", () => {
    const { columns } = graphColumns(4);
    const result = dalmatian(columns, { target: "maxdeg", maxSize: 3, constants: [1] });
    const bound = result.conjectures.find((c) => c.text === "maxdeg <= n - 1");
    assert.ok(bound !== undefined);
    const lean = boundStatement(bound, "{V : Type} [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj]", {
      maxdeg: { term: "G.maxDegree", type: "ℕ" },
      n: { term: "Fintype.card V", type: "ℕ" },
    });
    assert.equal(lean, "{V : Type} [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] : ((G.maxDegree : ℕ) : ℝ) ≤ (((Fintype.card V : ℕ) : ℝ) - (1 : ℝ))");
    assert.equal(boundStatement(bound, "(G : G)", { maxdeg: { term: "d", type: "ℕ" } }), undefined, "a leaf without a Lean term gives no statement");
  });
});
