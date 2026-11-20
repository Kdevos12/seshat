import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal } from "@seshat/core";
import type { JsonObject, ProblemContext, SessionContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { createFleet, FLEET_OPTIONS } from "../src/index.ts";

export const STATEMENT = "(n : ℕ) (h : 0 < n) : 3 ∣ n ^ 3 - n";
export const BUCKET = "msc:11|forall_nat+inequality";

/** A run's memory with two claims (the session's, and another of the same bucket), and the fleet's hooks, for the tests of the bucket and the stall. */
export async function world(options: JsonObject) {
  const dir = mkdtempSync(join(tmpdir(), "mh-fleet-b-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
  const { claimId } = await memory.ensureClaim({ statement: STATEMENT, origin: "test" });
  const other = await memory.ensureClaim({ statement: "(n : ℕ) (h : 1 < n) : 2 ∣ n ^ 2 - n", origin: "test" });
  const fleet = createFleet();
  const problem = (): ProblemContext =>
    ({ line: "fleet", runId: "run_1", problemId: "prob_1", claimId, domain: ["msc:11"], memory: memory.withActor("line:fleet"), registry: {}, signal: new AbortController().signal, options: { ...FLEET_OPTIONS, epsilon: 0, widen: false, strategies: false, ...options } }) as unknown as ProblemContext;
  const session = (n: number): SessionContext =>
    ({ ...problem(), prover: "p1", session: n, sessions: 99, attemptId: `att_p1_${n}`, model: "faux/prover", regions: { aux: "", proof: "" }, target: { statement: STATEMENT }, budget: { exhausted: false }, llm: { complete: async () => { throw new Error("not used"); }, completeJson: async () => { throw new Error("no model in this test"); } } }) as unknown as SessionContext;
  let counter = 0;
  /** A finished attempt, as a past session of the bucket would have left it. */
  function put(on: string, settings: JsonObject, outcome: "valid" | "invalid", prover = "old"): string {
    counter += 1;
    const id = `att_old_${counter}`;
    journal.emit("attempt.started", { attemptId: id, claimId: on, prover, iteration: counter, model: "faux/prover", settings }, `prover:${prover}`);
    journal.emit(
      "attempt.finished",
      { attemptId: id, outcome, ...(outcome === "invalid" ? { failureClass: "syntax" } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
      `prover:${prover}`,
    );
    return id;
  }
  return { memory, journal, claimId, otherClaim: other.claimId, fleet, problem, session, put };
}

