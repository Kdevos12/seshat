import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Json } from "@seshat/core";
import { presentOutput } from "../src/index.ts";
import { FakeLeanLspMcp } from "./fixtures/fake-lean-lsp-mcp.ts";
import { build, invoke, onSketch } from "./helpers.ts";

const present = (output: Record<string, Json>) => presentOutput(output as Json);

describe("what a prover reads of an answer of lean.lsp", () => {
  it("shows the goals before and after a line, each with its count, and says when none is left", () => {
    assert.equal(
      present({ op: "goal", status: "ok", region: "proof", line: 2, lineText: "  intro n", goalsBefore: ["⊢ ∀ n, n = n"], goalsAfter: ["n : Nat\n⊢ n = n"] }),
      "Before PROOF line 2, `intro n`: 1 goal(s)\n⊢ ∀ n, n = n\n\nAfter PROOF line 2, `intro n`: 1 goal(s)\nn : Nat\n⊢ n = n",
    );
    assert.equal(
      present({ op: "goal", status: "ok", region: "proof", line: 1, lineText: "  exact foo", goalsBefore: ["⊢ A", "⊢ B"], goalsAfter: [] }),
      "Before PROOF line 1, `exact foo`: 2 goal(s)\nGoal 1 of 2:\n⊢ A\nGoal 2 of 2:\n⊢ B\n\nAfter PROOF line 1, `exact foo`: no goal.",
    );
  });

  it("shows the goals at a position, and what a position without goals means", () => {
    const at = { op: "goal", region: "aux", line: 2, column: 3, lineText: "  simp" };
    assert.equal(present({ ...at, status: "goals", goals: ["⊢ True"] }), "Goal at AUX line 2, column 3, `simp`:\n⊢ True");
    assert.equal(present({ ...at, status: "goals", goals: ["⊢ A", "⊢ B"] }), "Goal at AUX line 2, column 3, `simp` (2):\nGoal 1 of 2:\n⊢ A\nGoal 2 of 2:\n⊢ B");
    assert.equal(present({ ...at, status: "complete", goals: [] }), "AUX line 2, column 3, `simp`: no goals left. The proof is complete at this point.");
    assert.equal(present({ ...at, status: "no_goal_here" }), "AUX line 2, column 3, `simp`: no proof state here. The position is outside a tactic block, or on a line without a tactic.");
    assert.equal(present({ ...at, status: "still_elaborating" }), "AUX line 2, column 3, `simp`: Lean was still elaborating when the time limit came. Ask again, or give a larger timeoutSec.");
  });

  it("says that Lean was still elaborating, and not that there is no goal, for a line and for a search by the goal", () => {
    const line = { region: "proof", line: 1, lineText: "  sorry" };
    const goal = present({ op: "goal", status: "still_elaborating", ...line });
    assert.equal(goal, "PROOF line 1, `sorry`: Lean was still elaborating when the time limit came. Ask again, or give a larger timeoutSec.");
    assert.doesNotMatch(goal, /no goal/i);
    const search = present({ op: "state_search", status: "still_elaborating", ...line, column: 3 });
    assert.equal(search, "PROOF line 1, column 3, `sorry`: Lean was still elaborating when the time limit came, so no search was made. Ask again, or give a larger timeoutSec.");
    assert.doesNotMatch(search, /no goal to search for/);
  });

  it("shows the expected type of a term, or that there is none", () => {
    const at = { op: "term_goal", region: "proof", line: 1, column: 9, lineText: "  exact h" };
    assert.equal(present({ ...at, status: "ok", expectedType: "n = n" }), "Expected type at PROOF line 1, column 9, `exact h`:\nn = n");
    assert.equal(present({ ...at, status: "no_term_goal" }), "No expected type at PROOF line 1, column 9, `exact h`.");
  });

  it("lists Lean's messages by region and line as lean_check does, errors first, with the line of code", () => {
    assert.equal(
      present({
        op: "diagnostics",
        status: "ok",
        errors: 1,
        warnings: 1,
        messages: [
          { severity: "error", region: "proof", line: 2, column: 5, code: "exact foo", message: "unknown identifier 'foo'", hint: "did you mean 'for'?" },
          { severity: "warning", region: "fixed", line: 3, column: 9, message: "declaration uses 'sorry'\nsecond line" },
        ],
      }),
      [
        "Lean's messages on the file: 1 error(s), 1 warning(s).",
        "1. error, PROOF line 2, column 5, `exact foo`:",
        "   unknown identifier 'foo'",
        "   hint: did you mean 'for'?",
        "2. warning, line 3 of the fixed part, column 9:",
        "   declaration uses 'sorry'",
        "   second line",
      ].join("\n"),
    );
    assert.equal(present({ op: "diagnostics", status: "ok", region: "aux", errors: 0, warnings: 0, messages: [] }), "Lean's messages on AUX: 0 error(s), 0 warning(s).");
  });

  it("says when the list of messages is not final or cut", () => {
    const text = present({
      op: "diagnostics",
      status: "partial",
      errors: 30,
      warnings: 0,
      more: 5,
      note: "Lean was still elaborating when the time limit came, so the list may be incomplete: ask again.",
      messages: [{ severity: "error", region: "proof", line: 1, column: 1, message: "e" }],
    });
    assert.equal(
      text,
      [
        "Lean's messages on the file: 30 error(s), 0 warning(s) (not final).",
        "1. error, PROOF line 1, column 1:",
        "   e",
        "[5 more not shown]",
        "Lean was still elaborating when the time limit came, so the list may be incomplete: ask again.",
      ].join("\n"),
    );
  });

  it("says for each tactic tried whether it closes the goal, leaves goals or fails, and what Lean said", () => {
    const text = present({
      op: "multi_attempt",
      status: "ok",
      region: "proof",
      line: 4,
      lineText: "  sorry",
      attempts: [
        { tactic: "omega", result: "closed", goals: [], messages: [] },
        { tactic: "ring", result: "open", goals: ["a : Nat\n⊢ a = a"], messages: [] },
        { tactic: "simp\nlinarith", result: "error", goals: [], messages: [{ severity: "error", region: "proof", line: 4, column: 3, message: "linarith failed" }] },
      ],
    });
    assert.equal(
      text,
      [
        "Tried 3 tactic(s) at PROOF line 4, `sorry`. Each replaces the line from the column on; the goals are read at its end. Lean's errors elsewhere in the file are listed too.",
        "1. `omega`: closes the goal (no goal left, no error).",
        "2. `ring`: leaves 1 goal(s).",
        "   a : Nat",
        "   ⊢ a = a",
        "3. `simp ⏎ linarith`: gives an error.",
        "   1. error, PROOF line 4, column 3:",
        "      linarith failed",
      ].join("\n"),
    );
  });

  it("lists what a search found, one declaration to a line, and says when it found nothing", () => {
    assert.equal(
      present({
        op: "leansearch",
        status: "ok",
        results: [
          { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Mathlib.Algebra.Group.Nat", kind: "theorem" },
          { name: "add_comm", module: "Mathlib.Algebra.Group.Defs" },
        ],
      }),
      "LeanSearch found 2 declaration(s):\n- Nat.add_comm (theorem) : ∀ (n m : ℕ), n + m = m + n  [Mathlib.Algebra.Group.Nat]\n- add_comm  [Mathlib.Algebra.Group.Defs]",
    );
    assert.equal(present({ op: "loogle", status: "ok", results: [] }), "Loogle found nothing.");
  });

  it("shows the goal that Lean Finder was asked about, and the premises of the hammer", () => {
    const at = { region: "proof", line: 1, column: 3, lineText: "  sorry" };
    assert.equal(
      present({ op: "state_search", status: "ok", ...at, goal: "n : Nat\n⊢ n = n", results: [{ name: "Nat.le_refl", description: "reflexivity" }] }),
      "Lean Finder, asked about the goal at PROOF line 1, column 3, `sorry`:\n  n : Nat\n  ⊢ n = n\nLean Finder found 1 declaration(s):\n- Nat.le_refl\n  reflexivity",
    );
    assert.equal(
      present({ op: "state_search", status: "complete", ...at, note: "There is no goal here to search for." }),
      "PROOF line 1, column 3, `sorry`: no goals left.\nThere is no goal here to search for.",
    );
    assert.equal(
      present({ op: "hammer_premise", status: "ok", ...at, premises: ["Nat.add_zero", "Nat.zero_add"] }),
      "Premises for the goal at PROOF line 1, column 3, `sorry`, to try with simp only [...], aesop or grind:\nNat.add_zero, Nat.zero_add",
    );
    assert.equal(present({ op: "hammer_premise", status: "ok", ...at, premises: [] }), "The premise server found nothing for the goal at PROOF line 1, column 3, `sorry`.");
  });

  it("says that a site is out of reach, and not that nothing was found", () => {
    assert.equal(
      present({ op: "loogle", status: "unavailable", unavailable: "Loogle cannot be reached (timeout); it is not asked again for 60 second(s). Go on without it." }),
      "Loogle cannot be reached (timeout); it is not asked again for 60 second(s). Go on without it.",
    );
    assert.equal(
      present({ op: "hammer_premise", status: "unavailable", region: "proof", line: 1, column: 3, lineText: "  sorry", unavailable: "the premise server cannot be reached (HTTP 503)." }),
      "the premise server cannot be reached (HTTP 503).",
    );
  });

  it("reads like this for the answers of the stand-in server, for every operation", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const text = async (input: Record<string, Json>) => presentOutput(await invoke(impl, onSketch(input)));
    try {
      assert.match(await text({ op: "goal", line: 1 }), /^Before PROOF line 1, `sorry`: 1 goal\(s\)\nn : Nat\n⊢ n \+ 0 = n\n\nAfter PROOF line 1, `sorry`: no goal\.$/);
      assert.match(await text({ op: "term_goal", line: 1, column: 3 }), /^Expected type at PROOF line 1, column 3, `sorry`:\nn \+ 0 = n$/);
      assert.match(await text({ op: "diagnostics" }), /^Lean's messages on the file: 0 error\(s\), 1 warning\(s\)\.\n1\. warning, line 3 of the fixed part/);
      assert.match(await text({ op: "multi_attempt", line: 1, tactics: ["omega", "exact bad"] }), /\n1\. `omega`: closes the goal[\s\S]*\n2\. `exact bad`: gives an error\./);
      assert.match(await text({ op: "loogle", query: "Nat.add_comm" }), /^Loogle found 2 declaration\(s\):\n- Nat\.add_comm : /);
      assert.match(await text({ op: "leansearch", query: "adding zero" }), /^LeanSearch found 2 declaration\(s\):/);
      assert.match(await text({ op: "state_search", line: 1 }), /^Lean Finder, asked about the goal at PROOF line 1/);
      assert.match(await text({ op: "hammer_premise", line: 1 }), /\nNat\.add_zero, Nat\.zero_add$/);
    } finally {
      await impl.close();
    }
  });

  it("has a word for an answer with nothing in it", () => {
    assert.equal(present({ op: "term_goal", status: "no_term_goal", line: 1 }), "No expected type at PROOF line 1.");
    assert.equal(presentOutput({} as Json), "(no output)");
  });
});
