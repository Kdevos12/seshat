import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line, M12_OPTIONS } from "@seshat/scheduler";
import type { Line } from "@seshat/lines";
import { buildReport, renderRunReport } from "../src/report.ts";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { AUX, m12Answer, SKETCH_PROOF } from "./m12-helpers.ts";
import { certifier, sessionPromptOf } from "./resume-helpers.ts";

const json = (proof: string) => say(JSON.stringify({ proof }));
const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => e.data.data as Record<string, unknown>);

describe("line M12 in a run", () => {
  it("is registered, with its options", async () => {
    const { LINES } = await import("../src/index.ts");
    assert.equal(LINES.M12?.id, "M12");
    assert.equal(LINES.M12?.resume, "rebuild");
    assert.ok(LINES.M12?.hooks.resumeProblem !== undefined && LINES.M12.hooks.schedule !== undefined);
    assert.equal(M12_OPTIONS.innerSessions, 8);
  });

  it("proves two subgoals and settles the parent through propagation", { timeout: 30000 }, async () => {
    const line = createM12Line();
    const { certifier: cert } = certifier();
    const { result, events, faux } = await demoRun({
      lines: { M12: line },
      config: { lines: ["M12"], provers: 1, sessions: 3 },
      lean: new DemoLean(m12Answer),
      certifier: cert,
      // The outer prover checks its sketch and ends the session; between its sessions the scheduler proves the two holes.
      responses: [check(SKETCH_PROOF, AUX), say("Two lemmas are left."), json("exact hole_ok"), json("exact hole_ok")],
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;

    // The holes are claims of the line, joined to the problem's claim by a decomposition that Lean checked.
    const holes = ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"));
    assert.deepEqual(holes.map((e) => e.data.statement), ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n"]);
    const edges = ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into");
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.data.from, claimId);
    assert.deepEqual(edges[0]?.data.to, holes.map((e) => e.data.claimId));
    assert.deepEqual(ofType(events, "edge.status_changed").map((e) => e.data.to), ["lean_checked"]);

    // One task for each hole, proposed by the line, ended `done` by the orchestrator.
    const created = ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12");
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((e) => e.data.budget), [{ sessions: 8 }, { sessions: 8 }]);
    for (const task of created) {
      const moves = ofType(events, "task.status_changed").filter((e) => e.data.taskId === task.data.taskId).map((e) => e.data.to);
      assert.deepEqual(moves, ["ready", "running", "done"]);
    }

    // Each hole was proved by one model call from the line, and the parent was composed from the holes and the link.
    assert.deepEqual(ofType(events, "model_call.finished").filter((m) => m.data.line === "M12").map((m) => m.data.site), ["scheduler.inner", "scheduler.inner"]);
    assert.equal(nodes(events, "m12_session").filter((n) => n.ok === true).length, 2);
    const derivations = nodes(events, "derivation");
    assert.deepEqual(derivations.map((d) => [d.goal, d.rule, d.verdict]), [["proved", "decomposes_into/parts", "valid"]]);
    const parent = ofType(events, "claim.status_changed").filter((e) => e.data.claimId === claimId).map((e) => e.data.to);
    assert.deepEqual(parent, ["computed", "proved"]);
    // The second outer session never started: the problem was settled between the first and the second.
    assert.equal(ofType(events, "attempt.started").length, 1);
    assert.equal(faux.getPendingResponseCount(), 0);
  });

  it("feeds the lemma it proved, with its name, to the outer prover's next briefing, within the inner budget", { timeout: 30000 }, async () => {
    const line = createM12Line();
    const prompts: string[] = [];
    const watch = (step: ReturnType<typeof say>) => (context: Parameters<typeof sessionPromptOf>[0]) => {
      if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
      return step;
    };
    const { result, events } = await demoRun({
      lines: { M12: line },
      config: { lines: ["M12"], provers: 1, sessions: 2, lineOptions: { M12: { innerSessions: 1, rounds: 1 } } },
      lean: new DemoLean(m12Answer),
      // The scheduler proves the left hole, and its one session on the right hole fails; the second outer session reads both facts.
      responses: [watch(check(SKETCH_PROOF, AUX)), say("Two lemmas are left."), json("exact hole_ok"), json("exact bad"), watch(say("I will not go on."))],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0] ?? "", /Lemmas of your sketch/);
    const second = prompts[1] ?? "";
    assert.match(second, /Lemmas of your sketch/);
    assert.match(second, /lemma aux_left \(n : ℕ\) : 0 \+ n = n := by\n {2}exact hole_ok/);
    assert.match(second, /Not proved: aux_right/);
    // The right hole's task used its one session and failed; no retry, since a hole has one task here.
    const tasks = ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12");
    assert.equal(tasks.length, 2);
    const ends = tasks.map((t) => ofType(events, "task.status_changed").filter((e) => e.data.taskId === t.data.taskId).at(-1)?.data.to);
    assert.deepEqual(ends, ["done", "failed"]);
    assert.deepEqual(nodes(events, "m12_session").map((n) => n.ok), [true, false]);
  });

  it("makes no more tasks than maxInnerTasks, and none when the sketch cannot be split", { timeout: 30000 }, async () => {
    const line = createM12Line();
    const { events } = await demoRun({
      lines: { M12: line },
      config: { lines: ["M12"], provers: 1, sessions: 2, lineOptions: { M12: { maxInnerTasks: 1, rounds: 1 } } },
      lean: new DemoLean(m12Answer),
      responses: [check(SKETCH_PROOF, AUX), say("Two lemmas are left."), json("exact hole_ok"), say("done")],
    });
    assert.equal(ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12").length, 1);

    // A main proof with a sorry of its own leaves no hole for a subgoal: nothing is registered.
    const again = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 1 },
      lean: new DemoLean(m12Answer),
      responses: [check("sorry", AUX), say("done")],
    });
    assert.equal(ofType(again.events, "task.created").filter((e) => e.data.proposedBy === "line:M12").length, 0);
    assert.deepEqual(nodes(again.events, "m12_sketch").map((n) => [n.healthy, n.problem]), [[false, "the main proof has a sorry of its own"]]);
    assert.deepEqual(ofType(again.events, "node.updated").map((e) => e.data.patch), [{ registered: true }]);
  });

  /** A line of rung 1 that notes what it is asked. */
  function rungLine(calls: string[]): Line {
    return {
      id: "M14",
      title: "a line of the first rung",
      requires: [],
      rung: 1,
      resume: "stateless",
      hooks: {
        beforeProvers: async (problem) => void calls.push(`begin:${problem.problemId.slice(-11)}`),
        briefing: async (session) => {
          calls.push(`briefing:${session.session}`);
          return { title: "From the first rung", text: "A rung-1 hint." };
        },
      },
    };
  }

  it("moves a problem up when its budget is spent without Lean progress, and the line of the rung starts then", { timeout: 30000 }, async () => {
    const calls: string[] = [];
    const { events, result } = await demoRun({
      lines: { M12: createM12Line(), M14: rungLine(calls) },
      config: { lines: ["M12", "M14"], provers: 1, sessions: 3, budget: { problemUsd: 0.02 } },
      lean: new DemoLean(m12Answer),
      responses: [check("bad"), say("notes"), check("bad"), say("notes"), say("notes")],
    });
    const moves = ofType(events, "ladder.escalated");
    assert.equal(moves.length, 1);
    assert.deepEqual([moves[0]?.data.from, moves[0]?.data.to, moves[0]?.data.lines, moves[0]?.data.threshold, moves[0]?.actor], [0, 1, ["M14"], 0.3, "orchestrator"]);
    assert.ok((moves[0]?.data.sinceProgressUsd ?? 0) >= 0.3 * 0.02);
    assert.match(moves[0]?.data.reason ?? "", /dollars spent without Lean progress \(0 subclaim\(s\) proved, no healthy sketch\)/);
    // The rung-1 line did nothing for the first session, started when the problem moved up, and briefed the sessions after.
    assert.ok(calls[0]?.startsWith("begin:"), calls.join(" "));
    assert.ok(!calls.includes("briefing:1"));
    assert.ok(calls.includes("briefing:2"));
    assert.equal(result.problems[0]?.outcome, "unsolved");
    // The report: dollars per rung add up to the problem's cost, and an unsolved problem has no solving rung.
    const report = buildReport(events);
    const ladder = report.problems[0]?.ladder;
    assert.equal(ladder?.endedAtRung, 1);
    assert.equal(ladder?.solvedAtRung, undefined);
    assert.ok((ladder?.usdByRung["0"] ?? 0) > 0 && (ladder?.usdByRung["1"] ?? 0) > 0, JSON.stringify(ladder));
    const total = Object.values(ladder?.usdByRung ?? {}).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - (report.problems[0]?.usd ?? -1)) < 1e-9, `${total} vs ${report.problems[0]?.usd}`);
    assert.match(renderRunReport(report), /\| Problem \| Solving rung \| Dollars per rung \|/);
  });

  it("does not move a problem that makes Lean progress, and starts every line at once with the ladder off", { timeout: 30000 }, async () => {
    const calls: string[] = [];
    const progress = await demoRun({
      lines: { M12: createM12Line(), M14: rungLine(calls) },
      config: { lines: ["M12", "M14"], provers: 1, sessions: 2, budget: { problemUsd: 0.04 }, lineOptions: { M12: { innerSessions: 1, rounds: 1 } } },
      lean: new DemoLean(m12Answer),
      // The first session ends with a healthy sketch: a hole proved, or at least a sketch with two open holes, is Lean progress.
      responses: [check(SKETCH_PROOF, AUX), say("notes"), json("exact bad"), json("exact bad"), check("bad"), say("notes")],
    });
    assert.deepEqual(ofType(progress.events, "ladder.escalated"), []);
    assert.deepEqual(calls, []);
    assert.ok(nodes(progress.events, "ladder_progress").some((n) => n.holes === 2), "the healthy sketch is recorded as progress");

    const off: string[] = [];
    await demoRun({
      lines: { M12: createM12Line(), M14: rungLine(off) },
      config: { lines: ["M12", "M14"], provers: 1, sessions: 2, budget: { problemUsd: 5 }, lineOptions: { M12: { ladder: false } } },
      lean: new DemoLean(m12Answer),
      responses: [check("bad"), say("notes"), say("notes")],
    });
    assert.ok(off[0]?.startsWith("begin:") && off.includes("briefing:1"), off.join(" "));
  });
});
