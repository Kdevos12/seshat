import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROOF_END } from "@seshat/core";
import { RefusedError, screenQuery, screenRegions, screenTactics } from "../src/index.ts";

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
