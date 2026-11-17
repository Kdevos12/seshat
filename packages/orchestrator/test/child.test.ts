import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type HarnessEvent, Journal, readEvents, statementIdV0 } from "@seshat/core";
import { type ChildSpec, Ledger, runChild } from "../src/index.ts";
import { ofType } from "./m0-helpers.ts";

/**
 * One contract for a run's children (plan change LH9, Task 56): the common path `runChild` and each kind that was moved onto it, with the
 * simulated Lean and the faux provider of the other tests.
 */
function open(): Journal {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-child-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
  journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
  return journal;
}

const spec = (extra: Partial<ChildSpec> = {}): ChildSpec => ({
  kind: "informal",
  goal: { claimId: "clm_1" },
  parent: { problemId: "P1" },
  ledger: {},
  tools: ["lean.search"],
  output: "informal_proof",
  resumeKey: "informal:P1",
  ...extra,
});
const cost = (usd: number, tokens = 10) => ({ usd, inputTokens: tokens, outputTokens: tokens });
const kinds = (journal: Journal) => readEvents(journal.log.path).filter((e) => e.type.startsWith("child.")).map((e) => e.type);

describe("runChild, the common path", () => {
  it("journals the start and the end, charges the parent and returns the body's result", async () => {
    const journal = open();
    const parent = new Ledger(10);
    const ran = await runChild(spec({ ledger: { capUsd: 2 } }), { journal, ledger: parent }, async (child) => {
      child.ledger.charge(cost(0.5));
      return "answer";
    });
    assert.ok(!ran.skipped);
    assert.equal(ran.value, "answer");
    assert.equal(ran.usd, 0.5);
    assert.equal(parent.usd, 0.5, "what the child spent is the parent's");
    const events = readEvents(journal.log.path);
    const started = ofType(events, "child.started")[0]?.data;
    assert.deepEqual([started?.kind, started?.capUsd, started?.output, started?.resumeKey, started?.tools], ["informal", 2, "informal_proof", "informal:P1", ["lean.search"]]);
    const finished = ofType(events, "child.finished")[0]?.data;
    assert.deepEqual([finished?.status, finished?.usd, finished?.childId], ["done", 0.5, started?.childId]);
  });

  it("carves the cap from what the parent has left, and caps tokens", async () => {
    const journal = open();
    const parent = new Ledger(3);
    parent.charge(cost(2.5));
    await runChild(spec({ ledger: { capUsd: 2, capTokens: 15 } }), { journal, ledger: parent }, async (child) => {
      assert.equal(child.ledger.limitUsd, 0.5, "the least of the cap and the parent's remainder");
      assert.equal(child.ledger.exhausted, false);
      child.ledger.charge(cost(0.1, 10));
      assert.equal(child.ledger.exhausted, true, "20 tokens against a cap of 15");
    });
    assert.equal(ofType(readEvents(journal.log.path), "child.started")[0]?.data.capTokens, 15);
  });

  it("skips a child whose key finished done, and runs again one that failed or stopped", async () => {
    const journal = open();
    const parent = new Ledger();
    let bodies = 0;
    const body = async () => {
      bodies += 1;
      return bodies;
    };
    await assert.rejects(runChild(spec(), { journal, ledger: parent }, async () => Promise.reject(new Error("boom"))), /boom/);
    const stopped = await runChild(spec(), { journal, ledger: parent }, body, { statusOf: () => ({ status: "stopped", reason: "cut" }) });
    assert.ok(!stopped.skipped && stopped.status === "stopped");
    const done = await runChild(spec(), { journal, ledger: parent }, body);
    assert.ok(!done.skipped);
    const again = await runChild(spec(), { journal, ledger: parent }, body);
    assert.ok(again.skipped, "a done child is not started again");
    const other = await runChild(spec({ resumeKey: "informal:P2" }), { journal, ledger: parent }, body);
    assert.ok(!other.skipped, "another key is another child");
    assert.equal(bodies, 3);
    assert.deepEqual(readEvents(journal.log.path).filter((e) => e.type === "child.finished").map((e) => (e as Extract<HarnessEvent, { type: "child.finished" }>).data.status), ["failed", "stopped", "done", "done"]);
    assert.deepEqual(kinds(journal).filter((t) => t === "child.started").length, 4);
  });

  it("records a child that resumes by running again, and refuses an unknown kind or an empty key", async () => {
    const journal = open();
    const parent = new Ledger();
    await runChild(spec({ kind: "hole", resume: "run" }), { journal, ledger: parent }, async () => 1);
    const second = await runChild(spec({ kind: "hole", resume: "run" }), { journal, ledger: parent }, async () => 2);
    assert.ok(!second.skipped && second.value === 2);
    await assert.rejects(runChild(spec({ kind: "nothing" as never }), { journal, ledger: parent }, async () => 1), /unknown kind/);
    await assert.rejects(runChild(spec({ resumeKey: "" }), { journal, ledger: parent }, async () => 1), /resumeKey/);
  });

  it("is written by the orchestrator only", () => {
    const journal = open();
    assert.throws(() => journal.emit("child.started", { childId: "c", kind: "hole", goal: {}, tools: [], output: "x", resumeKey: "k" }, "line:M12"), /orchestrator only|by the orchestrator/);
  });
});
