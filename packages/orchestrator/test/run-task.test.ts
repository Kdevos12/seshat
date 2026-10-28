import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createM12Line } from "@seshat/scheduler";
import type { Line, TaskEnd } from "@seshat/lines";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { m12Answer } from "./m12-helpers.ts";

/** A line that is not the scheduling line, proposes one task, and works it itself through `runTask`. */
function worker(seen: string[], end: (n: number) => TaskEnd): Line {
  let proposed = false;
  return {
    id: "M14",
    title: "a line that works its own task",
    requires: ["M12"],
    resume: "stateless",
    hooks: {
      beforeProvers: async (problem) => {
        if (proposed) return;
        proposed = true;
        const result = problem.tasks.propose({ kind: "prove", acceptance: { type: "claim", claimId: problem.claimId, minStatus: "computed" }, budget: { sessions: 1 }, title: "its own work" });
        assert.equal(result.accepted, true);
      },
      runTask: async (problem, task, owner) => {
        seen.push(`${task.proposedBy}|${task.status}|${owner}|${problem.line}`);
        return end(seen.length);
      },
    },
  };
}

describe("a line's runTask", () => {
  it("works the task the line proposed, and the orchestrator ends it by the answer and its criterion", { timeout: 30000 }, async () => {
    const seen: string[] = [];
    const { events } = await demoRun({
      lines: { M12: createM12Line(), M14: worker(seen, () => ({ ended: "failed", reason: "no luck" })) },
      config: { lines: ["M12", "M14"], provers: 1, sessions: 2 },
      lean: new DemoLean(m12Answer),
      responses: [check("bad"), say("notes"), say("notes")],
    });
    assert.equal(seen.length, 1, "worked once");
    assert.match(seen[0] ?? "", /^line:M14\|ready\|[^|]+\|M14$/);
    const task = ofType(events, "task.created").find((e) => e.data.proposedBy === "line:M14");
    assert.ok(task !== undefined);
    const moves = ofType(events, "task.status_changed").filter((e) => e.data.taskId === task.data.taskId);
    assert.deepEqual(moves.map((e) => e.data.to), ["ready", "running", "failed"]);
    assert.match(moves[1]?.data.reason ?? "", /^worked by line M14: proposed by line M14, which works it/);
    assert.equal(moves[2]?.data.reason, "no luck");
  });

  it("fails a task answered done whose criterion does not hold", { timeout: 30000 }, async () => {
    const seen: string[] = [];
    const { events } = await demoRun({
      lines: { M12: createM12Line(), M14: worker(seen, () => ({ ended: "done", reason: "believed" })) },
      config: { lines: ["M12", "M14"], provers: 1, sessions: 2 },
      lean: new DemoLean(m12Answer),
      responses: [check("bad"), say("notes"), say("notes")],
    });
    const task = ofType(events, "task.created").find((e) => e.data.proposedBy === "line:M14");
    const last = ofType(events, "task.status_changed").filter((e) => e.data.taskId === task?.data.taskId).at(-1);
    assert.equal(last?.data.to, "failed");
    assert.match(last?.data.reason ?? "", /believed, but the task's criterion does not hold/);
  });
});
