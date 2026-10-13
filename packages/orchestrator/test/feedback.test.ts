import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareSketch, renderSketch, type ValidationReport } from "@math-harness/core";
import { failureClass, formatCheck, locate, summarizeCheck } from "../src/index.ts";
import { DEMO_FILE } from "./m0-helpers.ts";

const sketch = prepareSketch(DEMO_FILE, "Demo.add_zero'");
const checked = renderSketch(sketch, "theorem aux_a : True := trivial", "intro m\nexact? \nsorry");
const lines = checked.split("\n");
const lineOf = (text: string) => lines.findIndex((l) => l.trim() === text) + 1;

type Overrides = { [K in keyof ValidationReport]?: ValidationReport[K] | undefined };

/** A report of a check; `leanStatus: undefined` is a file refused before Lean. */
function report(overrides: Overrides): ValidationReport {
  const merged: Overrides = {
    verdict: "invalid", method: "repl", reasons: [], axioms: [], messages: [], sorries: [], checked,
    submissionHash: "h", editsOutsideRegions: false, holes: false, leanStatus: "lean_error", ...overrides,
  };
  if (merged.leanStatus === undefined) delete merged.leanStatus;
  return merged as ValidationReport;
}

describe("locate", () => {
  it("names the region and the line in the prover's terms, with the line's text", () => {
    assert.equal(locate(checked, lineOf("theorem aux_a : True := trivial")), "AUX line 1, `theorem aux_a : True := trivial`");
    assert.equal(locate(checked, lineOf("sorry")), "PROOF line 3, `sorry`");
    assert.equal(locate(checked, 1), "line 1 of the fixed part, `import FormalConjectures.Util.ProblemImports`");
  });
});

describe("formatCheck", () => {
  it("says why a file was refused before Lean", () => {
    const text = formatCheck(report({ leanStatus: undefined, reasons: ["proof: 'native_decide' is not allowed"] }));
    assert.equal(text, "Refused before Lean ran; nothing was checked:\n- proof: 'native_decide' is not allowed");
  });

  it("lists errors, holes and other messages by region, and leaves out the sorry warnings", () => {
    const text = formatCheck(
      report({
        holes: true,
        reasons: ["the file still has holes (sorry or admit)", "lean: 1 error(s)", "lean: 1 sorry(s) left", "lean: Demo.add_zero' depends on sorryAx"],
        messages: [
          { severity: "error", pos: { line: lineOf("intro m"), column: 2 }, text: "no additional binders" },
          { severity: "info", pos: { line: lineOf("exact?"), column: 2 }, text: "Try this: exact Nat.add_zero n" },
          { severity: "warning", pos: { line: lineOf("theorem aux_a : True := trivial"), column: 0 }, text: "declaration uses 'sorry'" },
        ],
        sorries: [{ pos: { line: lineOf("sorry"), column: 2 }, goal: "n : ℕ\n⊢ n + 0 = n" }],
      }),
    );
    assert.equal(
      text,
      [
        "Checked the sketch: 1 error(s), 1 hole(s).",
        "Errors (1):",
        "1. PROOF line 1, `intro m`:",
        "   no additional binders",
        "Holes, with their goals (1):",
        "1. PROOF line 3, `sorry`:",
        "   n : ℕ",
        "   ⊢ n + 0 = n",
        "Other messages (1):",
        "1. info, PROOF line 2, `exact?`:",
        "   Try this: exact Nat.add_zero n",
      ].join("\n"),
    );
  });

  it("cuts long messages and long lists", () => {
    const errors = Array.from({ length: 10 }, (_, k) => ({
      severity: "error" as const, pos: { line: lineOf("intro m"), column: 0 }, text: `error ${k} ${"x".repeat(2000)}`,
    }));
    const text = formatCheck(report({ messages: errors }), { items: 2, messageChars: 20 });
    assert.match(text, /^Not accepted: 10 error\(s\)\./);
    assert.match(text, /1\. PROOF line 1, `intro m`:\n {3}error 0 x{12}\n {3}\[\.\.\. 1988 more characters\]/);
    assert.match(text, /\[8 more not shown\]$/);
  });

  it("explains a timeout, an unreachable Lean, and other reasons", () => {
    assert.match(formatCheck(report({ leanStatus: "timeout", reasons: ["lean: timeout: 300 s"] })), /^Lean did not finish within the time limit/);
    assert.match(formatCheck(report({ leanStatus: "server_error", reasons: ["lean: server_error: refused"] })), /^Lean could not be reached/);
    const changed = formatCheck(report({ leanStatus: "valid", reasons: ["lean: the statement no longer elaborates to the original type"] }));
    assert.equal(changed, "Not accepted.\n- lean: the statement no longer elaborates to the original type");
  });
});

describe("failureClass and summarizeCheck", () => {
  it("classify a check in a word and a line", () => {
    const cases: Array<[Overrides, string, string]> = [
      [{ leanStatus: undefined, reasons: ["proof: 'sorry' is not allowed"] }, "refused", "refused before Lean: proof: 'sorry' is not allowed"],
      [{ leanStatus: "server_error" }, "lean_unavailable", "Lean could not be reached"],
      [{ leanStatus: "timeout" }, "timeout", "Lean timed out"],
      [{ messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "x" }] }, "lean_error", "1 error(s), 0 hole(s)"],
      [{ holes: true, sorries: [{ pos: { line: 1, column: 0 }, goal: "⊢ True" }] }, "holes", "0 error(s), 1 hole(s)"],
      [{ leanStatus: "valid", reasons: ["lean: Demo.add_zero' depends on Classical.ofNonempty"] }, "axioms", "0 error(s), 0 hole(s)"],
      [{ leanStatus: "valid", reasons: ["lean: the statement no longer elaborates to the original type"] }, "statement_changed", "0 error(s), 0 hole(s)"],
    ];
    for (const [overrides, kind, line] of cases) {
      assert.equal(failureClass(report(overrides)), kind);
      assert.equal(summarizeCheck(report(overrides)), line);
    }
    assert.equal(failureClass(report({ verdict: "valid", leanStatus: "valid" })), undefined);
  });
});
