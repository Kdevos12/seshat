import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auxDeclarations, codeSize, hasHole, leanComments, leanPassages, normalizeSubmission } from "../src/index.ts";

describe("leanComments", () => {
  it("reads line comments, block comments and docstrings, and skips strings", () => {
    const source = [
      "-- first",
      'def s := "-- not a comment"',
      "/- a block",
      "   over two lines -/",
      "theorem t : True := by -- inline",
      "  trivial",
      "/-- a docstring -/",
    ].join("\n");
    assert.deepEqual(
      leanComments(source).map((c) => [c.kind, c.line, c.text]),
      [
        ["line", 0, "first"],
        ["block", 2, "a block\n   over two lines"],
        ["line", 4, "inline"],
        ["block", 6, "a docstring"],
      ],
    );
  });

  it("joins comments on consecutive lines into one passage", () => {
    const source = "-- by Smith\n-- the bound holds\n\n-- apart\n/- block -/\n-- after a block";
    assert.deepEqual(leanPassages(source), ["by Smith\nthe bound holds", "apart", "block", "after a block"]);
  });
});

describe("auxDeclarations", () => {
  it("lists the declarations with their statements, holes and comments", () => {
    const aux = [
      "-- helper for the step",
      "theorem aux_a (n : ℕ) : n + 0 = n := by",
      "  sorry",
      "def aux_f (n : ℕ) : ℕ := n",
      "lemma aux_b (n : ℕ) : n ≤ n + 1 := by",
      "  -- easy",
      "  omega",
    ].join("\n");
    const found = auxDeclarations(aux);
    assert.deepEqual(found.map((d) => [d.name, d.keyword, d.sorry]), [["aux_a", "theorem", true], ["aux_f", "def", false], ["aux_b", "lemma", false]]);
    assert.equal(found[0]?.statement, "(n : ℕ) : n + 0 = n");
    assert.equal(found[1]?.statement, undefined);
    assert.deepEqual(found[0]?.comments, ["helper for the step"]);
    assert.deepEqual(found[2]?.comments, ["easy"]);
  });
});

describe("the text of a submission", () => {
  it("ignores comments and spacing", () => {
    const a = { aux: "-- one\ntheorem aux_x : True := by\n  trivial", proof: "simp  -- two\n" };
    const b = { aux: "theorem aux_x : True := by trivial", proof: "simp" };
    assert.equal(normalizeSubmission(a), normalizeSubmission(b));
    assert.notEqual(normalizeSubmission(a), normalizeSubmission({ ...b, proof: "omega" }));
    assert.equal(codeSize(a), codeSize(b));
    assert.ok(codeSize({ aux: "", proof: "simp" }) < codeSize({ aux: "", proof: "simp\nomega\nlinarith" }));
  });

  it("sees a hole in code and not in a comment or a string", () => {
    assert.equal(hasHole("have : True := by sorry"), true);
    assert.equal(hasHole("admit"), true);
    assert.equal(hasHole("-- sorry\nsimp"), false);
    assert.equal(hasHole('exact foo "sorry"'), false);
  });
});
