import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END, renderSketch } from "@seshat/core";
import { characters, checkColumn, describePlace, fileLine, firstColumn, isMarker, LayoutError, layoutOf, lineText, placeOf, regionLines } from "../src/index.ts";
import { RICH, SKETCH } from "./helpers.ts";

describe("the layout of the sketch file", () => {
  it("is the file lean_check checks, and finds the regions in it", () => {
    const layout = layoutOf(SKETCH, { aux: "", proof: "sorry" });
    assert.equal(layout.text, renderSketch(SKETCH, "", "sorry"));
    assert.deepEqual(layout.lines.slice(0, 6), [
      AUX_BEGIN,
      AUX_END,
      "theorem seshat_contract (n : Nat) : n + 0 = n := by",
      `  ${PROOF_BEGIN}`,
      "  sorry",
      `  ${PROOF_END}`,
    ]);
    assert.deepEqual([layout.begin, layout.end], [{ aux: 1, proof: 4 }, { aux: 2, proof: 6 }]);
    assert.deepEqual([regionLines(layout, "aux"), regionLines(layout, "proof")], [0, 1]);
  });

  it("counts the lines of a region as lean_check does: from the line after its marker, with the proof dedented", () => {
    const layout = layoutOf(SKETCH, { aux: "lemma aux_a : True := trivial\n\nlemma aux_b : True := trivial", proof: "\n\n      intro n\n        simp\n      omega" });
    assert.deepEqual([regionLines(layout, "aux"), regionLines(layout, "proof")], [3, 3], "the blank lines before the proof are dropped by the harness, as lean_check drops them");
    assert.equal(lineText(layout, fileLine(layout, "aux", 3)), "lemma aux_b : True := trivial");
    assert.equal(lineText(layout, fileLine(layout, "proof", 1)), "  intro n");
    assert.equal(lineText(layout, fileLine(layout, "proof", 2)), "    simp");
    assert.deepEqual([fileLine(layout, "aux", 1), fileLine(layout, "proof", 1)], [2, layout.begin.proof + 1]);
  });

  it("names the place of a file line in the prover's terms", () => {
    const layout = layoutOf(RICH, { aux: "lemma aux_a : True := trivial", proof: "intro\nsimp" });
    const lines = layout.lines;
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    assert.deepEqual(placeOf(layout, at("import Mathlib")), { region: "fixed", line: 1 });
    assert.deepEqual(placeOf(layout, at("lemma aux_a")), { region: "aux", line: 1 });
    assert.deepEqual(placeOf(layout, at("intro")), { region: "proof", line: 1 });
    assert.deepEqual(placeOf(layout, at("simp") + 0), { region: "fixed", line: at("simp") }, "@[simp] is in the header, not the proof");
    assert.deepEqual(placeOf(layout, at("theorem later")), { region: "fixed", line: at("theorem later") });
    assert.deepEqual(placeOf(layout, at(AUX_BEGIN.trim())), { region: "fixed", line: at(AUX_BEGIN.trim()) }, "a marker line belongs to neither region");
    assert.deepEqual(placeOf(layout, 9999), { region: "fixed", line: 9999 });
  });

  it("says why a line is not in a region", () => {
    const layout = layoutOf(SKETCH, { aux: "", proof: "sorry" });
    assert.throws(() => fileLine(layout, "aux", 1), (e: unknown) => e instanceof LayoutError && e.message === "AUX is empty, so it has no line 1");
    assert.throws(() => fileLine(layout, "proof", 2), (e: unknown) => e instanceof LayoutError && e.message === "PROOF has 1 line; there is no line 2");
    assert.throws(() => fileLine(layout, "proof", 0), /no line 0/);
    const long = layoutOf(SKETCH, { aux: "", proof: "a\nb\nc" });
    assert.throws(() => fileLine(long, "proof", 4), /PROOF has 3 lines; there is no line 4/);
  });

  it("refuses a sketch whose markers are not there exactly once", () => {
    assert.throws(() => layoutOf({ ...SKETCH, prefix: `${PROOF_BEGIN}\n` }, { aux: "", proof: "sorry" }), /has 2 lines '-- HARNESS:PROOF:BEGIN', not one/);
  });

  it("finds columns", () => {
    assert.equal(firstColumn("  simp"), 3);
    assert.equal(firstColumn("simp"), 1);
    assert.equal(firstColumn("    "), 1);
    assert.equal(firstColumn(""), 1);
    assert.equal(characters("𝕜 x"), 3, "columns count characters, not UTF-16 units");
    assert.doesNotThrow(() => checkColumn("  simp", 7), "one past the end is the end itself");
    assert.throws(() => checkColumn("  simp", 8), /column 8 is past the end of the line, which has 6 characters/);
  });

  it("writes places as lean_check does", () => {
    assert.equal(describePlace({ region: "proof", line: 3 }), "PROOF line 3");
    assert.equal(describePlace({ region: "aux", line: 1 }, 5), "AUX line 1, column 5");
    assert.equal(describePlace({ region: "fixed", line: 12 }), "line 12 of the fixed part");
    assert.equal(isMarker(`  ${PROOF_END}  `), true);
    assert.equal(isMarker("-- HARNESS:PROOF:ENDING"), false);
  });
});
