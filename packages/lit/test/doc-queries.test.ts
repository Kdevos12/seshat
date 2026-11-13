import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareSketch } from "@seshat/core";
import { docstringOf, leanWords, queryForms } from "../src/queries.ts";

// The shape of a PutnamBench file (the first real intake, 2026-11-12, searched for "putnam numbers hzle hzne": the sketch keeps the
// docstring in its header, not in its prefix, and the words then came from the hypotheses' names).
const FILE = `import Mathlib

open Filter Topology Set

/--
For $j \\in \\{1, 2, 3, 4\\}$, let $z_j$ be a complex number with $|z_j| = 1$ and $z_j \\neq 1$. Prove that \\[ 3 - z_1 - z_2 - z_3 - z_4 + z_1 z_2 z_3 z_4 \\neq 0. \\]
-/
theorem putnam_2020_b5
(z : Fin 4 → ℂ)
(hzle1 : ∀ n, ‖z n‖ = 1)
(hzne1 : ∀ n, z n ≠ 1)
: 3 - z 0 - z 1 - z 2 - z 3 + (z 0) * (z 1) * (z 2) * (z 3) ≠ 0 :=
sorry
`;

describe("the words a bench problem is searched with", () => {
  it("the docstring a sketch keeps in its header is found", () => {
    const sketch = prepareSketch(FILE, "putnam_2020_b5");
    const doc = docstringOf(sketch);
    assert.ok(doc?.startsWith("For $j"), doc);
    const forms = queryForms({ statement: sketch.statement, name: "putnam_2020_b5", doc: doc as string });
    assert.ok(forms[0]?.query.includes("complex"), forms[0]?.query);
    assert.ok(!forms.some((f) => /hzle|hzne/.test(f.query)));
  });

  it("a docstring at the end of the prefix is still found, and none is none", () => {
    assert.equal(docstringOf({ prefix: "import Mathlib\n/-- A known lemma. -/\n", header: "theorem t : True := by" }), "A known lemma.");
    assert.equal(docstringOf({ prefix: "import Mathlib\n", header: "theorem t : True := by" }), undefined);
  });

  it("without a docstring, the names of binders are not words of the query", () => {
    const sketch = prepareSketch(FILE.replace(/\/--[\s\S]*?-\/\n/, ""), "putnam_2020_b5");
    const words = leanWords(sketch.statement);
    assert.ok(!/hzle|hzne/.test(words), words);
    assert.ok(/numbers/.test(words), words);
  });
});
