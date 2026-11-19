import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { JsonObject, ProblemContext, SessionContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { allocations, createFleet, FLEET_OPTIONS } from "../src/index.ts";

const STATEMENT = "(n : ℕ) (h : 0 < n) : 3 ∣ n ^ 3 - n";
const BUCKET = "msc:11|forall_nat+inequality";

/** A run's memory with two claims (the session's, and another of the same bucket), and the fleet's hooks. */
async function world(options: JsonObject) {
  const dir = mkdtempSync(join(tmpdir(), "mh-fleet-b-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
  const { claimId } = await memory.ensureClaim({ statement: STATEMENT, origin: "test" });
  const other = await memory.ensureClaim({ statement: "(n : ℕ) (h : 1 < n) : 2 ∣ n ^ 2 - n", origin: "test" });
  const fleet = createFleet();
  const problem = (): ProblemContext =>
    ({ line: "fleet", runId: "run_1", problemId: "prob_1", claimId, domain: ["msc:11"], memory: memory.withActor("line:fleet"), registry: {}, signal: new AbortController().signal, options: { ...FLEET_OPTIONS, epsilon: 0, widen: false, strategies: false, ...options } }) as unknown as ProblemContext;
  const session = (n: number): SessionContext =>
    ({ ...problem(), prover: "p1", session: n, sessions: 99, attemptId: `att_p1_${n}`, model: "faux/prover", regions: { aux: "", proof: "" }, target: { statement: STATEMENT } }) as unknown as SessionContext;
  let counter = 0;
  /** A finished attempt, as a past session of the bucket would have left it. */
  function put(on: string, settings: JsonObject, outcome: "valid" | "invalid", fields: JsonObject = {}) {
    counter += 1;
    const id = `att_old_${counter}`;
    journal.emit("attempt.started", { attemptId: id, claimId: on, prover: "old", iteration: counter, model: "faux/prover", settings }, "prover:old");
    journal.emit(
      "attempt.finished",
      { attemptId: id, outcome, ...(outcome === "invalid" ? { failureClass: "syntax" } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0, ...fields },
      "prover:old",
    );
  }
  return { memory, journal, claimId, otherClaim: other.claimId, fleet, problem, session, put };
}

describe("the bucket prior in the fleet", () => {
  it("records the bucket with no cards, only when the option is on", async () => {
    const on = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 1 });
    assert.equal((await on.fleet.hooks.beforeSession?.(on.session(1)))?.settings?.heuristicBucket, BUCKET);
    const off = await world({ thinking: ["low", "high"], seed: 1 });
    assert.equal((await off.fleet.hooks.beforeSession?.(off.session(1)))?.settings?.heuristicBucket, undefined);
  });

  it("does not draw a thinking level the bucket shows to hurt, on a claim with no history of its own", async () => {
    const w = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 3 });
    for (let k = 0; k < 8; k++) {
      w.put(w.otherClaim, { thinking: "low", heuristicBucket: BUCKET }, "valid");
      w.put(w.otherClaim, { thinking: "high", heuristicBucket: BUCKET }, "invalid");
    }
    for (let n = 1; n <= 5; n++) assert.equal((await w.fleet.hooks.beforeSession?.(w.session(n)))?.settings?.thinking, "low");
    // The bucket's history is the bucket's only: attempts recorded under another bucket say nothing.
    const alone = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 3 });
    for (let k = 0; k < 8; k++) {
      alone.put(alone.otherClaim, { thinking: "low", heuristicBucket: "elsewhere" }, "valid");
      alone.put(alone.otherClaim, { thinking: "high", heuristicBucket: "elsewhere" }, "invalid");
    }
    const seen = new Set<unknown>();
    for (let n = 1; n <= 40; n++) seen.add((await alone.fleet.hooks.beforeSession?.(alone.session(n)))?.settings?.thinking);
    assert.equal(seen.size, 2);
    assert.ok(allocations(w.memory, w.claimId).length === 5);
  });
});
