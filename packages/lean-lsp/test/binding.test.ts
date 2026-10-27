import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Json, Submission } from "@seshat/core";
import { FILE_OPS, leanLspBinding, OPS, presentOutput } from "../src/index.ts";
import { RICH, SKETCH } from "./helpers.ts";

const binding = (current: Submission = { aux: "", proof: "sorry" }, sketch = SKETCH) => {
  const state = { current };
  return { binding: leanLspBinding({ sketch, current: () => state.current }), state };
};

describe("how a run binds lean.lsp to a prover", () => {
  it("hides the sketch from the prover, and nothing else", () => {
    assert.deepEqual(binding().binding.hidden, ["sketch"]);
  });

  it("sets the problem's sketch on the file operations, whatever the prover put there", () => {
    const { binding: b } = binding();
    const forged = { fullName: "other", declaredName: "other", statement: "", prefix: "import Evil", header: "", originalProof: "", suffix: "", indent: "" };
    for (const op of FILE_OPS) {
      const bound = b.bind({ op, line: 1, sketch: forged as unknown as Json });
      assert.deepEqual(bound.sketch, SKETCH as unknown as Json, op);
    }
  });

  it("gives the searches no sketch and no regions: they read no file", () => {
    const { binding: b } = binding();
    for (const op of OPS.filter((o) => !(FILE_OPS as readonly string[]).includes(o))) {
      const bound = b.bind({ op, query: "x", sketch: { fullName: "other" } });
      assert.deepEqual(bound, { op, query: "x" }, op);
    }
  });

  it("reads the regions of the prover's last check at each call, unless the call passes its own", () => {
    const { binding: b, state } = binding({ aux: "", proof: "sorry" });
    assert.deepEqual([b.bind({ op: "goal", line: 1 }).aux, b.bind({ op: "goal", line: 1 }).proof], ["", "sorry"]);
    state.current = { aux: "theorem aux_a : True := trivial", proof: "simp\nomega" };
    const bound = b.bind({ op: "goal", line: 2 });
    assert.deepEqual([bound.aux, bound.proof], ["theorem aux_a : True := trivial", "simp\nomega"]);
    const own = b.bind({ op: "goal", line: 1, proof: "exact h" });
    assert.deepEqual([own.aux, own.proof], ["theorem aux_a : True := trivial", "exact h"]);
    const empty = b.bind({ op: "goal", line: 1, aux: "", proof: "" });
    assert.deepEqual([empty.aux, empty.proof], ["", ""], "an empty region is a region");
  });

  it("keeps the rest of the arguments as they are", () => {
    const { binding: b } = binding();
    const bound = b.bind({ op: "multi_attempt", line: 2, column: 3, tactics: ["simp", "omega"], timeoutSec: 20 });
    assert.deepEqual({ ...bound, sketch: undefined }, { op: "multi_attempt", line: 2, column: 3, tactics: ["simp", "omega"], timeoutSec: 20, aux: "", proof: "sorry", sketch: undefined });
  });

  it("works on the sketch of its own problem", () => {
    const { binding: b } = binding({ aux: "", proof: "sorry" }, RICH);
    assert.deepEqual(b.bind({ op: "diagnostics" }).sketch, RICH as unknown as Json);
  });

  it("leaves an operation it does not know to the registry, which refuses it", () => {
    const { binding: b } = binding();
    assert.deepEqual(b.bind({ op: "build", sketch: { fullName: "x" } }), { op: "build" });
    assert.deepEqual(b.bind({ line: 1 }), { line: 1 });
  });

  it("writes the answer for the prover with the presenter", () => {
    const { binding: b } = binding();
    const answer = { op: "loogle", status: "ok", results: [] } as unknown as Json;
    assert.equal(b.present(answer), presentOutput(answer));
    assert.equal(b.present(answer), "Loogle found nothing.");
  });
});
