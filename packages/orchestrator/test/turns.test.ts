import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BlobStore, type HarnessEvent, readEvents } from "@seshat/core";
import type { Line } from "@seshat/lines";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { ablationRefusal, buildReport, type ConsortiumConfig, renderRunReport, type RunConfig } from "../src/index.ts";
import { assertSound } from "./resume-helpers.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";
import { blobsOf, consortium, ended, TWO_PROBLEM_IDS, TWO_PROBLEMS } from "./turns-helpers.ts";

describe("a consortium turn", () => {
  const spare = () => Array.from({ length: 12 }, () => check("bad"));

  for (const [kind, limit] of [
    ["tokens", { tokens: 100 }],
    ["usd", { usd: 0.001 }],
  ] as const) {
    it(`stops at its ${kind} limit: no session starts and no model call is sent after it`, async () => {
      const run = await demoRun({
        file: TWO_PROBLEMS,
        problems: 2,
        config: { consortium: consortium(limit), sessions: 4 },
        responses: spare(),
      });
      const turn = ended(run.events);
      assert.equal(turn.data.reason, kind);
      assert.equal(turn.data.turn, 1);
      assert.match(turn.data.detail, new RegExp(`limit is ${kind === "usd" ? "\\$" : ""}${Object.values(limit)[0]}`));
      // One response was in flight when the limit was reached: it finished, and nothing was sent after it.
      assert.equal(run.faux.state.callCount, 1);
      assert.equal(run.faux.getPendingResponseCount(), 11);
      // The second problem never started; the first one waits.
      assert.equal(ofType(run.events, "problem.registered").length, 1);
      assert.equal(ofType(run.events, "problem.finished").length, 0);
      // The first problem was begun and the second was not: both wait for the next turn.
      assert.deepEqual(turn.data.waiting, TWO_PROBLEM_IDS);
      // The turn is not the run's end.
      assert.equal(ofType(run.events, "run.finished").length, 0);
      assert.equal(run.result.stopped, undefined);
      assert.deepEqual(
        { number: run.result.turn?.number, reason: run.result.turn?.reason, paused: run.result.turn?.paused, account: run.result.turn?.account },
        { number: 1, reason: kind, paused: true, account: "turns/1/report.md" },
      );
      // What was spent in the turn is what the run spent.
      const spent = ofType(run.events, "attempt.finished").reduce((sum, e) => sum + e.data.usd, 0);
      assert.ok(Math.abs(turn.data.spent.turn.usd - spent) < 1e-9);
      assert.deepEqual(turn.data.spent.turn, turn.data.spent.run);
      assert.ok(turn.data.spent.turn.inputTokens + turn.data.spent.turn.outputTokens >= 100 || kind === "usd");
      assertSound(run.events);
      assert.ok(existsSync(join(run.dir, "turns", "1", "report.md")));
      assert.ok(existsSync(join(run.dir, "turns", "1", "report.json")));
    });
  }

  it("stops at its minutes limit, counted by the process's clock", async () => {
    let now = 0;
    const run = await demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      config: { consortium: consortium({ minutes: 5 }), sessions: 4 },
      turns: { clock: () => now },
      responses: [
        () => {
          now += 6 * 60_000; // the call takes six minutes
          return check("bad");
        },
        ...spare(),
      ],
    });
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "minutes");
    assert.match(turn.data.detail, /lasted 6\.0 minutes, and its limit is 5/);
    assert.equal(turn.data.minutes, 6);
    assert.equal(run.faux.state.callCount, 1);
    assert.equal(ofType(run.events, "problem.registered").length, 1);
  });

  it("counts the one-shot calls of the lines in the turn, and sends none once it is over", async () => {
    const asked: string[] = [];
    const line: Line = {
      id: "M4",
      title: "asks twice",
      requires: [],
      resume: "stateless",
      hooks: {
        beforeProvers: async (problem) => {
          asked.push((await problem.llm.complete({ prompt: "First question.", site: "test.first" })).text);
          asked.push((await problem.llm.complete({ prompt: "Second question.", site: "test.second" })).text);
        },
      },
    };
    const run = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"], consortium: consortium({ tokens: 1 }) },
      responses: [say("first answer"), say("second answer"), ...spare()],
    });
    // The first call reached the limit; the second was refused before it was sent; no session started.
    assert.deepEqual(asked, ["first answer"]);
    assert.equal(run.faux.state.callCount, 1);
    assert.equal(ofType(run.events, "model_call.finished").length, 1);
    assert.equal(ofType(run.events, "attempt.started").length, 0);
    const turn = ended(run.events);
    assert.equal(turn.data.reason, "tokens");
    assert.ok(turn.data.spent.turn.inputTokens > 0);
    // The line did not fail: the problem waits, and is not an error.
    assert.equal(ofType(run.events, "problem.finished").length, 0);
    assert.equal(run.result.turn?.paused, true);
  });

  it("does not take a line's call inside a session for a failure of the harness once the turn is over", async () => {
    const line: Line = {
      id: "M4",
      title: "asks after each check",
      requires: [],
      resume: "stateless",
      hooks: {
        afterCheck: async (session) => {
          await session.llm.complete({ prompt: "What do you make of that check?", site: "test.review" });
          return undefined;
        },
      },
    };
    const run = await demoRun({
      lines: { M4: line },
      config: { lines: ["M4"], sessions: 3, consortium: consortium({ tokens: 1 }) },
      responses: [check("bad"), say("never asked"), ...spare()],
    });
    const [attempt] = ofType(run.events, "attempt.finished");
    assert.deepEqual([attempt?.data.outcome, attempt?.data.stoppedBy, attempt?.data.error], ["aborted", "turn", undefined]);
    assert.equal(run.faux.state.callCount, 1, "the line's call was refused before it was sent");
    assert.equal(ofType(run.events, "problem.finished").length, 0, "the problem waits; it is no error");
    assert.equal(ended(run.events).data.reason, "tokens");
  });

  it("stops every prover of a problem, and journals what each session carried", async () => {
    const run = await demoRun({
      config: { provers: 2, sessions: 3, consortium: consortium({ tokens: 1 }) },
      responses: spare(),
    });
    // Both sessions were in flight: each finished its response and stopped. Nothing was sent after those.
    const attempts = ofType(run.events, "attempt.finished");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((a) => [a.data.outcome, a.data.stoppedBy]), [["aborted", "turn"], ["aborted", "turn"]]);
    assert.equal(run.faux.state.callCount, 2);
    assert.equal(run.faux.getPendingResponseCount(), 10);
    const blobs = blobsOf(run.dir);
    for (const attempt of attempts) {
      const carry = attempt.data.carry;
      assert.ok(carry !== undefined, "the session handed its notes and sketch on");
      const regions = JSON.parse(readBlob(blobs, carry.regions)) as { aux: string; proof: string };
      assert.equal(regions.proof, "bad", "the sketch the session had reached is kept");
      assert.match(readBlob(blobs, carry.notes ?? ""), /The turn ended during session 1, after 1 check\(s\)/);
    }
    // Their tasks stay `running`, as a killed process leaves them; the pause writes no `ready` before a resumption.
    const tasks = ofType(run.events, "task.status_changed").filter((e) => e.data.to === "ready" && e.data.from === "running");
    assert.equal(tasks.length, 0);
    assertSound(run.events);
  });

  it("keeps the notes a session wrote before the turn ended, and the sketch of its last check", async () => {
    // Session 1 ends by itself with its notes; session 2 is cut by the turn after its first check.
    const run = await demoRun({
      config: { sessions: 3, consortium: consortium({ tokens: 4000 }) },
      responses: [check("bad"), say("NOTES: bad is not a lemma."), check("rfl"), ...spare()],
    });
    const attempts = ofType(run.events, "attempt.finished");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.data.stoppedBy, "model");
    assert.equal(attempts[1]?.data.stoppedBy, "turn");
    const carry = attempts[1]?.data.carry;
    const blobs = blobsOf(run.dir);
    assert.match(readBlob(blobs, carry?.notes ?? ""), /NOTES: bad is not a lemma\./, "the earlier notes go on");
    assert.match(readBlob(blobs, carry?.notes ?? ""), /The turn ended during session 2/);
    assert.equal((JSON.parse(readBlob(blobs, carry?.regions ?? "")) as { proof: string }).proof, "rfl");
  });

  it("is a clean pause: the journal is sound, the report says the run is paused, and the next turn would resume it", async () => {
    const run = await demoRun({ config: { consortium: consortium({ tokens: 100 }), sessions: 3 }, responses: spare() });
    const report = buildReport(run.events);
    assert.equal(report.finished, false);
    assert.deepEqual(report.turns, {
      count: 1,
      reasons: { tokens: 1 },
      paused: true,
      last: { turn: 1, reason: "tokens", detail: ended(run.events).data.detail, waiting: 1 },
    });
    assert.match(renderRunReport(report), /The run is paused after turn 1 \(tokens: .*\); 1 problem\(s\) wait for the team\. Its account is turns\/1\/report\.md\./);
    assert.match(readFileSync(join(run.dir, "report.md"), "utf8"), /The run is paused after turn 1/);
    // The journal alone rebuilds the same report.
    assert.deepEqual(buildReport(readEvents(join(run.dir, "journal.jsonl"))), report);
  });

  it("is not a consortium run without the option: the journal has no turn events", async () => {
    const run = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal(run.events.some((e: HarnessEvent) => e.type.startsWith("turn.")), false);
    assert.equal(run.result.turn, undefined);
    assert.equal(existsSync(join(run.dir, "turns")), false);
    assert.equal(buildReport(run.events).turns, undefined);
  });

  it("adds a model-written narrative with its own small budget, counted in the turn, when it is asked for", async () => {
    const narrate: FauxResponseStep = (context) => {
      const prompt = context.messages.find((m) => m.role === "user");
      const text = typeof prompt?.content === "string" ? prompt.content : "";
      const claim = /clm_[0-9A-Z]{26}/.exec(text)?.[0] ?? "";
      return say(`The claim [cite: ${claim}] is still open; one session was cut by the turn.`);
    };
    const run = await demoRun({
      config: { sessions: 3, consortium: consortium({ tokens: 1 }) },
      turns: { narrative: true },
      responses: [check("bad"), narrate],
    });
    const turn = ended(run.events);
    const hash = turn.data.narrative?.hash;
    assert.ok(hash !== undefined, "a narrative was kept");
    // The call is a model call of the orchestrator at its own site, written before the turn ended and so counted in it.
    const [call] = ofType(run.events, "model_call.finished");
    assert.deepEqual([call?.actor, call?.data.line, call?.data.site, call?.data.outcome, call?.data.problemId], ["orchestrator", "orchestrator", "turn.narrative", "ok", undefined]);
    assert.ok((call?.seq ?? Infinity) < turn.seq, "it was written before the turn ended");
    const sessions = ofType(run.events, "attempt.finished").reduce((sum, e) => sum + e.data.usd, 0);
    assert.ok(Math.abs(turn.data.spent.turn.usd - sessions - (call?.data.usd ?? 0)) < 1e-9, "the turn's spend includes the narrative");
    assert.equal(run.faux.state.callCount, 2, "the session's call and the narrative's");
    const account = JSON.parse(readFileSync(join(run.dir, "turns", "1", "report.json"), "utf8")) as { narrative?: { text: string; modelWritten: boolean } };
    assert.equal(account.narrative?.modelWritten, true);
    assert.match(account.narrative?.text ?? "", /^The claim \[cite: clm_\w+\] is still open/);
    assert.match(readFileSync(join(run.dir, "turns", "1", "report.md"), "utf8"), /### Narrative \(written by a model, not part of the record\)/);
  });

  it("leaves out a narrative whose ids do not resolve, says why, and the account stays whole", async () => {
    const run = await demoRun({
      config: { sessions: 3, consortium: consortium({ tokens: 1 }) },
      turns: { narrative: true },
      responses: [check("bad"), say("It is solved [cite: clm_0000000000000000000000000A]."), say("Still [cite: nod_0000000000000000000000000B].")],
    });
    const turn = ended(run.events);
    assert.equal(turn.data.narrative?.hash, undefined);
    assert.match(turn.data.narrative?.rejected ?? "", /cited nod_0000000000000000000000000B, which resolve to nothing in the journal/);
    assert.equal(run.faux.state.callCount, 3, "one try and one correction");
    const md = readFileSync(join(run.dir, "turns", "1", "report.md"), "utf8");
    assert.match(md, /A model-written narrative was asked for and refused: it cited/);
    assert.doesNotMatch(md, /It is solved/);
  });

  it("is refused for an ablation, which measures lines against each other and so must not differ in anything else", () => {
    assert.match(ablationRefusal({ consortium: consortium({ tokens: 10 }) }) ?? "", /cannot go with an ablation/);
    assert.equal(ablationRefusal({}), undefined);
  });

  it("refuses a configuration with a limit that is not a positive number", async () => {
    const bad: ConsortiumConfig = { limit: { tokens: -1 }, impasse: { posteriorBelow: 0.1, minAttempts: 8 }, narrative: false };
    await assert.rejects(demoRun({ config: { consortium: bad } as Partial<RunConfig>, responses: [] }), /turn limit tokens must be a positive number/);
  });
});

function readBlob(blobs: BlobStore, hash: string): string {
  const text = blobs.get(hash);
  assert.ok(text !== undefined, `blob ${hash} exists`);
  return text;
}
