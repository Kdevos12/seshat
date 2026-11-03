import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { describeObstruction, MAX_OBSTRUCTION_DETAIL, MemoryStore, renderObstructions } from "../src/index.ts";

function open(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-obstruction-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
}

describe("obstruction records (PC3)", () => {
  it("record a typed reason once, as a node the account reads", async () => {
    const memory = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const line = memory.withActor("line:M11");
    const first = line.recordObstruction({ claimId, reason: "counterexample", detail: "the statement\n  fails on   n = 3" });
    assert.equal(first.created, true);
    assert.equal(first.obstruction.detail, "the statement fails on n = 3");
    assert.equal(first.obstruction.source, "line:M11");
    const again = line.recordObstruction({ claimId, reason: "counterexample", detail: "the statement fails on n = 3" });
    assert.deepEqual([again.created, again.obstruction.nodeId], [false, first.obstruction.nodeId]);
    const other = line.recordObstruction({ claimId, reason: "nogood", strategy: "induction", detail: "no induction hypothesis closes it" });
    assert.equal(other.created, true);
    assert.deepEqual(memory.obstructions(claimId).map((o) => o.reason), ["counterexample", "nogood"]);
    const node = memory.node(first.obstruction.nodeId);
    assert.equal(node?.kind, "obstruction");
    assert.equal((node?.data as { summary: string }).summary, "counterexample: the statement fails on n = 3");
  });

  it("refuse an unknown reason, a missing claim and an empty detail, and cut a long detail", async () => {
    const memory = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "test" });
    assert.throws(() => memory.recordObstruction({ claimId, reason: "because" as never, detail: "x" }), /reason is counterexample/);
    assert.throws(() => memory.recordObstruction({ claimId: "clm_none", reason: "nogood", detail: "x" }), /no claim/);
    assert.throws(() => memory.recordObstruction({ claimId, reason: "nogood", detail: "  " }), /needs a detail/);
    const long = memory.recordObstruction({ claimId, reason: "nogood", detail: "y".repeat(1000) });
    assert.equal(long.obstruction.detail.length, MAX_OBSTRUCTION_DETAIL);
  });

  it("are shown one line each, with a count of those left out", async () => {
    const memory = open();
    const { claimId } = await memory.ensureClaim({ statement: ": True", origin: "test" });
    for (let i = 0; i < 4; i++) memory.recordObstruction({ claimId, reason: "refuted_premise", detail: `premise ${i} is false` });
    const all = memory.obstructions(claimId);
    assert.equal(describeObstruction(all[0] as never), "refuted premise: premise 0 is false");
    assert.equal(renderObstructions(all, { maxLines: 10 }).length, 5);
    const cut = renderObstructions(all, { maxLines: 4 });
    assert.deepEqual([cut.length, cut.at(-1)], [4, "... and 2 more obstructions"]);
    assert.deepEqual(renderObstructions([], { maxLines: 10 }), []);
    assert.deepEqual(renderObstructions(all, { maxLines: 1 }), []);
  });

  it("are stamped learned records: they carry an epoch, and one from an earlier epoch says so in its line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-obstruction-"));
    const context = { modelId: "p/m5", promptVersion: "m0-1", mathlibRev: "rev-a", harnessVersion: "t", budgetClass: "small" };
    const journal = Journal.open(dir, "run_1");
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")), provenance: context });
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const { obstruction } = memory.withActor("line:M2").recordObstruction({ claimId, reason: "nogood", strategy: "induction", detail: "the refutation side found nothing" });
    assert.equal(memory.node(obstruction.nodeId)?.provenance?.mathlibRev, "rev-a");
    assert.equal(memory.node(obstruction.nodeId)?.epoch, 0);
    assert.equal(memory.obstructions(claimId)[0]?.earlier, undefined);
    assert.equal(describeObstruction(memory.obstructions(claimId)[0] as never), "tried, found nothing (induction): the refutation side found nothing");
    memory.withActor("orchestrator").openEpochIfChanged({ ...context, mathlibRev: "rev-b" });
    const [older] = memory.obstructions(claimId);
    assert.equal(older?.earlier, true);
    assert.match(describeObstruction(older as never), /^tried, found nothing \(induction\): the refutation side found nothing \[earlier epoch: may be out of date\]$/);
  });
});
