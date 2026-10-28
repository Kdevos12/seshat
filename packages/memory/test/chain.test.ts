import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, loadMemoryChain, type ProvenanceContext, statementIdV0 } from "@seshat/core";
import { MemoryStore } from "../src/index.ts";

const context: ProvenanceContext = { modelId: "prov/model-5", promptVersion: "m0-2", mathlibRev: "rev-a", harnessVersion: "rev1", budgetClass: "medium" };
const source = { rev: "rev-a", lean: "leanprover/lean4:v4.20.0" };
const env = `bench:${source.rev}|lean:${source.lean}`;
const STATEMENT = "(n : ℕ) : n + 0 = n";

let counter = 0;
function attempt(journal: Journal, outcome: "valid" | "invalid", items: { included?: string[]; withheld?: string[] }): void {
  const attemptId = `att_${++counter}`;
  journal.emit("attempt.started", { attemptId, claimId: "clm_1", prover: "p1", iteration: 1, model: "m", ...items }, "prover:p1");
  journal.emit(
    "attempt.finished",
    { attemptId, outcome, ...(outcome === "invalid" ? { failureClass: "unsolved_goals" } : {}), durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
    "prover:p1",
  );
}

/** An earlier run: a claim, a stored proof's blob, and 20 attempts that were shown `lesson_x` (14 valid) and 20 that were denied it (6 valid). */
function earlier(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mh-memory-chain-")), "run");
  const journal = Journal.open(dir, "run_a");
  journal.emit(
    "run.started",
    { runId: "run_a", benchId: "b", problems: 1, host: "h", config: { model: context.modelId, prompt: { version: "m0-2" }, bench: { source } } },
    "orchestrator",
  );
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(STATEMENT), statement: STATEMENT, origin: "test", status: "open" }, "test");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")), provenance: context });
  memory.recordNode({ kind: "lesson_note", claimId: "clm_1", data: { text: "try induction" }, learned: true });
  for (let k = 0; k < 20; k++) attempt(journal, k < 14 ? "valid" : "invalid", { included: ["lesson_x"] });
  for (let k = 0; k < 20; k++) attempt(journal, k < 6 ? "valid" : "invalid", { withheld: ["lesson_x"] });
  journal.emit("run.finished", { runId: "run_a", attempted: 40, solved: 0, refuted: 0, candidates: 0, usd: 0 }, "orchestrator");
  journal.close();
  return dir;
}

function later(dir: string, provenance: ProvenanceContext = context): { memory: MemoryStore; journal: Journal } {
  const chain = loadMemoryChain(dir, env);
  const next = join(mkdtempSync(join(tmpdir(), "mh-memory-chain-")), "run");
  const journal = Journal.open(next, "run_b", { memory: chain });
  journal.emit(
    "run.started",
    { runId: "run_b", benchId: "b", problems: 1, host: "h", config: { model: provenance.modelId, prompt: { version: provenance.promptVersion }, bench: { source } }, memoryFrom: chain.from },
    "orchestrator",
  );
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(next, "blobs"), chain.blobDirs), provenance, probation: 0.25 }), journal };
}

describe("the memory of a run started on an earlier one", () => {
  it("has the nodes, the attempts and the posteriors of the earlier run", () => {
    const { memory, journal } = later(earlier());
    try {
      assert.equal(memory.nodes("lesson_note").length, 1);
      assert.equal(memory.nodes("lesson_note")[0]?.provenance?.modelId, "prov/model-5", "still stamped, and still unverified");
      assert.equal(memory.attempts("clm_1").length, 40);
      const effect = memory.itemEffect("lesson_x");
      assert.deepEqual([effect.with.successes, effect.with.failures, effect.without.successes, effect.without.failures], [14, 6, 6, 14]);
      assert.ok(effect.difference > 0.3 && effect.pNegative < 0.01);
      assert.equal(journal.projection.itemUses("lesson_x"), 20, "the earlier run's uses count towards N");
    } finally {
      journal.close();
    }
  });

  it("puts the earlier outcomes in probation when a new epoch opens, and gives them weight back only through this run's outcomes", () => {
    const { memory, journal } = later(earlier(), { ...context, modelId: "prov/model-6" });
    try {
      const before = memory.itemEffect("lesson_x");
      assert.equal(memory.withActor("orchestrator").openEpochIfChanged(context)?.epoch, 1, "the model family changed from the earlier run's");
      const after = memory.itemEffect("lesson_x");
      assert.ok(Math.abs(after.with.successes - 14 * 0.25) < 1e-9, `${after.with.successes}`);
      assert.ok(Math.abs(after.without.failures - 14 * 0.25) < 1e-9);
      assert.ok(after.pNegative > before.pNegative, "the evidence is weaker");
      // Time passing does not restore it; new outcomes of this epoch do, in full.
      assert.deepEqual(memory.itemEffect("lesson_x").with, after.with);
      attempt(journal, "valid", { included: ["lesson_x"] });
      attempt(journal, "invalid", { withheld: ["lesson_x"] });
      const now = memory.itemEffect("lesson_x");
      assert.ok(Math.abs(now.with.successes - (14 * 0.25 + 1)) < 1e-9);
      assert.ok(Math.abs(now.without.failures - (14 * 0.25 + 1)) < 1e-9);
      assert.equal(now.with.attempts, 21, "the attempts are counted whole; their weights are in the Beta");
      assert.equal(journal.projection.itemUses("lesson_x", 1), 1, "uses since the epoch began");
    } finally {
      journal.close();
    }
  });

  it("draws an item at p once the earlier run has used it N times", () => {
    const { memory, journal } = later(earlier());
    try {
      const draw = memory.draw(["lesson_x", "lesson_new"], () => 0.7);
      assert.deepEqual(draw.chances, { lesson_x: 0.9, lesson_new: 0.5 });
      assert.deepEqual(draw.included, ["lesson_x"], "0.7 is under 0.9 and over 0.5");
    } finally {
      journal.close();
    }
  });
});

describe("how many runs ago an attempt was made, and the settings it was given", () => {
  it("is 0 for this run's attempts and 1 for the last run of the chain, with the settings and the exploration flag read back", () => {
    const { memory, journal } = later(earlier());
    try {
      journal.emit(
        "attempt.started",
        { attemptId: "att_new", claimId: "clm_1", prover: "p9", iteration: 1, model: "m", settings: { thinking: "high", temperature: 0.4 }, exploration: false },
        "prover:p9",
      );
      journal.emit("attempt.finished", { attemptId: "att_new", outcome: "invalid", failureClass: "syntax", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 }, "prover:p9");
      const all = memory.attempts("clm_1");
      assert.equal(all.length, 41);
      assert.equal(all.filter((a) => a.runsAgo === 1).length, 40, "the earlier run's");
      const fresh = all.find((a) => a.attemptId === "att_new");
      assert.deepEqual([fresh?.runsAgo, fresh?.exploration, fresh?.settings], [0, false, { thinking: "high", temperature: 0.4 }]);
      assert.equal(all.find((a) => a.runsAgo === 1)?.settings, undefined);
      assert.equal(all.find((a) => a.runsAgo === 1)?.exploration, undefined);
    } finally {
      journal.close();
    }
  });
});
