import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { type HarnessEvent, isFinalTaskStatus, readEvents, verifyChain } from "@seshat/core";
import { check, demoBench, demoResume, ofType, tempDir } from "./m0-helpers.ts";

const FIXTURE = new URL("./fixtures/killable-run.ts", import.meta.url).pathname;

/** The text of the first user message of a request: the session prompt. */
function sessionPromptOf(context: TranscriptContext): string {
  const first = context.messages.find((m) => m.role === "user");
  if (first?.role !== "user") return "";
  return typeof first.content === "string" ? first.content : first.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** Whether a tool run has begun and not ended. */
const checking = (events: readonly HarnessEvent[]): boolean => ofType(events, "tool_run.started").length > ofType(events, "tool_run.finished").length;

/**
 * Runs a scenario of `fixtures/killable-run.ts` in another process, and kills it with SIGKILL, which
 * no handler sees and nothing is flushed for, as soon as `ready` holds of its journal.
 */
async function killedRun(scenario: string, ready: (events: readonly HarnessEvent[]) => boolean) {
  const bench = demoBench();
  const root = tempDir();
  const benchFile = join(root, "bench.json");
  writeFileSync(benchFile, JSON.stringify(bench));
  const dir = join(root, "run");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", FIXTURE, benchFile, dir, scenario], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the run ended on its own before the point to kill it at:\n${stderr}`);
      const path = join(dir, "journal.jsonl");
      if (existsSync(path) && ready(readEvents(path))) break;
      if (Date.now() > deadline) throw new Error(`the run did not reach the point to kill it at in 60 s:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  return { dir, bench };
}

describe("resuming a run whose process was killed", () => {
  it("takes up a run killed in the middle of a check: the session is closed as cut and the next one starts from the notes of the last that ended", async () => {
    const { dir, bench } = await killedRun("single", (events) => ofType(events, "attempt.started").length === 2 && checking(events));
    const killed = readEvents(join(dir, "journal.jsonl"));
    assert.equal(killed.at(-1)?.type, "tool_run.started", "the journal ends in the middle of the check");

    const prompts: string[] = [];
    const resumed = await demoResume({
      dir,
      bench,
      responses: [(context) => { prompts.push(sessionPromptOf(context)); return check("exact trivial_proof"); }],
    });
    assert.deepEqual(verifyChain(resumed.events), { ok: true });
    const resumption = ofType(resumed.events, "run.resumed")[0];
    assert.deepEqual(resumption?.data.interrupted, { attempts: 1, toolRuns: 1, tasks: 1 });
    assert.equal(resumed.faux.state.callCount, 1);
    assert.match(prompts[0] ?? "", /This is session 3 of at most 3/);
    assert.match(prompts[0] ?? "", /# Your notes from the previous sessions\nNOTES: bad is not a lemma\./);
    assert.deepEqual(ofType(resumed.events, "attempt.finished").map((a) => [a.data.outcome, a.data.stoppedBy ?? null]), [
      ["invalid", "model"],
      ["aborted", "interrupted"],
      ["valid", "solved"],
    ]);
    assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), [["candidate", 3]]);
    assert.equal(ofType(resumed.events, "task.created").length, 1);
  });

  it("takes up only the prover that was cut, and leaves the one that had ended ended", async () => {
    const { dir, bench } = await killedRun("pair", (events) => checking(events) && ofType(events, "task.status_changed").some((e) => isFinalTaskStatus(e.data.to)));
    const killed = readEvents(join(dir, "journal.jsonl"));
    const ended = ofType(killed, "task.status_changed").find((e) => isFinalTaskStatus(e.data.to));
    assert.equal(ended?.data.to, "failed", "the prover that was not cut used its two sessions");

    const resumed = await demoResume({ dir, bench, responses: [check("exact trivial_proof")] });
    assert.deepEqual(verifyChain(resumed.events), { ok: true });
    assert.equal(ofType(resumed.events, "task.created").length, 2, "the provers' tasks are the ones they had");
    assert.deepEqual(ofType(resumed.events, "run.resumed")[0]?.data.interrupted, { attempts: 1, toolRuns: 1, tasks: 1 });
    const after = resumed.events.slice(killed.length);
    const moved = ofType(after, "task.status_changed");
    // The cut prover's task goes back to ready and runs again; the other one's task is not touched.
    assert.ok(moved.every((e) => e.data.taskId !== ended?.data.taskId), "the task that had ended is not moved");
    assert.deepEqual(moved.slice(0, 2).map((e) => [e.data.from, e.data.to]), [["running", "ready"], ["ready", "running"]]);
    assert.match(moved[1]?.data.reason ?? "", /^prover p[12] resumes after the interruption, at session 2$/);
    assert.equal(resumed.faux.state.callCount, 1);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"]);
  });
});
