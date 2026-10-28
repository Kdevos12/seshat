import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { Decide, DecideRequest, Decision, JsonObject, ProblemContext, SessionContext } from "@seshat/lines";
import { InterruptedError } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { createFleet, FLEET_OPTIONS } from "../src/index.ts";

/** A decide that puts all the weight on `favoured` among the families it is asked about, and counts its calls. */
function deciding(favoured: string, backend: "llm" | "off" = "llm"): Decide & { asked: DecideRequest[] } {
  const asked: DecideRequest[] = [];
  return {
    asked,
    backendFor: () => backend,
    async decide(request): Promise<Decision> {
      asked.push(request);
      const labels = request.question.type === "choice" ? Object.keys(request.question.options) : [];
      return {
        answer: favoured,
        probabilities: Object.fromEntries(labels.map((l) => [l, l === favoured ? 1 : 0])),
        backend: "llm",
        requested: "llm",
        model: "faux",
        costUsd: 0,
        decisionId: "dec_1",
        replayed: false,
      };
    },
  };
}

async function picks(options: JsonObject, decide: Decide | undefined, sessions = 60): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "mh-fleet-"));
  const journal = Journal.open(dir, "run_1");
  try {
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
    const statement = "(n : ℕ) : n + 0 = n";
    const { claimId } = await memory.ensureClaim({ statement, origin: "test" });
    const fleet = createFleet();
    const controller = new AbortController();
    const chosen: string[] = [];
    for (let session = 1; session <= sessions; session++) {
      const ctx = {
        line: "fleet", runId: "run_1", problemId: "prob_1", claimId, memory: memory.withActor("line:fleet"), registry: {}, signal: controller.signal,
        options: { ...FLEET_OPTIONS, epsilon: 0, widen: false, stick: false, ...options },
        target: { statement }, prover: "p1", session, sessions: 99, attemptId: `att_${session}`, model: "faux/prover", regions: { aux: "", proof: "" },
        ...(decide !== undefined ? { decide } : {}),
      } as unknown as SessionContext & ProblemContext;
      const decision = await fleet.hooks.beforeSession?.(ctx);
      if (decision?.strategy !== undefined) chosen.push(decision.strategy);
    }
    return chosen;
  } finally {
    journal.close();
  }
}

const share = (chosen: string[], label: string) => chosen.filter((c) => c === label).length / chosen.length;

describe("the fleet's cold start", () => {
  it("is off by default: decide is not asked, and the choice is as it was", async () => {
    const decide = deciding("induction");
    const chosen = await picks({}, decide);
    assert.equal(decide.asked.length, 0);
    assert.ok(chosen.length > 0);
  });

  it("seeds the strategy choice with the decision's prior, as pseudo-counts, when asked to", async () => {
    const flat = await picks({}, undefined);
    const decide = deciding("induction");
    const seeded = await picks({ coldStart: true }, decide);
    assert.ok(decide.asked.length > 0);
    assert.equal(decide.asked[0]?.site, "fleet.cold_start");
    assert.equal(decide.asked[0]?.use, "order");
    assert.ok(share(seeded, "induction") > share(flat, "induction") + 0.15, `${share(seeded, "induction")} against ${share(flat, "induction")}`);
    // A weight of 0 is the flat prior.
    assert.deepEqual(await picks({ coldStart: true, coldStartWeight: 0 }, deciding("induction")), flat);
  });

  it("does nothing when the site is off or there is no decide, and refuses a weight over the cap", async () => {
    const flat = await picks({}, undefined);
    assert.deepEqual(await picks({ coldStart: true }, deciding("induction", "off")), flat);
    assert.deepEqual(await picks({ coldStart: true }, undefined), flat);
    await assert.rejects(picks({ coldStart: true, coldStartWeight: 9 }, deciding("induction")), /coldStartWeight must be between 0 and 4/);
  });

  it("lets a pause through", async () => {
    const decide = deciding("induction");
    decide.decide = async () => {
      throw new InterruptedError();
    };
    await assert.rejects(picks({ coldStart: true }, decide), InterruptedError);
  });
});
