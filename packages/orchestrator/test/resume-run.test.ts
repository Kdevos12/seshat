import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import {
  type CertificationRequest,
  type CertificationResult,
  type HarnessEvent,
  type LeanCertifier,
  type LeanChecker,
  readEvents,
  verifyChain,
} from "@seshat/core";
import type { LineRegistry } from "@seshat/lines";
import { leanCheckImplementation, loadCatalog, Registry } from "@seshat/registry";
import { buildReport, LINES, M1, readRecordedRun, REPO_ROOT, renderRunReport, type RunOptions } from "../src/index.ts";
import { assertSound, certifier, nth, sessionPromptOf, spent, sum } from "./resume-helpers.ts";
import { certifyingRegistry, check, DEMO_FILE, DemoLean, demoAnswer, demoBench, demoResume, demoRun, killedAt, ofType, sageRegistry, say } from "./m0-helpers.ts";
import { fakeSage } from "./fixtures/fake-sage.ts";

describe("resuming a run whose process ended", () => {
  /** Session 1 fails and leaves notes; session 2 proves. */
  const script = (prompts: string[] = []): FauxResponseStep[] => [
    check("bad"),
    say("NOTES: bad is not a lemma."),
    (context) => {
      prompts.push(sessionPromptOf(context));
      return check("exact trivial_proof");
    },
  ];

  it("goes on from the last session that finished, with what that session handed on, to the outcome of a run that was not cut", async () => {
    const wholePrompts: string[] = [];
    const whole = await demoRun({ config: { sessions: 3 }, responses: script(wholePrompts) });
    const cut = nth(whole.events, "attempt.started", 2);
    const dir = killedAt(whole.dir, cut);

    const resumedPrompts: string[] = [];
    const resumed = await demoResume({ dir, bench: whole.bench, responses: script(resumedPrompts).slice(2) });

    // The same outcome at the same cost, from only the model call that the first process had not made.
    const [was] = whole.result.problems;
    const [now] = resumed.result.problems;
    assert.deepEqual([now?.outcome, now?.attempts], [was?.outcome, was?.attempts]);
    assert.ok(Math.abs((now?.usd ?? 0) - (was?.usd ?? 0)) < 1e-9, "the problem cost the same");
    assert.equal(resumed.faux.state.callCount, 1);
    assert.equal(resumedPrompts.length, 1);
    assert.equal(resumedPrompts[0], wholePrompts[0], "session 2 starts from the same file, last check and notes as in the run that was not cut");
    assert.match(resumedPrompts[0] ?? "", /This is session 2 of at most 3/);
    assert.match(resumedPrompts[0] ?? "", /# Your notes from the previous sessions\nNOTES: bad is not a lemma\./);

    // What the resumption wrote: run.resumed, then the task back to ready, then the work.
    const after = resumed.events.slice(cut);
    const [first, second] = after;
    assert.equal(first?.type, "run.resumed");
    assert.equal(first?.actor, "orchestrator");
    assert.deepEqual(first?.type === "run.resumed" ? [first.data.resumption, first.data.interrupted, first.data.tornTail ?? null] : [], [
      1,
      { attempts: 0, toolRuns: 0, tasks: 1 },
      null,
    ]);
    assert.ok(first?.type === "run.resumed" && Math.abs(first.data.spent.usd - spent(whole.events.slice(0, cut)).charged) < 1e-9, "it records what was spent so far");
    assert.deepEqual(second?.type === "task.status_changed" ? [second.data.from, second.data.to] : [], ["running", "ready"]);
    assert.match(second?.type === "task.status_changed" ? (second.data.reason ?? "") : "", /^the process ended while the task ran; the run was resumed \(resumption 1\)$/);
    const starts = ofType(after, "task.status_changed").filter((e) => e.data.from === "ready");
    assert.match(starts[0]?.data.reason ?? "", /^prover p1 resumes after the interruption, at session 2$/);
    assert.equal(ofType(resumed.events, "task.created").length, 1, "the prover's task is the one it had, not a new one");
    assert.equal(ofType(resumed.events, "run.resumed").length, 1);
    assert.equal(resumed.events.at(-1)?.type, "run.finished");
    assertSound(resumed.events);

    // The report says so.
    assert.deepEqual(resumed.result.report.resumed, { times: 1, interrupted: { attempts: 0, toolRuns: 0, tasks: 1 }, tornTails: 0 });
    assert.match(renderRunReport(resumed.result.report), /The run was resumed 1 time\(s\) after its process ended: 0 session\(s\), 0 tool run\(s\) and 1 task\(s\) were cut\./);
  });

  it("ends the session that the interruption cut, at the cost of what it was billed, and starts the next one", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: script() });
    // The process ended in the middle of session 2: its check was running.
    const cut = nth(whole.events, "tool_run.started", 3) + 1;
    const dir = killedAt(whole.dir, cut);
    const before = whole.events.slice(0, cut);
    const cutAttempt = before.findLast((e) => e.type === "attempt.started");
    assert.equal(cutAttempt?.type === "attempt.started" ? cutAttempt.data.iteration : 0, 2);

    const prompts: string[] = [];
    const resumed = await demoResume({
      dir,
      bench: whole.bench,
      responses: [(context) => { prompts.push(sessionPromptOf(context)); return check("exact trivial_proof"); }],
    });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assert.equal(resumed.result.problems[0]?.attempts, 3, "the cut session is one of the problem's sessions");

    const after = resumed.events.slice(cut);
    const resumption = after[0];
    assert.deepEqual(resumption?.type === "run.resumed" ? resumption.data.interrupted : null, { attempts: 1, toolRuns: 1, tasks: 1 });
    // The tool run and the session end, written by the orchestrator, and the session keeps its cost.
    const [toolRun] = ofType(after, "tool_run.finished");
    assert.deepEqual([toolRun?.actor, toolRun?.data.outcome], ["orchestrator", "aborted"]);
    const [session] = ofType(after, "attempt.finished");
    assert.deepEqual([session?.actor, session?.data.attemptId, session?.data.outcome, session?.data.stoppedBy], [
      "orchestrator",
      cutAttempt?.type === "attempt.started" ? cutAttempt.data.attemptId : "",
      "aborted",
      "interrupted",
    ]);
    const charged = ofType(before, "attempt.charged").filter((e) => e.data.attemptId === session?.data.attemptId);
    assert.ok(Math.abs((session?.data.usd ?? -1) - sum(charged.map((e) => e.data.usd))) < 1e-12);
    assert.equal(session?.data.carry, undefined, "a session that was cut hands nothing on");

    // The prover goes on with session 3, from what session 1 handed on.
    const third = ofType(after, "attempt.started").at(-1);
    assert.equal(third?.data.iteration, 3);
    assert.match(prompts[0] ?? "", /This is session 3 of at most 3/);
    assert.match(prompts[0] ?? "", /# Your notes from the previous sessions\nNOTES: bad is not a lemma\./);
    assert.match(ofType(after, "task.status_changed").find((e) => e.data.from === "ready")?.data.reason ?? "", /resumes after the interruption, at session 3$/);
    assert.deepEqual(resumed.result.report.resumed, { times: 1, interrupted: { attempts: 1, toolRuns: 1, tasks: 1 }, tornTails: 0 });
    assertSound(resumed.events);
  });

  it("does not make up the sessions of a prover that the interruption cut short: a cut session is a session used", async () => {
    // One session left of two when the process ended: the session that was cut was the last one.
    const whole = await demoRun({ config: { sessions: 2 }, responses: script() });
    const cut = nth(whole.events, "tool_run.started", 3) + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: [] });
    assert.equal(resumed.faux.state.callCount, 0, "no model call was made");
    const [result] = resumed.result.problems;
    assert.equal(result?.outcome, "unsolved");
    assert.match(result?.reason ?? "", /provers stopped: 1 sessions/);
    assertSound(resumed.events);
  });

  it("resumes a run cut at every event of its journal to the same outcome, however it was cut", async () => {
    // Every session proves, so that whatever session the resumed prover starts is the one that does.
    const proving = () => Array.from({ length: 6 }, () => check("exact trivial_proof"));
    const whole = await demoRun({ config: { sessions: 3 }, responses: proving() });
    assert.equal(whole.result.problems[0]?.outcome, "candidate");
    const cuts = whole.events.length;
    for (let cut = 1; cut < cuts; cut++) {
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: proving() });
      const where = `cut after ${cut} of ${cuts} events (${whole.events[cut - 1]?.type})`;
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"], where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
      assert.equal(ofType(resumed.events, "task.created").length, 1, where);
      assert.equal(resumed.events.at(-1)?.type, "run.finished", where);
      assertSound(resumed.events);
    }
    // After run.finished there is nothing to resume.
    await assert.rejects(
      demoResume({ dir: killedAt(whole.dir, cuts), bench: whole.bench, responses: [] }),
      /the run is complete: every problem has an outcome and the run finished, so there is nothing to resume in /,
    );
  });

  it("resumes a run whose first session failed, cut at every event, to the same outcome", async () => {
    const proving = () => Array.from({ length: 6 }, () => check("exact trivial_proof"));
    const whole = await demoRun({ config: { sessions: 3 }, responses: script() });
    for (let cut = 1; cut < whole.events.length; cut++) {
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: proving() });
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"], where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
      assert.equal(ofType(resumed.events, "task.created").length, 1, where);
      // The session that proved is not asked for again once the journal has it.
      const proved = ofType(whole.events.slice(0, cut), "validation.finished").some((v) => v.data.verdict === "valid");
      if (proved) assert.equal(resumed.faux.state.callCount, 0, where);
      assertSound(resumed.events);
    }
  });
});

describe("resuming a larger run", () => {
  it("resumes a run of two problems, two provers each, with M1 and a certifier, cut at every event", async () => {
    // Every session proves, so that whichever prover has a session left is the one that proves.
    const proving = () => Array.from({ length: 12 }, () => check("exact trivial_proof"));
    const config = { provers: 2, sessions: 2, lines: ["M1"] };
    const whole = await demoRun({ problems: 2, config, responses: proving(), certifier: certifier().certifier });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["proved", "proved"]);
    for (let cut = 1; cut < whole.events.length; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const again = certifier();
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: proving(), certifier: again.certifier });
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["proved", "proved"], where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 2, where);
      assert.equal(ofType(resumed.events, "task.created").length, 4, where);
      // One kernel replay for each claim, whichever process made it.
      const replays = ofType(resumed.events, "validation.finished").filter((v) => v.data.method === "kernel_replay");
      assert.equal(new Set(replays.map((v) => v.data.claimId)).size, replays.length, `${where}: a claim was certified twice`);
      assert.equal(replays.length, 2, where);
      assertSound(resumed.events);
    }
  });
});

describe("resuming a run that was resumed", () => {
  const proving = () => Array.from({ length: 6 }, () => check("exact trivial_proof"));
  const script = (): FauxResponseStep[] => [check("bad"), say("NOTES: bad is not a lemma."), check("bad again"), say("NOTES: still not."), ...proving()];

  it("numbers the resumptions, and resumes a run again whatever event the second process ended at", async () => {
    const whole = await demoRun({ config: { sessions: 5 }, responses: script() });
    // The first process ended in the middle of session 2; the second one is resumed at every event of what it wrote.
    const firstDir = killedAt(whole.dir, nth(whole.events, "tool_run.started", 3) + 1);
    const first = await demoResume({ dir: firstDir, bench: whole.bench, responses: script().slice(2) });
    assert.equal(first.result.problems[0]?.outcome, "candidate");
    const start = first.events.findIndex((e) => e.type === "run.resumed");
    assert.ok(start > 0);
    for (let cut = start + 1; cut < first.events.length; cut++) {
      const where = `second cut after ${cut} of ${first.events.length} events (${first.events[cut - 1]?.type})`;
      const again = await demoResume({ dir: killedAt(firstDir, cut), bench: whole.bench, responses: proving() });
      assert.deepEqual(ofType(again.events, "run.resumed").map((e) => e.data.resumption), [1, 2], where);
      assert.deepEqual(again.result.problems.map((p) => p.outcome), ["candidate"], where);
      assert.equal(ofType(again.events, "problem.finished").length, 1, where);
      assert.equal(ofType(again.events, "task.created").length, 1, where);
      assert.equal(again.result.report.resumed?.times, 2, where);
      assertSound(again.events);
    }
  });
});

describe("the report of a run that was resumed", () => {
  it("says that a run which was resumed and cut again has not finished, and counts what each resumption found", async () => {
    const script = (): FauxResponseStep[] => [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")];
    const whole = await demoRun({ config: { sessions: 3 }, responses: script() });
    const firstDir = killedAt(whole.dir, nth(whole.events, "tool_run.started", 3) + 1, "fragment");
    const first = await demoResume({ dir: firstDir, bench: whole.bench, responses: script().slice(2) });
    assert.equal(buildReport(first.events).finished, true);
    // The second process ended right after it began: the run has not finished since.
    const cut = readEvents(join(killedAt(firstDir, first.events.findIndex((e) => e.type === "run.resumed") + 1), "journal.jsonl"));
    const report = buildReport(cut);
    assert.equal(report.finished, false);
    assert.deepEqual(report.resumed, { times: 1, interrupted: { attempts: 1, toolRuns: 1, tasks: 1 }, tornTails: 1 });
    assert.match(renderRunReport(report), /^The run has not finished\.$/m);
  });
});

describe("resuming a run that has a certifier", () => {
  const proving = () => Array.from({ length: 6 }, () => check("exact trivial_proof"));

  /** The claim's last status in a journal. */
  const statusOf = (events: readonly HarnessEvent[]): string | undefined => ofType(events, "claim.status_changed").at(-1)?.data.to;

  it("certifies a candidate once, whenever the process ended: a certification the journal holds is not made again, one it lacks is made", async () => {
    const first = certifier();
    const whole = await demoRun({ config: { sessions: 3 }, responses: proving(), certifier: first.certifier });
    assert.equal(whole.result.problems[0]?.outcome, "proved");
    assert.equal(first.requests.length, 1);
    const replays = (events: readonly HarnessEvent[]) => ofType(events, "validation.finished").filter((v) => v.data.method === "kernel_replay");
    assert.equal(replays(whole.events).length, 1);

    let certifiedBefore = 0;
    let certifiedAfter = 0;
    for (let cut = 1; cut < whole.events.length; cut++) {
      const again = certifier();
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: proving(), certifier: again.certifier });
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const settled = replays(whole.events.slice(0, cut)).length;
      // The certifier is asked once in all, by the process that finds it has not been.
      assert.equal(again.requests.length, settled > 0 ? 0 : 1, where);
      if (settled > 0) certifiedBefore++;
      else certifiedAfter++;
      assert.equal(replays(resumed.events).length, 1, `${where}: one kernel replay in all`);
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["proved"], where);
      assert.equal(statusOf(resumed.events), "proved", where);
      assert.equal(ofType(resumed.events, "claim.status_changed").filter((e) => e.data.to === "proved").length, 1, where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
      assertSound(resumed.events);
    }
    assert.ok(certifiedBefore > 0 && certifiedAfter > 0, "both sides of the certification were cut");
  });

  it("makes again a certification that was cut in the middle of its call, which the journal does not hold", async () => {
    const first = certifier();
    const whole = await demoRun({ config: { sessions: 3 }, responses: proving(), registry: certifyingRegistry(first.certifier) });
    assert.equal(whole.result.problems[0]?.outcome, "proved");
    // The process ended while the kernel replay ran: its tool run began, and nothing else came of it.
    const call = whole.events.findIndex((e) => e.type === "tool_run.started" && e.data.capability === "lean.certify");
    assert.ok(call > 0);
    const again = certifier();
    const resumed = await demoResume({ dir: killedAt(whole.dir, call + 1), bench: whole.bench, responses: [], registry: certifyingRegistry(again.certifier) });

    const after = resumed.events.slice(call + 1);
    assert.deepEqual(after[0]?.type === "run.resumed" ? after[0].data.interrupted : null, { attempts: 0, toolRuns: 1, tasks: 0 });
    const cut = ofType(after, "tool_run.finished")[0];
    assert.deepEqual([cut?.data.toolRunId, cut?.data.outcome, cut?.actor], [resumed.events[call]?.type === "tool_run.started" ? resumed.events[call].data.toolRunId : "", "aborted", "orchestrator"]);
    assert.equal(again.requests.length, 1, "the kernel replay is made, once");
    assert.equal(ofType(after, "tool_run.started").filter((e) => e.data.capability === "lean.certify").length, 1);
    assert.equal(resumed.faux.state.callCount, 0);
    assert.equal(ofType(resumed.events, "validation.finished").filter((v) => v.data.method === "kernel_replay").length, 1);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["proved"]);
    assert.equal(statusOf(resumed.events), "proved");
    assertSound(resumed.events);
  });

  it("settles a claim whose certification was recorded and whose status change was not", async () => {
    const first = certifier();
    const whole = await demoRun({ config: { sessions: 3 }, responses: proving(), certifier: first.certifier });
    // The process ended between the kernel replay's validation and the claim's change of status.
    const replay = whole.events.findIndex((e) => e.type === "validation.finished" && e.data.method === "kernel_replay");
    assert.equal(whole.events[replay + 1]?.type, "claim.status_changed");
    const again = certifier();
    const resumed = await demoResume({ dir: killedAt(whole.dir, replay + 1), bench: whole.bench, responses: [], certifier: again.certifier });
    assert.equal(again.requests.length, 0, "the kernel is not asked again");
    assert.equal(resumed.faux.state.callCount, 0);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["proved"]);
    assert.equal(statusOf(resumed.events), "proved");
    const change = ofType(resumed.events.slice(replay + 1), "claim.status_changed")[0];
    assert.deepEqual([change?.data.from, change?.data.to, change?.actor], ["computed", "proved", "orchestrator"]);
    assert.equal(change?.data.validationId, resumed.events[replay]?.type === "validation.finished" ? resumed.events[replay].data.validationId : "", "the change is the kernel replay's");
    assertSound(resumed.events);
  });
});

describe("resuming within the budget that is left", () => {
  /** Every session checks a proof that fails, then writes its notes. */
  const failing = (sessions: number): FauxResponseStep[] => Array.from({ length: sessions }, (_, k) => [check("bad"), say(`NOTES: ${k + 1}`)]).flat();
  // At 100 dollars per million tokens a check costs about 24 cents and a session's notes about 2.
  const PRICE = 100;

  it("spends no more on a problem than the budget that the journal says is left", async () => {
    const config = { sessions: 4, budget: { problemUsd: 0.6 } };
    const whole = await demoRun({ pricePerMillion: PRICE, config, responses: failing(4) });
    assert.equal(whole.result.problems[0]?.reason, "the problem's budget ran out");
    // The budget ran out in session 3, at its first check: five model calls in all.
    assert.equal(whole.faux.state.callCount, 5);

    const cut = nth(whole.events, "attempt.started", 3);
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, pricePerMillion: PRICE, responses: failing(4).slice(4) });
    assert.equal(resumed.faux.state.callCount, 1, "a fresh budget would have paid for three more");
    const [now] = resumed.result.problems;
    assert.deepEqual([now?.outcome, now?.reason, now?.attempts], ["unsolved", "the problem's budget ran out", 3]);
    assert.ok(Math.abs((now?.usd ?? 0) - (whole.result.problems[0]?.usd ?? 0)) < 1e-9, "the problem cost what it cost in the run that was not cut");
    assert.ok(Math.abs(resumed.result.usd - whole.result.usd) < 1e-9);
    assert.ok(Math.abs(spent(resumed.events).charged - spent(whole.events).charged) < 1e-9);
    assert.deepEqual(ofType(resumed.events, "attempt.finished").map((a) => a.data.outcome), ["invalid", "invalid", "budget_exhausted"]);
    assertSound(resumed.events);
  });

  it("spends no more on the run than the budget that the journal says is left, and stops where the run that was not cut stopped", async () => {
    const responses = (): FauxResponseStep[] => [check("exact trivial_proof"), ...failing(2)];
    const config = { sessions: 3, budget: { problemUsd: 5, runUsd: 0.55 } };
    const whole = await demoRun({ pricePerMillion: PRICE, problems: 2, config, responses: responses() });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["candidate", "unsolved"]);
    assert.equal(whole.result.stopped, "budget_exhausted");
    assert.equal(whole.faux.state.callCount, 4);

    // The second problem's first session had ended when the process did.
    const cut = nth(whole.events, "attempt.started", 3);
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, pricePerMillion: PRICE, responses: responses().slice(3) });
    assert.equal(resumed.faux.state.callCount, 1);
    assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.reason ?? null]), [
      ["candidate", null],
      ["unsolved", "the run's budget ran out"],
    ]);
    assert.equal(resumed.result.stopped, "budget_exhausted");
    assert.ok(Math.abs(resumed.result.usd - whole.result.usd) < 1e-9);
    assert.equal(ofType(resumed.events, "run.finished")[0]?.data.stopped, "budget_exhausted");
    assertSound(resumed.events);
  });

  it("does not give a problem more budget because the process that spent it ended before it noticed", async () => {
    const responses = (): FauxResponseStep[] => [check("exact trivial_proof"), ...failing(2)];
    const config = { sessions: 3, budget: { problemUsd: 5, runUsd: 0.55 } };
    const whole = await demoRun({ pricePerMillion: PRICE, problems: 2, config, responses: responses() });
    // The process ended right after the charge that used the run's budget up, before the session ended.
    const cut = nth(whole.events, "attempt.charged", 4) + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, pricePerMillion: PRICE, responses: [] });
    assert.equal(resumed.faux.state.callCount, 0, "not one more model call");
    assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.reason ?? null]), [
      ["candidate", null],
      ["unsolved", "the run's budget ran out"],
    ]);
    assert.equal(resumed.result.stopped, "budget_exhausted");
    assert.ok(Math.abs(resumed.result.usd - whole.result.usd) < 1e-9);
    assertSound(resumed.events);
  });

  it("does not begin the problems that the budget spent before the interruption leaves no room for", async () => {
    // The first model call of the first problem uses the run's budget up: the problem ends there.
    const config = { sessions: 3, budget: { problemUsd: 5, runUsd: 0.2 } };
    const whole = await demoRun({ pricePerMillion: PRICE, problems: 2, config, responses: [check("exact trivial_proof")] });
    assert.deepEqual(whole.result.problems.map((p) => [p.outcome, p.reason]), [["unsolved", "the run's budget ran out"]], "the second problem is never begun");
    assert.equal(whole.result.stopped, "budget_exhausted");
    // The process ended after the first problem's end and before the run's.
    const cut = nth(whole.events, "problem.finished", 1) + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, pricePerMillion: PRICE, responses: [] });
    assert.equal(resumed.faux.state.callCount, 0);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["unsolved"]);
    assert.equal(resumed.result.stopped, "budget_exhausted");
    assert.equal(ofType(resumed.events, "problem.registered").length, 1);
    assert.equal(resumed.events.at(-1)?.type, "run.finished");
    assertSound(resumed.events);
  });
});

describe("the time a cut session and tool run had run", () => {
  it("is the time from their start to the last event the killed process wrote, not zero", async () => {
    // Every check takes 40 ms, so the session that is cut has been running for at least that long.
    const whole = await demoRun({
      config: { sessions: 3 },
      lean: new DemoLean(demoAnswer, 40),
      responses: [check("bad"), say("NOTES"), check("exact trivial_proof")],
    });
    const cut = nth(whole.events, "attempt.finished", 1);
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, lean: new DemoLean(demoAnswer, 40), responses: [check("exact trivial_proof")] });
    const at = (seq: number) => Date.parse(whole.events.find((e) => e.seq === seq)?.ts ?? "");
    const lastWritten = Date.parse(whole.events[cut - 1]?.ts ?? "");
    const aborted = ofType(resumed.events, "attempt.finished").find((e) => e.data.stoppedBy === "interrupted");
    const started = ofType(whole.events, "attempt.started")[0];
    assert.ok(aborted !== undefined && started !== undefined);
    assert.equal(aborted.data.durationMs, lastWritten - at(started.seq));
    assert.ok(aborted.data.durationMs >= 40, `ran for at least one check (${aborted.data.durationMs} ms)`);
  });

  it("is, for a tool run, the time from its start to the last event the killed process wrote", async () => {
    // Two provers: the first one's check never ends until the second one's proof passes; every check takes 40 ms.
    const config = { provers: 2, sessions: 1 };
    const whole = await demoRun({ config, lean: new DemoLean(demoAnswer, 40), responses: [check("slow"), check("exact trivial_proof")] });
    const passed = whole.events.findIndex((e) => e.type === "validation.finished" && e.data.verdict === "valid");
    const stopped = whole.events.findIndex((e) => e.type === "tool_run.finished" && e.data.outcome === "aborted");
    assert.ok(passed >= 0 && stopped > passed, "the slow check is still running when the other prover's proof passes");
    const cut = passed + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, lean: new DemoLean(demoAnswer, 40), responses: [] });
    const at = (seq: number) => Date.parse(whole.events.find((e) => e.seq === seq)?.ts ?? "");
    const lastWritten = Date.parse(whole.events[cut - 1]?.ts ?? "");
    const closed = ofType(resumed.events, "tool_run.finished").filter((e) => e.data.outcome === "aborted" && e.seq > cut);
    assert.ok(closed.length > 0, "the resumption closed a tool run");
    for (const run of closed) {
      const begin = ofType(whole.events, "tool_run.started").find((e) => e.data.toolRunId === run.data.toolRunId);
      assert.ok(begin !== undefined);
      assert.equal(run.data.durationMs, lastWritten - at(begin.seq));
      assert.ok(run.data.durationMs >= 40, `it had been running for the other check's 40 ms (${run.data.durationMs})`);
    }
  });
});

describe("resuming a run whose journal ends in a cut line", () => {
  it("drops a fragment of an event and goes on, and says so in the journal and the report", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")] });
    // The process ended while it wrote the notes of session 1.
    const cut = whole.events.findIndex((e) => e.type === "lesson.recorded");
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut, "fragment"), bench: whole.bench, responses: [check("exact trivial_proof")] });
    const resumption = resumed.events.find((e) => e.type === "run.resumed");
    assert.ok(resumption?.type === "run.resumed");
    assert.equal(resumption.data.tornTail?.action, "dropped");
    assert.ok((resumption.data.tornTail?.bytes ?? 0) > 0);
    assert.match(resumption.data.tornTail?.sha256 ?? "", /^[0-9a-f]{64}$/);
    // The event that was cut is not in the journal; the session it belonged to is closed as cut.
    assert.equal(resumed.events[cut], resumption, "the next event after the whole ones is the resumption");
    assert.deepEqual(resumption.data.interrupted, { attempts: 1, toolRuns: 0, tasks: 1 });
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"]);
    assert.deepEqual(resumed.result.report.resumed, { times: 1, interrupted: { attempts: 1, toolRuns: 0, tasks: 1 }, tornTails: 1 });
    assert.match(renderRunReport(resumed.result.report), /, and the journal's last line was cut 1 time\(s\)\./);
    assertSound(resumed.events);
  });

  it("keeps an event that was written whole and lacked only its newline", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")] });
    const cut = whole.events.findIndex((e) => e.type === "lesson.recorded");
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut, "whole"), bench: whole.bench, responses: [check("exact trivial_proof")] });
    const resumption = resumed.events.find((e) => e.type === "run.resumed");
    assert.ok(resumption?.type === "run.resumed");
    assert.equal(resumption.data.tornTail?.action, "completed");
    assert.deepEqual(resumed.events[cut]?.type, "lesson.recorded", "the event is where the first process wrote it");
    assert.deepEqual(resumed.events[cut]?.hash, whole.events[cut]?.hash);
    assert.deepEqual(resumed.events[cut + 1], resumption);
    assert.equal(ofType(resumed.events, "lesson.recorded").length, 1, "session 2 proves and writes no notes");
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"]);
    assertSound(resumed.events);
  });

  it("resumes a run cut anywhere, with its last line cut, however the cut falls", async () => {
    const proving = () => Array.from({ length: 6 }, () => check("exact trivial_proof"));
    const first = certifier();
    const whole = await demoRun({ config: { sessions: 3 }, responses: proving(), certifier: first.certifier });
    const last = whole.events.length - 1;
    for (let cut = 1; cut <= last; cut++) {
      for (const torn of ["fragment", "whole"] as const) {
        const where = `cut at event ${cut} of ${whole.events.length} (${whole.events[cut]?.type}), ${torn}`;
        const again = certifier();
        const options = { dir: killedAt(whole.dir, cut, torn), bench: whole.bench, responses: proving(), certifier: again.certifier };
        if (torn === "whole" && cut === last) {
          // The run's last event is written whole: the run had finished.
          await assert.rejects(demoResume(options), /the run is complete/, where);
          continue;
        }
        const resumed = await demoResume(options);
        const resumption = resumed.events.find((e) => e.type === "run.resumed");
        assert.equal(resumption?.type === "run.resumed" ? resumption.data.tornTail?.action : "", torn === "fragment" ? "dropped" : "completed", where);
        assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["proved"], where);
        assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
        assert.equal(ofType(resumed.events, "validation.finished").filter((v) => v.data.method === "kernel_replay").length, 1, where);
        assertSound(resumed.events);
      }
    }
  });

  it("reads a journal with a cut last line without writing to it", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: [check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.finished", 1), "fragment");
    const before = readFileSync(join(dir, "journal.jsonl"));
    const recorded = readRecordedRun(dir);
    assert.equal(recorded.events.length, nth(whole.events, "attempt.finished", 1));
    assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), before);
  });
});

describe("resuming a run of several problems", () => {
  it("keeps the outcomes of the problems that ended, takes up the one that did not, and begins the ones that had not begun", async () => {
    const file = `${DEMO_FILE.replace("end Demo\n", "")}
/-- Zero is zero. -/
@[category research solved, AMS 11]
theorem zero_add' (n : ℕ) : 0 + n = n := by
  sorry

end Demo
`;
    const responses = (): FauxResponseStep[] => [
      check("exact trivial_proof"),
      check("bad"),
      say("NOTES: bad is not a lemma."),
      check("exact trivial_proof"),
      check("exact trivial_proof"),
    ];
    const whole = await demoRun({ file, problems: 3, config: { sessions: 3 }, responses: responses() });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["candidate", "candidate", "candidate"]);
    // The process ended after the second problem's first session: the first problem is over, the third not begun.
    const cut = nth(whole.events, "attempt.started", 3);
    const dir = killedAt(whole.dir, cut);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: responses().slice(3) });
    assert.deepEqual(resumed.result.problems.map((p) => [p.problemId, p.outcome]), whole.result.problems.map((p) => [p.problemId, p.outcome]));
    assert.equal(resumed.faux.state.callCount, 2, "the second problem's second session, and the third problem's first");
    assert.equal(ofType(resumed.events, "problem.finished").length, 3);
    assert.equal(ofType(resumed.events, "task.created").length, 3, "one prover task for each problem, none made twice");
    assert.equal(ofType(resumed.events, "problem.registered").length, 3);
    assert.deepEqual(ofType(resumed.events, "run.finished")[0]?.data.attempted, 3);
    assert.deepEqual(ofType(resumed.events, "run.finished")[0]?.data.candidates, 3);
    assert.ok(Math.abs(resumed.result.usd - whole.result.usd) < 1e-9);
    assertSound(resumed.events);
  });
});

/** M1, which keeps nothing in the process, with `seen` told where the hooks that run once per problem are called. */
function observing(seen: string[]): LineRegistry {
  return {
    ...LINES,
    M1: {
      ...M1,
      hooks: {
        ...M1.hooks,
        beforeProvers: async (problem) => { seen.push(`beforeProvers ${problem.target.theorem}`); },
        afterProver: async (_problem, end) => { seen.push(`afterProver ${end.prover} ${end.stop}`); },
        afterProblem: async (_problem, end) => { seen.push(`afterProblem ${end.outcome}`); },
      },
    },
  };
}

describe("resuming a run with lines", () => {
  const script = (prompts: string[] = []): FauxResponseStep[] => [
    check("bad"),
    say("NOTES: bad is not a lemma."),
    (context) => {
      prompts.push(sessionPromptOf(context));
      return check("exact trivial_proof");
    },
  ];

  it("gives a resumed session the briefing the first process would have given it, from the journal alone", async () => {
    const wholePrompts: string[] = [];
    const whole = await demoRun({ config: { sessions: 3, lines: ["M1"] }, responses: script(wholePrompts) });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["candidate"]);
    assert.match(wholePrompts[0] ?? "", /Already tried/, "M1 tells session 2 what session 1 tried");

    const resumedPrompts: string[] = [];
    const resumed = await demoResume({ dir: killedAt(whole.dir, nth(whole.events, "attempt.started", 2)), bench: whole.bench, responses: script(resumedPrompts).slice(2) });
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"]);
    assert.equal(resumedPrompts[0], wholePrompts[0], "the same prompt, the same briefing");
    assert.deepEqual(ofType(resumed.events, "claim.created").length, 1, "the problem's claim is the one it had");
    assertSound(resumed.events);
  });

  it("calls a line's hooks in the resumed process as the first process would have, except the one that came before the provers began", async () => {
    const wholeSeen: string[] = [];
    const whole = await demoRun({ lines: observing(wholeSeen), config: { sessions: 3, lines: ["M1"] }, responses: script() });
    assert.deepEqual(wholeSeen, ["beforeProvers Demo.add_zero'", "afterProver p1 solved", "afterProblem candidate"]);

    // The provers had begun: what beforeProvers did is in the journal, and it is not done twice.
    const seen: string[] = [];
    const resumed = await demoResume({
      dir: killedAt(whole.dir, nth(whole.events, "attempt.started", 2)),
      bench: whole.bench,
      lines: observing(seen),
      responses: script().slice(2),
    });
    assert.deepEqual(seen, ["afterProver p1 solved", "afterProblem candidate"]);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate"]);

    // The provers had not: beforeProvers is called, as the process that ended may not have finished it.
    const early: string[] = [];
    const first = nth(whole.events, "task.status_changed", 2);
    assert.match(whole.events[first]?.type === "task.status_changed" ? (whole.events[first].data.reason ?? "") : "", /^prover p1 starts$/);
    const again = await demoResume({ dir: killedAt(whole.dir, first), bench: whole.bench, lines: observing(early), responses: script() });
    assert.deepEqual(early, ["beforeProvers Demo.add_zero'", "afterProver p1 solved", "afterProblem candidate"]);
    assert.deepEqual(again.result.problems.map((p) => p.outcome), ["candidate"]);
    assertSound(again.events);
  });

  it("refuses to resume a run with a line that keeps state in the process, and writes nothing", async () => {
    const whole = await demoRun({ config: { sessions: 3, lines: ["M1"] }, responses: script() });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const journal = readFileSync(join(dir, "journal.jsonl"));
    const keeping: LineRegistry = { ...LINES, M1: { ...M1, resume: { refuse: "it keeps its truth-maintenance state in the process" } } };
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, lines: keeping, responses: [] }),
      /the run cannot be resumed: line M1 cannot be resumed: it keeps its truth-maintenance state in the process/,
    );
    const { resume: _resume, ...silent } = M1;
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, lines: { ...LINES, M1: silent }, responses: [] }),
      /the run cannot be resumed: line M1 cannot be resumed: it does not say how it resumes/,
    );
    assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), journal, "the journal is as it was");
    assert.equal(existsSync(join(dir, "journal.jsonl.lock")), false);
  });

  it("refuses to resume a run with a line other than the one it began with", async () => {
    const whole = await demoRun({ config: { sessions: 3, lines: ["M1"] }, responses: script() });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const journal = readFileSync(join(dir, "journal.jsonl"));
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, lines: { ...LINES, M1: { ...M1, version: "m1-99" } }, responses: [] }),
      /the run cannot be resumed with this code: the lines \(ids, versions or options\): the run recorded \[\{.*"version":"m1-2".*\}\], now \[\{.*"version":"m1-99".*\}\]/,
    );
    assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), journal);
  });
});

describe("refusing to resume a run that is not the one the process would run", () => {
  const proving = () => [check("exact trivial_proof")];
  const elsewhere = (lean: LeanChecker): RunOptions["registry"] => (journal, blobs) =>
    new Registry({
      catalog: loadCatalog(join(REPO_ROOT, "capabilities")),
      host: { host: "elsewhere", capabilities: { "lean.check": { use: ["kimina"] } } },
      factories: { kimina: () => leanCheckImplementation(lean) },
      journal,
      blobs,
    });

  /** A run cut in the middle, and its journal as it was. */
  async function cutRun(options: { certifier?: LeanCertifier } = {}) {
    const whole = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), say("NOTES"), check("exact trivial_proof")], ...options });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    return { whole, dir, journal: readFileSync(join(dir, "journal.jsonl")) };
  }

  /** The directory still holds the journal as it was, and nobody holds it. */
  function untouched(dir: string, journal: Buffer): void {
    assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), journal, "nothing was written");
    assert.equal(existsSync(join(dir, "journal.jsonl.lock")), false, "the journal was released");
  }

  it("refuses another host, another certifier and another bench, each with what differs", async () => {
    const { whole, dir, journal } = await cutRun();
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, registry: elsewhere, responses: [] }),
      /the run cannot be resumed here: the host: the run recorded test, now elsewhere; the capability registry \(catalog and host profile\): the run recorded "[0-9a-f]+", now "[0-9a-f]+"/,
    );
    untouched(dir, journal);

    await assert.rejects(
      demoResume({ dir, bench: whole.bench, certifier: certifier().certifier, responses: [] }),
      /the run cannot be resumed here: the certifier: the run recorded null, now "fake-certifier 0"/,
    );
    untouched(dir, journal);

    const other = demoBench(DEMO_FILE.replace("add_zero'", "add_zero2'"));
    await assert.rejects(demoResume({ dir, bench: other, responses: [] }), /the bench is not the one the run used \(it recorded [0-9a-f]+, this one is [0-9a-f]+\)/);
    untouched(dir, journal);
  });

  it("refuses a certifier where the run had none, and none where the run had one", async () => {
    const { whole, dir, journal } = await cutRun({ certifier: certifier().certifier });
    await assert.rejects(demoResume({ dir, bench: whole.bench, responses: [] }), /the certifier: the run recorded "fake-certifier 0", now null/);
    untouched(dir, journal);
  });

  it("leaves the journal's bytes as they were when it refuses, even if a crash cut its last line; a resume that goes on repairs it and says so", async () => {
    const sage = fakeSage();
    for (const kind of ["fragment", "whole"] as const) {
      const cutAt = async (config: Partial<RunOptions["config"]>, options: Partial<Parameters<typeof demoRun>[0]>) => {
        const whole = await demoRun({ config: { sessions: 3, ...config }, responses: [check("bad"), say("NOTES"), check("exact trivial_proof")], ...options });
        const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2), kind);
        const journal = readFileSync(join(dir, "journal.jsonl"));
        assert.notEqual(journal[journal.length - 1], 0x0a, `${kind}: the last line is cut`);
        return { whole, dir, journal };
      };
      const plain = await cutAt({}, { certifier: certifier().certifier });
      const refusals: [string, RegExp, Partial<Parameters<typeof demoResume>[0]>][] = [
        ["host and registry", /the host: the run recorded test, now elsewhere/, { registry: elsewhere, certifier: certifier().certifier }],
        ["certifier", /the certifier: the run recorded "fake-certifier 0", now null/, {}],
      ];
      for (const [what, message, options] of refusals) {
        await assert.rejects(demoResume({ dir: plain.dir, bench: plain.whole.bench, responses: [], ...options }), message, `${kind}: ${what}`);
        untouched(plain.dir, plain.journal);
      }
      const withSage = await cutAt({ tools: ["compute.sage"] }, { registry: sageRegistry(sage) });
      await assert.rejects(
        demoResume({ dir: withSage.dir, bench: withSage.whole.bench, responses: [] }),
        /the tools of the run: host test does not offer compute\.sage/,
        `${kind}: tools`,
      );
      untouched(withSage.dir, withSage.journal);

      // A resume that goes on repairs the tail as its first write and records what it did.
      const resumed = await demoResume({
        dir: plain.dir,
        bench: plain.whole.bench,
        certifier: certifier().certifier,
        responses: [check("exact trivial_proof")],
      });
      const resumption = ofType(resumed.events, "run.resumed")[0];
      assert.equal(resumption?.data.tornTail?.action, kind === "fragment" ? "dropped" : "completed", kind);
      assert.equal(verifyChain(readEvents(join(plain.dir, "journal.jsonl"))).ok, true, kind);
    }
  });

  it("refuses a directory that holds no run, a journal that is corrupt, and one that never began", async () => {
    const { whole, dir } = await cutRun();
    const empty = killedAt(whole.dir, 0);
    writeFileSync(join(empty, "journal.jsonl"), "");
    await assert.rejects(demoResume({ dir: empty, bench: whole.bench, responses: [] }), /has no run\.started: the run did not begin, and there is nothing to resume/);
    const cutFirst = killedAt(whole.dir, 0, "fragment");
    await assert.rejects(demoResume({ dir: cutFirst, bench: whole.bench, responses: [] }), /has no run\.started: the run did not begin/);

    const missing = killedAt(whole.dir, 3);
    writeFileSync(join(missing, "journal.jsonl"), "");
    await assert.rejects(demoResume({ dir: join(missing, "nowhere"), bench: whole.bench, responses: [] }), /nowhere holds no run: it has no journal\.jsonl/);

    // One byte of an event changed: the hash chain says where.
    const lines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n");
    lines[4] = (lines[4] ?? "").replace(/"ts":"(\d)/, (_m, d: string) => `"ts":"${(Number(d) + 1) % 10}`);
    writeFileSync(join(dir, "journal.jsonl"), lines.join("\n"));
    await assert.rejects(demoResume({ dir, bench: whole.bench, responses: [] }), /is corrupt at seq 4: hash does not match content/);
  });

  it("refuses a run that another process holds", async () => {
    const { whole, dir, journal } = await cutRun();
    // The parent of this process is alive, and is not this process.
    writeFileSync(join(dir, "journal.jsonl.lock"), String(process.ppid));
    await assert.rejects(demoResume({ dir, bench: whole.bench, responses: [] }), /the journal of .* cannot be opened: journal is locked by process \d+/);
    assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), journal);
    rmSync(join(dir, "journal.jsonl.lock"));
  });

  it("finds the problems of a run in config.json, or else from its selection, and refuses ones that are not those the journal hashed", async () => {
    const whole = await demoRun({ problems: 2, config: { sessions: 3 }, responses: [check("exact trivial_proof"), check("bad"), say("NOTES")] });
    const cut = nth(whole.events, "attempt.started", 2);

    // Without config.json: the selection {all: true} names both problems of the bench, which are the run's.
    const bare = killedAt(whole.dir, cut);
    rmSync(join(bare, "config.json"));
    const resumed = await demoResume({ dir: bare, bench: whole.bench, responses: [check("exact trivial_proof")] });
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["candidate", "candidate"]);

    // With config.json changed: the hash in the journal says so.
    const changed = killedAt(whole.dir, cut);
    const config = JSON.parse(readFileSync(join(changed, "config.json"), "utf8")) as { problems: string[] };
    writeFileSync(join(changed, "config.json"), JSON.stringify({ ...config, problems: config.problems.slice(0, 1) }));
    await assert.rejects(demoResume({ dir: changed, bench: whole.bench, responses: [] }), /the problems of the run are not the ones the journal recorded/);

    // A run of one problem of a bench of two, without config.json, cannot be recovered from `{all: true}`.
    const one = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), say("NOTES")] });
    const lost = killedAt(one.dir, nth(one.events, "attempt.finished", 1));
    rmSync(join(lost, "config.json"));
    await assert.rejects(demoResume({ dir: lost, bench: one.bench, responses: [] }), /the problems of the run are not the ones the journal recorded/);
  });
});

describe("resuming under other conditions", () => {
  const script = (): FauxResponseStep[] => [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")];

  it("leaves a problem it was stopped before it reached for a later resumption, and ends one it was stopped in as aborted", async () => {
    const whole = await demoRun({ config: { sessions: 3 }, responses: script() });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));

    // Stopped before the problem is taken up: nothing is taken up, and the problem has no outcome.
    const before = new AbortController();
    before.abort();
    const early = await demoResume({ dir, bench: whole.bench, signal: before.signal, responses: script().slice(2) });
    assert.equal(early.faux.state.callCount, 0);
    assert.deepEqual(early.result.problems, []);
    assert.equal(early.result.stopped, "aborted");
    assert.equal(ofType(early.events, "run.finished")[0]?.data.stopped, "aborted");
    assert.equal(ofType(early.events, "problem.finished").length, 0);

    // So the run is not complete, and a resumption without a stop finishes it.
    const later = await demoResume({ dir, bench: whole.bench, responses: script().slice(2) });
    assert.deepEqual(later.result.problems.map((p) => p.outcome), ["candidate"]);
    assert.deepEqual(ofType(later.events, "run.resumed").map((e) => e.data.resumption), [1, 2]);
    assertSound(later.events);

    // Stopped in the middle of the problem: it ends as aborted, as in a run that was not cut, and stays ended.
    const during = new AbortController();
    const stopped = await demoResume({
      dir: killedAt(whole.dir, nth(whole.events, "attempt.started", 2)),
      bench: whole.bench,
      signal: during.signal,
      responses: [() => { during.abort(); return check("exact trivial_proof"); }],
    });
    assert.deepEqual(stopped.result.problems.map((p) => [p.outcome, p.reason]), [["aborted", "the run was stopped"]]);
    assert.equal(stopped.result.stopped, "aborted");
    assertSound(stopped.events);
  });

  it("takes up several problems at the same time", async () => {
    const proving = () => Array.from({ length: 8 }, () => check("exact trivial_proof"));
    const logged: string[] = [];
    const whole = await demoRun({ problems: 2, config: { sessions: 3, concurrency: 2 }, responses: proving() });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["candidate", "candidate"]);
    // Both problems have a session open when the process ends.
    const cut = nth(whole.events, "attempt.started", 2) + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: proving(), log: (line) => logged.push(line) });
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome).sort(), ["candidate", "candidate"]);
    assert.equal(logged.filter((line) => /taking it up again after the interruption/.test(line)).length, 2);
    assert.equal(ofType(resumed.events, "problem.finished").length, 2);
    assert.equal(ofType(resumed.events, "task.created").length, 2);
    assertSound(resumed.events);
  });
});
