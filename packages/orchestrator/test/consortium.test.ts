import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { Line } from "@seshat/lines";
import { buildReport, hintCommand, steerCommand } from "../src/index.ts";
import { assertSound, certifier, nth } from "./resume-helpers.ts";
import { certifyingRegistry, check, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { consortium, ended, TWO_PROBLEM_IDS, TWO_PROBLEMS } from "./turns-helpers.ts";

/** A session that fails and says so: two model responses. */
const failing = (n: number): FauxResponseStep[] => Array.from({ length: n }, (_, i) => [check("bad"), say(`NOTES ${i}: bad is not a lemma.`)]).flat();

describe("breakpoints", () => {
  it("end the turn at an impasse: the posterior of a problem is low after enough failed attempts", async () => {
    const run = await demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      config: { sessions: 6, consortium: consortium({}, { impasse: { posteriorBelow: 0.5, minAttempts: 2 } }) },
      responses: failing(8),
    });
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "impasse");
    assert.deepEqual(turn.data.breakpoint, { kind: "impasse", problemId: TWO_PROBLEM_IDS[0] });
    assert.match(turn.data.detail, /2 finished attempts and its success posterior is 0\.250, at or below 0\.5/);
    // No limit was given: only the breakpoint ended the turn. Two sessions, four responses; none after the breakpoint.
    assert.deepEqual(ofType(run.events, "turn.started")[0]?.data.limit, {});
    assert.equal(ofType(run.events, "attempt.finished").length, 2);
    assert.equal(run.faux.state.callCount, 4);
    assert.equal(ofType(run.events, "problem.registered").length, 1, "the second problem did not start");
    assert.deepEqual(turn.data.waiting, TWO_PROBLEM_IDS);
    assert.equal(run.result.turn?.reason, "impasse");
    assert.match(readFileSync(join(run.dir, "turns", "1", "report.md"), "utf8"), /at an impasse/);

    // The next turn does not stop at the same impasse at once: it takes as many new attempts as an impasse needs.
    const next = await demoResume({ dir: run.dir, bench: run.bench, responses: failing(8) });
    const second = ended(next.events);
    assert.equal(second.data.turn, 2);
    assert.equal(second.data.reason, "impasse");
    assert.equal(ofType(next.events, "attempt.finished").length, 4, "two more attempts, then the impasse again");
    assert.equal(next.faux.state.callCount, 4);
    assert.equal(ofType(next.events, "run.finished").length, 0);
    assertSound(next.events);
  });

  it("fire at the 8th failed attempt with the defaults (8 attempts, a posterior of 0.1), not at the 9th", async () => {
    const run = await demoRun({ config: { sessions: 12, consortium: consortium() }, responses: failing(12) });
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "impasse");
    assert.equal(ofType(run.events, "attempt.finished").length, 8, "the 8th attempt strikes the breakpoint; no 9th begins");
    assert.match(turn.data.detail, /has 8 finished attempts and its success posterior is 0\.100, at or below 0\.1/);
    // One attempt fewer is not an impasse yet.
    const seven = await demoRun({ config: { sessions: 7, consortium: consortium() }, responses: failing(7) });
    assert.notEqual(ended(seven.events).data.breakpoint?.kind, "impasse", "7 failed attempts: posterior 0.111");
    assert.equal(ofType(seven.events, "attempt.finished").length, 7);
  });

  it("end the turn when a problem is settled, once, and the next turn goes on to the other problems", async () => {
    const c = certifier();
    const run = await demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      config: { sessions: 3, consortium: consortium() },
      registry: certifyingRegistry(c.certifier),
      certifier: c.certifier,
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
    });
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "settled");
    assert.deepEqual(turn.data.breakpoint, { kind: "settled", problemId: TWO_PROBLEM_IDS[0] });
    assert.match(turn.data.detail, /add_zero' is proved|is proved/);
    assert.deepEqual(turn.data.waiting, [TWO_PROBLEM_IDS[1]]);
    assert.equal(ofType(run.events, "problem.finished")[0]?.data.outcome, "proved");
    assert.equal(run.faux.state.callCount, 1);
    assert.equal(ofType(run.events, "run.finished").length, 0, "the run waits: the second problem has not begun");

    const next = await demoResume({ dir: run.dir, bench: run.bench, responses: [check("exact trivial_proof")], registry: certifyingRegistry(c.certifier), certifier: c.certifier });
    // The second problem is settled too, which is a new breakpoint of the same kind; but no problem is left, so the run ends.
    const last = ended(next.events);
    assert.equal(last.data.turn, 2);
    assert.equal(last.data.reason, "finished");
    assert.deepEqual(last.data.waiting, []);
    assert.equal(ofType(next.events, "run.finished").length, 1);
    assert.equal(next.result.turn?.paused, false);
    assert.deepEqual(ofType(next.events, "problem.finished").map((e) => e.data.outcome), ["proved", "proved"]);
    assert.equal(buildReport(next.events).turns?.paused, false);
  });

  it("end the turn when two informal validators disagree, and report it once", async () => {
    const line: Line = {
      id: "M4",
      title: "records a disagreement",
      requires: [],
      resume: "stateless",
      hooks: {
        beforeProvers: async (problem) => {
          problem.memory.recordNode({ kind: "judgment", claimId: problem.claimId, data: { disagreement: true, subject: "the step from n to n+1", votes: ["sound", "gap"] } });
        },
      },
    };
    const run = await demoRun({ lines: { M4: line }, config: { lines: ["M4"], sessions: 3, consortium: consortium() }, responses: [check("bad"), say("NOTES: x"), check("bad"), say("NOTES: y"), check("exact trivial_proof")] });
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "disagreement");
    assert.equal(turn.data.breakpoint?.kind, "disagreement");
    assert.match(turn.data.detail, /two informal validators disagree about clm_\w+: the step from n to n\+1/);
    assert.equal(run.faux.state.callCount, 2, "the first session ended, and no other began");

    // It is not reported again: the next turn works the problem on.
    const next = await demoResume({ dir: run.dir, bench: run.bench, lines: { M4: line }, responses: [check("bad"), say("NOTES: y"), check("exact trivial_proof")] });
    assert.equal(ended(next.events).data.reason, "finished");
    assert.equal(ofType(next.events, "problem.finished")[0]?.data.outcome, "candidate");
  });
});

describe("a pause", () => {
  it("reads a steer given after a crash and before the resume: the next turn's limit is the team's, not the one carried over", async () => {
    const whole = await demoRun({ config: { sessions: 3, consortium: consortium({ tokens: 5000 }) }, responses: [check("bad"), say("NOTES"), check("exact trivial_proof")] });
    // The process died in the middle of turn 1 (no turn.ended). The team answers afterwards.
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    assert.equal(steerCommand(dir, { limit: { tokens: 7777 }, as: "alice", out: () => undefined }), 0);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")] });
    const second = ofType(resumed.events, "turn.started")[1];
    assert.deepEqual([second?.data.limit, second?.data.source], [{ tokens: 7777 }, "a steer by alice"]);
    assert.equal(ofType(resumed.events, "turn.ended")[0]?.data.reason, "interrupted");
    // A steer that came before the first turn ended is the first turn's: the next one carries that turn's limit over.
    const carried = await demoResume({ dir: killedAt(whole.dir, nth(whole.events, "attempt.started", 2)), bench: whole.bench, responses: [check("exact trivial_proof")] });
    assert.deepEqual([ofType(carried.events, "turn.started")[1]?.data.limit, ofType(carried.events, "turn.started")[1]?.data.source], [{ tokens: 5000 }, "carried over from turn 1"]);
  });

  it("is closed by the next process if the one before ended without closing its turn", async () => {
    // No limit and no breakpoint: the turn ends with the run. Cut the journal in the middle of the turn, as a kill does.
    const whole = await demoRun({ config: { sessions: 3, consortium: consortium() }, responses: [check("bad"), say("NOTES"), check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")] });
    const turns = resumed.events.filter((e) => e.type === "turn.started" || e.type === "turn.ended").map((e) => (e.type === "turn.started" ? `started ${e.data.turn}` : `ended ${e.data.turn} ${e.data.reason}`));
    assert.deepEqual(turns, ["started 1", "ended 1 interrupted", "started 2", "ended 2 finished"]);
    const interrupted = ofType(resumed.events, "turn.ended")[0];
    assert.match(interrupted?.data.detail ?? "", /ended without closing it/);
    assert.deepEqual(interrupted?.data.waiting, [whole.result.problems[0]?.problemId]);
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assert.ok(existsSync(join(dir, "turns", "2", "report.md")));
    assertSound(resumed.events);
  });
});

describe("a consortium run that starts on another consortium run's memory (--memory-from)", () => {
  it("numbers its own turns from 1, and takes none of the earlier team's hints, drops or forbidden strategies", async () => {
    const earlier = await demoRun({ config: { sessions: 2, consortium: consortium({ tokens: 1 }) }, responses: [check("bad")] });
    const claimId = ofType(earlier.events, "problem.registered")[0]?.data.claimId as string;
    hintCommand(earlier.dir, { claimId, text: "An old hint from another run.", as: "olga", out: () => undefined });
    steerCommand(earlier.dir, { drop: claimId, as: "olga", out: () => undefined });
    steerCommand(earlier.dir, { forbid: "automation", as: "olga", out: () => undefined });

    const prompts: string[] = [];
    const record: FauxResponseStep = (context) => {
      const first = context.messages.find((m) => m.role === "user");
      prompts.push(typeof first?.content === "string" ? first.content : JSON.stringify(first?.content));
      return check("exact trivial_proof");
    };
    const later = await demoRun({ memoryFrom: earlier.dir, config: { sessions: 2, consortium: consortium({}) }, responses: [record, record] });
    assert.equal(ofType(later.events, "problem.registered")[0]?.data.claimId, claimId, "the problem's claim is the earlier run's: its hint and drop name a claim this run works on");
    assert.deepEqual(ofType(later.events, "turn.started").map((e) => e.data.turn), [1], "the earlier run's turns are not this run's");
    assert.equal(ended(later.events).data.turn, 1);
    assert.equal(ofType(later.events, "problem.finished")[0]?.data.outcome, "candidate", "the earlier team's drop did not end the problem");
    assert.ok(prompts.length >= 1);
    assert.doesNotMatch(prompts.join("\n"), /Hints from the team|An old hint|What the team asks|automation/);
    assert.equal(later.events.filter((e) => e.type === "node.recorded" && (e.data.kind === "hint" || e.data.kind === "steer")).length, 0);
    assertSound(later.events);
  });
});
