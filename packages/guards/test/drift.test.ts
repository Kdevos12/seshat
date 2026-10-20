import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRIFT_ACTIONS, DRIFT_KINDS, driftNodes, isDriftData, recordDrift } from "../src/index.ts";
import { openMemory } from "./helpers.ts";

describe("drift nodes", () => {
  it("are recorded for a claim by the actor that found the drift, and read back in order", async () => {
    const { memory, journal } = openMemory();
    const guard = memory.withActor("line:M6");
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const other = await memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", origin: "test" });
    const node = recordDrift(guard, claimId, { kind: "strategy_loop", action: "stopped_session", detail: "3 checks in a row", prover: "p1", attemptId: "att_1", session: 2, check: 4, evidence: { checks: 3 } });
    recordDrift(guard, claimId, { kind: "length_growth", action: "stopped_session", detail: "the file grew", prover: "p2", attemptId: "att_2" });
    recordDrift(guard, other.claimId, { kind: "raw_error_text", action: "removed_text", detail: "x" });
    memory.recordNode({ kind: "hypothesis", claimId, data: { text: "not a drift" } });
    memory.recordNode({ kind: "drift", claimId, data: { kind: "made_up", action: "noted", detail: "x" } });

    assert.equal(memory.node(node.nodeId)?.kind, "drift");
    assert.deepEqual(driftNodes(memory, claimId).map((d) => d.data.kind), ["strategy_loop", "length_growth"]);
    assert.deepEqual(driftNodes(memory, claimId, { kind: "length_growth" }).map((d) => d.data.prover), ["p2"]);
    assert.deepEqual(driftNodes(memory, claimId, { prover: "p1" }).map((d) => d.nodeId), [node.nodeId]);
    assert.deepEqual(driftNodes(memory, claimId, { attemptId: "att_2" }).map((d) => d.data.kind), ["length_growth"]);
    assert.deepEqual(driftNodes(memory, other.claimId).map((d) => d.data.kind), ["raw_error_text"]);
    journal.close();
  });

  it("have a closed vocabulary of kinds and actions", () => {
    assert.equal(isDriftData({ kind: "session_loop", action: "restarted", detail: "x" }), true);
    assert.equal(isDriftData({ kind: "session_loop", action: "restarted" }), false);
    assert.equal(isDriftData({ kind: "other", action: "noted", detail: "x" }), false);
    assert.equal(isDriftData(null), false);
    assert.equal(isDriftData([]), false);
    assert.equal(new Set(DRIFT_KINDS).size, DRIFT_KINDS.length);
    assert.equal(new Set(DRIFT_ACTIONS).size, DRIFT_ACTIONS.length);
  });
});
