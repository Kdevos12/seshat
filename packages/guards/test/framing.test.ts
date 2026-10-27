import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoryOf, framingProblems, isOpenConjecture, neutralQuestion } from "../src/index.ts";

describe("the category of a statement", () => {
  it("is read from the attributes of the theorem's header", () => {
    assert.equal(categoryOf("/-- Erdős 125. -/\n@[category research open, AMS 11]\ntheorem erdos_125 : True := by"), "research open");
    assert.equal(categoryOf("@[category research solved, AMS 5 11]\ntheorem t : True := by"), "research solved");
    assert.equal(categoryOf("@[category textbook]\ntheorem t : True := by"), "textbook");
    assert.equal(categoryOf("theorem t : True := by"), undefined);
    // A category named in a docstring is not an attribute.
    assert.equal(categoryOf("/-- the category research open, as said -/\ntheorem t : True := by"), undefined);
  });

  it("makes a statement an open conjecture when it says open or says nothing", () => {
    assert.equal(isOpenConjecture("research open"), true);
    assert.equal(isOpenConjecture(undefined), true);
    for (const category of ["research solved", "textbook", "test", "research formally solved"]) assert.equal(isOpenConjecture(category), false);
  });
});

describe("the question put to a prover", () => {
  it("asks to determine whether the statement holds, and never to prove it", () => {
    for (const known of [false, true]) {
      const text = neutralQuestion({ known });
      assert.match(text, /^Determine whether this theorem holds/);
      assert.deepEqual(framingProblems(text), []);
    }
    const open = neutralQuestion();
    assert.match(open, /open conjecture/);
    assert.match(open, /counterexample/);
    assert.match(neutralQuestion({ known: true }), /solved problem/);
  });

  it("finds the wordings that put a statement as a thing to demonstrate", () => {
    assert.deepEqual(framingProblems("Prove that every n works."), ["prove that"]);
    assert.deepEqual(framingProblems("Your task is to prove the theorem below."), ["prove the statement", "your task is to prove"]);
    assert.deepEqual(framingProblems("This hint will help you prove it."), ["help you prove"]);
    assert.deepEqual(framingProblems("Show that the bound holds, and demonstrate this conjecture."), ["prove that", "prove the statement"]);
    assert.deepEqual(framingProblems("Determine whether the bound holds. Look for a proof and for a counterexample."), []);
  });
});
