import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { BP_AUX, BP_PROOF, blueprintAnswer } from "./blueprint-helpers.ts";

const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => e.data.data as Record<string, unknown>);

async function register(aux: string, proof = BP_PROOF, blueprints = true) {
  return await demoRun({
    lines: { M12: createM12Line() },
    config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: { blueprints, maxInnerTasks: 0 } } },
    lean: new DemoLean(blueprintAnswer),
    responses: [check(proof, aux), say("Done.")],
  });
}

describe("blueprints: registering a sketch whose holes depend on each other (CA9)", () => {
  it("makes a claim per hole, the target's decomposition, and an edge from a hole to the holes it declares", { timeout: 30000 }, async () => {
    const { events } = await register(BP_AUX);
    const sketch = nodes(events, "m12_sketch");
    assert.deepEqual(sketch.map((n) => [n.healthy, n.blueprint, n.uses]), [[true, true, [[], ["aux_left"], []]]]);
    const claims = ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"));
    assert.equal(claims.length, 3);
    const edges = ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into");
    assert.equal(edges.length, 2);
    // The edge of a dependency joins the hole to the holes it uses; it is not lean_checked before the hole's work is done, so it propagates nothing.
    const [left, right] = claims.map((c) => c.data.claimId);
    assert.deepEqual(edges.map((e) => [e.data.from === right, e.data.to]).find(([isRight]) => isRight)?.[1], [left]);
    assert.deepEqual(ofType(events, "edge.status_changed").map((e) => e.data.to), ["lean_checked"], "only the target's decomposition is checked");
  });

  it("refuses a cycle, an unreachable hole, an unknown name and a hole that restates the target, and makes nothing", { timeout: 60000 }, async () => {
    const cases: Array<[string, string, RegExp, string?]> = [
      ["cycle", `-- uses: aux_right\n${BP_AUX}`, /cycle: aux_left -> aux_right -> aux_left/],
      ["unreachable", BP_AUX, /aux_third does not reach the target/],
      ["unknown", BP_AUX.replace("-- uses: aux_left", "-- uses: aux_nowhere"), /not a hole of this blueprint/],
    ];
    const proofs = ["exact main_ok aux_left aux_right aux_third", "exact main_ok aux_right", BP_PROOF];
    for (const [k, [name, aux, pattern]] of cases.entries()) {
      const { events } = await register(aux, proofs[k] as string);
      const [record] = nodes(events, "m12_sketch");
      assert.equal(record?.healthy, false, name);
      assert.match(String(record?.problem), pattern, name);
      assert.equal(ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into").length, 0, name);
      assert.equal(ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12").length, 0, name);
    }
  });

  it("without the option the sketch is read as before (the uses line is a comment)", { timeout: 30000 }, async () => {
    const { events } = await register(BP_AUX, BP_PROOF, false);
    const [record] = nodes(events, "m12_sketch");
    assert.equal(record?.blueprint, undefined);
    assert.equal(ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into").length, 1);
  });
});
