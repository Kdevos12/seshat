import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HOLE_WAITING_REASON, Journal, newId, readEvents } from "@seshat/core";
import { buildAccount, renderAccount } from "../src/index.ts";
import { impasseOf } from "../src/breakpoints.ts";
import { DEFAULT_IMPASSE } from "../src/turns.ts";
import { scriptedJournal } from "./scripted-journal.ts";

/** A hole's task that ended as a waiting hole: `failed`, with the reason the line gives. */
function endWaiting(journal: Journal, problemId: string, claimId: string, reason = HOLE_WAITING_REASON): string {
  const taskId = newId("tsk");
  journal.emit("task.created", { taskId, kind: "prove", problemId, claimId, dependsOn: [], acceptance: { type: "claim", claimId, minStatus: "proved" }, budget: { sessions: 3 }, title: "prove a hole" }, "orchestrator");
  journal.emit("task.status_changed", { taskId, from: "pending", to: "ready", reason: "ready" }, "orchestrator");
  journal.emit("task.assigned", { taskId, owner: "prover:1", reason: "test" }, "orchestrator");
  journal.emit("task.status_changed", { taskId, from: "ready", to: "running", reason: "started" }, "orchestrator");
  journal.emit("task.status_changed", { taskId, from: "running", to: "failed", reason }, "orchestrator");
  return taskId;
}

describe("a hole that waits for its dependencies", () => {
  it("is shown by the account as waiting, not failed, and a failed task with another reason is not", () => {
    const s = scriptedJournal({
      before: (journal, ids) => {
        endWaiting(journal, ids.problems.decomposed as string, ids.claims.leaf as string);
        endWaiting(journal, ids.problems.decomposed as string, ids.claims.stuck as string, "the hole is false");
      },
    });
    const account = buildAccount(readEvents(join(s.dir, "journal.jsonl")), 1);
    s.journal.close();
    assert.deepEqual(account.problems[0]?.otherOpen, { pending: 1, waiting: 1 });
    assert.match(renderAccount(account), /1 waiting \(holes worked out on stubs, waiting for the lemmas they use; they are not failed\)/);
  });

  it("is a wait, not a failure, for the breakpoints: a problem whose open tasks are blocked or waiting is at an impasse", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-waiting-"));
    const journal = Journal.open(dir, "run_waiting");
    const claimId = newId("clm");
    journal.emit("claim.created", { claimId, statementId: `sid_${claimId}`, statement: "a hole", origin: "test", status: "open", kind: "formal" }, "memory");
    journal.emit("problem.registered", { problemId: "B.lean#p", claimId, target: "p", source: { repo: "r", rev: "x", path: "B.lean" }, domain: [] }, "orchestrator");
    endWaiting(journal, "B.lean#p", claimId);
    const projection = journal.projection;
    const problem = projection.problem("B.lean#p");
    assert.ok(problem !== undefined);
    assert.match(impasseOf(projection, problem, DEFAULT_IMPASSE) ?? "", /^every open task of p is blocked or waiting for a lemma it uses \(clm_/);
    // A failed task with another reason is a failure, not a wait.
    const other = newId("clm");
    journal.emit("claim.created", { claimId: other, statementId: `sid_${other}`, statement: "another", origin: "test", status: "open", kind: "formal" }, "memory");
    journal.emit("problem.registered", { problemId: "B.lean#q", claimId: other, target: "q", source: { repo: "r", rev: "x", path: "B.lean" }, domain: [] }, "orchestrator");
    endWaiting(journal, "B.lean#q", other, "the hole is false");
    assert.equal(impasseOf(journal.projection, journal.projection.problem("B.lean#q") as NonNullable<typeof problem>, DEFAULT_IMPASSE), undefined);
    journal.close();
  });
});
