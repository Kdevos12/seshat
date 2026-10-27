import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasLeanOutput, REMOVED_MARK, scrubLeanOutput } from "../src/index.ts";

const GOAL = ["case succ", "n : ℕ", "ih : n + 0 = n", "⊢ n + 1 + 0 = n + 1"];

describe("Lean's raw output in a text", () => {
  it("takes out a goal with its context and leaves the prose around it", () => {
    const text = ["The second case fails:", ...GOAL, "Maybe simp helps."].join("\n");
    const scrubbed = scrubLeanOutput(text);
    assert.equal(scrubbed.text, ["The second case fails:", REMOVED_MARK, "Maybe simp helps."].join("\n"));
    assert.equal(scrubbed.blocks, 1);
    assert.equal(scrubbed.empty, false);
  });

  it("takes out a goal that an error opens, a located message and an error header", () => {
    for (const block of [
      "unsolved goals\n⊢ False",
      "Foo.lean:12:4: error: unsolved goals\nn : ℕ\n⊢ n = n",
      "<input>:3:1: error: unknown constant 'x'",
      "error: unsolved goals",
      "warning: declaration uses 'sorry'",
      "unknown identifier 'Nat.foo'",
      "unexpected token 'at'; expected term",
    ]) {
      const scrubbed = scrubLeanOutput(`before\n${block}\nafter`);
      assert.equal(scrubbed.text, `before\n${REMOVED_MARK}\nafter`, block);
    }
  });

  it("takes out the words of a type mismatch, with the terms indented under them", () => {
    const mismatch = ["type mismatch", "  h", "has type", "  a < b : Prop", "but is expected to have type", "  b > a : Prop"].join("\n");
    assert.equal(scrubLeanOutput(`It said:\n${mismatch}\nso I cast.`).text, `It said:\n${REMOVED_MARK}\nso I cast.`);
    const synth = "failed to synthesize\n  HAdd ℕ ℕ ?m\nAdditional diagnostic information may be available using the `set_option diagnostics true` command.";
    assert.equal(scrubLeanOutput(synth).text, REMOVED_MARK);
  });

  it("takes out a copy of the harness's report of a check", () => {
    const copied = ["Not accepted: 2 error(s).", "Errors (2):", "1. PROOF line 3, `simp`:", "   unsolved goals", "   ⊢ False", "2. AUX line 1:", "   unknown identifier 'foo'", "my own idea: use omega"].join("\n");
    const scrubbed = scrubLeanOutput(copied);
    assert.equal(scrubbed.text, `${REMOVED_MARK}\nmy own idea: use omega`);
  });

  it("makes one block of the goals of one message, with blank lines between them", () => {
    const two = ["unsolved goals", "case left", "x : ℕ", "⊢ x = x", "", "case right", "y : ℕ", "⊢ y = y"].join("\n");
    const scrubbed = scrubLeanOutput(`${two}\n\nthen`);
    assert.equal(scrubbed.blocks, 1);
    assert.equal(scrubbed.text, `${REMOVED_MARK}\n\nthen`);
  });

  it("says when nothing is left of the text", () => {
    assert.deepEqual(scrubLeanOutput(GOAL.join("\n")), { text: REMOVED_MARK, blocks: 1, empty: true });
    assert.equal(scrubLeanOutput(`${GOAL.join("\n")}\n\nsimp does not close it`).empty, false);
  });

  it("leaves the typed summaries and the prose that names a goal", () => {
    for (const text of [
      "induction: 3 attempts, unsolved goals at case succ",
      "automation: 2 attempts, 1 type mismatch, 1 tactic failed; last: linarith failed",
      "unknown identifier Nat.foo",
      "The goal is ⊢ n + 0 = n and simp should close it.",
      "- tried induction: unsolved goals\n  ⊢ n + 1 = n + 1",
      "⊢ n = n",
      "Idea : use induction, then simp",
      "case analysis on n works for small n",
      "Typed summaries of the attempts on this statement or an equivalent one, by you and the other provers (their text is not kept):",
    ]) {
      assert.deepEqual(scrubLeanOutput(text), { text, blocks: 0, empty: false }, text);
      assert.equal(hasLeanOutput(text), false, text);
    }
  });

  it("takes a fenced block for Lean's output only when asked, and only when it holds Lean's output", () => {
    const pasted = ["It fails with:", "```", "unsolved goals", "⊢ False", "```", "so I stop."].join("\n");
    const code = ["My proof so far:", "```lean", "theorem t : True := by", "  trivial", "```"].join("\n");
    assert.equal(scrubLeanOutput(code, { fences: true }).blocks, 0);
    assert.equal(scrubLeanOutput(pasted, { fences: true }).text, ["It fails with:", REMOVED_MARK, "so I stop."].join("\n"));
    // An opener above the goal makes it Lean's output with or without the option; a bare goal in a fence only with it.
    assert.equal(hasLeanOutput(pasted), true);
    const bare = ["```", "⊢ False", "```"].join("\n");
    assert.equal(hasLeanOutput(bare), false);
    assert.equal(hasLeanOutput(bare, { fences: true }), true);
  });
});
