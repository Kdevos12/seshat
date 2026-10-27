import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROOF_END } from "@seshat/core";
import { fileLine, layoutOf, RefusedError, screenAttempts, screenQuery, screenRegions, screenTactics } from "../src/index.ts";
import { SKETCH } from "./helpers.ts";

describe("what lean.lsp refuses before anything is asked", () => {
  it("lets through what lean_check lets through, holes included", () => {
    assert.deepEqual(screenRegions({ aux: "lemma aux_a (n : Nat) : n + 0 = n := by\n  simp", proof: "have h := aux_a 1\nsorry" }), []);
    assert.deepEqual(screenRegions({ aux: "", proof: "nlinarith [sq_nonneg (n - 1)]" }), []);
  });

  it("refuses the shortcuts and the code that runs while Lean elaborates, in either region", () => {
    const reasons = screenRegions({ aux: "#eval 1", proof: "native_decide\nexact IO.println \"x\"" });
    assert.ok(reasons.includes("aux: '#eval' is not allowed"), reasons.join("\n"));
    assert.ok(reasons.includes("proof: 'native_decide' is not allowed"));
    assert.ok(reasons.includes("proof: 'IO' is not allowed"));
    assert.ok(reasons.includes("proof: string literals are not allowed in the editable regions"));
    assert.ok(reasons.includes("aux: only theorem, lemma, def and abbrev are allowed here, found '#eval'"));
    assert.deepEqual(screenRegions({ aux: "", proof: "run_cmd logInfo \"x\"" }).filter((r) => r.includes("run_cmd")), ["proof: 'run_cmd' is not allowed"]);
    assert.ok(screenRegions({ aux: "import Lean", proof: "simp" }).includes("aux: 'import' is not allowed"));
  });

  it("refuses an empty proof and a marker line inside a region", () => {
    assert.ok(screenRegions({ aux: "", proof: "  \n" }).includes("proof: the proof is empty"));
    const marked = screenRegions({ aux: "", proof: `simp\n${PROOF_END}` });
    assert.ok(marked.includes("proof: remove the line '-- HARNESS:PROOF:END': pass the regions without their marker lines"), marked.join("\n"));
  });

  it("screens each tactic as a proof of its own, and names it", () => {
    assert.deepEqual(screenTactics(["omega", "simp", "nlinarith [sq_nonneg x]"]), []);
    assert.deepEqual(screenTactics(["omega", "#eval 1", "decide\nnative_decide"]).filter((r) => !r.includes("string")), [
      "tactic 2: '#eval' is not allowed",
      "tactic 3: 'native_decide' is not allowed",
    ]);
  });

  it("reads a model's text as Lean does, so that code hidden behind a lookalike of a comment is found", () => {
    const hidden = [
      "x#eval 1",
      "\u{1d55c}#eval 1",
      "#checkrun_cmd 1",
      "<-- #eval 1",
      "' -- x #eval 7777",
      "/-/-/ -/ #eval 7777 -- -/",
      "/-- -- /-\n-/ #eval 7777 -- -/",
    ];
    for (const text of hidden) {
      assert.ok(screenRegions({ aux: "", proof: text }).some((r) => /^proof: '(#eval|run_cmd)' is not allowed$/.test(r)), `proof: ${JSON.stringify(text)}`);
      assert.ok(screenRegions({ aux: text, proof: "simp" }).some((r) => /^aux: '(#eval|run_cmd)' is not allowed$/.test(r)), `aux: ${JSON.stringify(text)}`);
      const tactics = screenTactics(["omega", text]);
      assert.ok(tactics.length >= 1 && tactics.every((r) => r.startsWith("tactic 2: ")), `tactic: ${JSON.stringify(text)}: ${tactics.join(" | ")}`);
    }
    // Real comments stay comments.
    for (const text of ["omega -- #eval 1", "simp /- #eval 1 -/", "simp\n/- #eval 1\n-/\nring"]) {
      assert.deepEqual(screenRegions({ aux: "", proof: text }), [], JSON.stringify(text));
    }
  });

  it("refuses the line breaks that only the language server counts: they hide code from this screen and shift the lines", () => {
    // Lean ends a line comment at a line feed; the server's splitlines also ends it at each of these, so the
    // text after one is code to the server's trial documents and a comment to the screen.
    const breaks: Array<[string, string]> = [
      ["U+2028", "\u2028"],
      ["U+2029", "\u2029"],
      ["a carriage return", "\r"],
      ["U+000B", "\u000b"],
      ["U+000C", "\u000c"],
      ["U+0085", "\u0085"],
      ["U+001C", "\u001c"],
      ["U+001D", "\u001d"],
      ["U+001E", "\u001e"],
    ];
    for (const [name, ch] of breaks) {
      const proof = screenRegions({ aux: "", proof: `simp -- note${ch}#eval 1` });
      assert.ok(proof.some((r) => r.startsWith("proof: remove ") && r.includes(name) && r.includes("line break")), `${name} in the proof: ${proof.join(" | ")}`);
      const aux = screenRegions({ aux: `-- note${ch}#eval 1\nlemma aux_a : True := trivial`, proof: "simp" });
      assert.ok(aux.some((r) => r.startsWith("aux: remove ") && r.includes(name)), `${name} in aux: ${aux.join(" | ")}`);
    }
    assert.deepEqual(screenRegions({ aux: "", proof: "simp\r\nring" }), [], "a CRLF is one line break for the server and for Lean");
    assert.deepEqual(screenRegions({ aux: "", proof: "simp\n\nring\t-- é ∀" }), [], "and other characters are not touched");
    const tactics = screenTactics(["omega", "simp\u2028done"]);
    assert.ok(tactics.length === 1 && tactics[0]?.startsWith("tactic 2: remove U+2028"), tactics.join(" | "));
  });

  it("screens what multi_attempt has the server elaborate: the tactic joined to the start of its line", () => {
    const attempt = (proof: string, line: number, column: number, tactics: string[]) => {
      const layout = layoutOf(SKETCH, { aux: "", proof });
      return screenAttempts(layout, { region: "proof", line, fileLine: fileLine(layout, "proof", line) }, column, tactics);
    };
    // Each half is clean alone (screenRegions and screenTactics), and the join is not.
    assert.deepEqual([screenRegions({ aux: "", proof: "Le" }), screenTactics(["an.Elab.Command.x"])], [[], []]);
    assert.deepEqual(attempt("Le", 1, 5, ["an.Elab.Command.x"]), [
      "tactic 1 is joined to the first 4 characters of PROOF line 1, so that the server elaborates `Lean.Elab.Command.x`: proof: 'Lean' is not allowed",
    ]);
    assert.deepEqual(attempt("run_", 1, 7, ["cmd 1"]).map((r) => r.replace(/^.*: proof/, "proof")), ["proof: 'run_cmd' is not allowed"]);
    assert.deepEqual(attempt("#ev", 1, 6, ["al 1"]).map((r) => r.replace(/^.*: proof/, "proof")), ["proof: '#eval' is not allowed"]);
    // The continuation lines of a tactic come after the same characters again.
    assert.match(attempt("#ev\nsimp", 1, 6, ["skip\nal 1"]).join("\n"), /elaborates `#evskip ⏎ #eval 1`: proof: '#eval' is not allowed/);
    // What a comment hid may not be hidden once the tactic closes it.
    assert.match(attempt("/- note\n#eval 1\n-/\nsimp", 1, 1, ["-/"]).join("\n"), /takes the place of PROOF line 1, so that the server elaborates the lines around it with `-\/`: proof: '#eval' is not allowed/);
    // A clean splice is accepted, at any column and with several lines.
    assert.deepEqual(attempt("intro n\nsimp\nring", 2, 3, ["omega", "simp\nring", "exact (by simp)"]), []);
    assert.deepEqual(attempt("simp", 1, 1, ["omega"]), []);
    // A column inside the line keeps the characters before it, and nothing else changes.
    assert.deepEqual(attempt("exact foo", 1, 9, ["bar"]), []);
  });

  it("refuses a tactic that has more lines than the region has from the line asked", () => {
    const layout = layoutOf(SKETCH, { aux: "", proof: "intro n\nsimp" });
    const site = (line: number) => ({ region: "proof" as const, line, fileLine: fileLine(layout, "proof", line) });
    assert.deepEqual(screenAttempts(layout, site(2), 3, ["a\nb"]), [
      "tactic 1 has 2 lines, and the server replaces as many lines of the file as a tactic has, from the line asked; PROOF has 1 from there, so it would replace the end of the region and what follows it",
    ]);
    assert.deepEqual(screenAttempts(layout, site(1), 3, ["a\nb"]), []);
    assert.deepEqual(screenAttempts(layout, site(1), 3, ["a\nb\nc"]).length, 1);
  });

  it("says that nothing was asked", () => {
    const error = new RefusedError(["proof: 'IO' is not allowed", "aux: 'import' is not allowed"]);
    assert.equal(error.message, "Refused before Lean ran; nothing was asked:\n- proof: 'IO' is not allowed\n- aux: 'import' is not allowed");
    assert.deepEqual(error.reasons.length, 2);
  });

  it("cleans a search query to one line and refuses the empty, the long and the odd", () => {
    assert.equal(screenQuery("  (?a → ?b)\n  → List ?a  "), "(?a → ?b) → List ?a");
    assert.throws(() => screenQuery("   "), /the query is empty/);
    assert.throws(() => screenQuery("a".repeat(501)), /longer than 500 characters/);
    assert.throws(() => screenQuery("x\u0000y"), /control characters/);
    assert.doesNotThrow(() => screenQuery("∀ n, n + 0 = n"));
  });
});
