import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BenchIndex } from "@seshat/bench";
import { join } from "node:path";
import { BlobStore, type HarnessEvent } from "@seshat/core";
import { buildReport, renderRunReport } from "../src/index.ts";
import { assertSound, certifier } from "./resume-helpers.ts";
import { createM12Line } from "@seshat/scheduler";
import type { Line } from "@seshat/lines";
import { m12Answer } from "./m12-helpers.ts";
import { check, DemoLean, demoBench, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";

const gates = (events: readonly HarnessEvent[]) => ofType(events, "budget.gated").map((e) => e.data);
const summary = (events: readonly HarnessEvent[]) => gates(events).map((g) => `${g.site}:${g.action}:${g.by}`);

/** The wide shape the gate replaces as a starting shape: three provers of three sessions. */
const WIDE = { provers: 3, sessions: 3, seed: "gate-tests", budget: { problemUsd: 1 } };

describe("the budget gate: probe first", () => {
  it("starts a problem with one prover and one session, and stops there without Lean progress", async () => {
    // `bad` is an unknown identifier: the check typed nothing, so Lean made no progress.
    const { events, result } = await demoRun({ responses: [check("bad"), say("notes")], config: { ...WIDE, gate: { floor: 0 } } });
    assert.deepEqual(summary(events), ["wave:probe:probe", "wave:skip:progress"]);
    assert.equal(ofType(events, "attempt.started").length, 1, "one prover, one session");
    const [probe, skip] = gates(events);
    assert.equal(probe?.share, 0.1);
    assert.equal(skip?.progress, false);
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.match(result.problems[0]?.reason ?? "", /1 gate/);
    // The tasks of the provers that never ran are cancelled, the probe's failed, and nothing is left running.
    assert.deepEqual(new Set(ofType(events, "task.status_changed").map((e) => e.data.to)).has("running"), true);
    assert.equal(ofType(events, "task.status_changed").filter((e) => e.data.to === "cancelled").length, 2);
  });

  it("caps the probe at a tenth of the budget: the session that reaches the cap pauses, it does not end the problem", async () => {
    // A session costs a few cents at this price; the problem's budget is one dollar and the cap ten cents.
    const { events, result } = await demoRun({
      responses: [check("sorry"), say("notes")],
      pricePerMillion: 60,
      config: { ...WIDE, provers: 2, sessions: 2, budget: { problemUsd: 1 }, gate: { floor: 0 } },
    });
    const probeAttempt = ofType(events, "attempt.finished")[0]?.data;
    assert.equal(probeAttempt?.outcome, "budget_exhausted", "the probe's own ledger ran out");
    assert.ok((probeAttempt?.usd ?? 0) >= 0.1, `the probe spent ${String(probeAttempt?.usd)}`);
    assert.ok((probeAttempt?.usd ?? 0) < 1, "and the problem's budget did not");
    assert.equal(summary(events)[0], "wave:probe:probe");
    // The cap is not the problem's budget: the gate went on to decide about the widening.
    assert.equal(gates(events)[1]?.site, "wave");
    assert.notEqual(result.problems[0]?.reason ?? "", "the problem's budget ran out");
  });

  it("widens after Lean progress, by the rule, and then the other provers start", async () => {
    // `sorry` leaves a hole with a goal: the sketch compiles, which is progress. Then a prover finds the proof.
    const { events } = await demoRun({
      responses: [check("sorry"), say("notes"), check("exact trivial_proof"), check("exact trivial_proof"), check("exact trivial_proof")],
      config: { ...WIDE, provers: 2, sessions: 2, gate: { floor: 0, share: { wave: 1, session: 1 } } },
    });
    const kinds = summary(events);
    assert.deepEqual(kinds.slice(0, 2), ["wave:probe:probe", "wave:widen:rule"]);
    const widen = gates(events)[1];
    assert.equal(widen?.progress, true);
    assert.ok((widen?.pSuccess ?? -1) >= 0 && (widen?.pSuccess ?? 2) <= 1);
    assert.ok(Math.abs((widen?.thresholdUsd ?? -1) - (widen?.share ?? 0) * (widen?.remainingUsd ?? 0) * (widen?.pSuccess ?? 0)) < 1e-9);
    assert.match(widen?.reason ?? "", /Lean progress: .*holes/);
    const prover = (name: string) => ofType(events, "attempt.started").filter((e) => e.data.prover === name).length;
    assert.ok(prover("p1") >= 1 && prover("p2") >= 1, "both provers worked after the widening");
    assert.ok(ofType(events, "validation.finished").some((e) => e.data.verdict === "valid"));
    // The first attempt is the probe's and comes before the widening.
    const order = events.map((e) => e.type === "budget.gated" ? `g:${e.data.action}` : e.type === "attempt.started" ? "a" : "");
    assert.ok(order.indexOf("g:probe") < order.indexOf("a") && order.indexOf("a") < order.indexOf("g:widen"));
  });

  it("is the same for the same seed: the answers, with their numbers, repeat", async () => {
    const run = () => demoRun({ responses: [check("sorry"), say("notes"), check("exact trivial_proof"), check("exact trivial_proof")], config: { ...WIDE, provers: 2, sessions: 2, gate: { floor: 0.5 } } });
    const a = gates((await run()).events).map(({ reason, ...numbers }) => numbers);
    const b = gates((await run()).events).map(({ reason, ...numbers }) => numbers);
    assert.deepEqual(a, b);
  });
});

describe("the budget gate: before a session", () => {
  const widened = { ...WIDE, provers: 1, sessions: 3 };

  it("skips a session whose price is over the share of what is left times the chance, and records the numbers", async () => {
    const { events, result } = await demoRun({
      responses: [check("sorry"), say("notes")],
      config: { ...widened, gate: { floor: 0, share: { wave: 1, session: 0.0001 } } },
    });
    const [probe, widen, session] = gates(events);
    assert.equal(probe?.action, "probe");
    assert.equal(widen?.action, "widen");
    assert.equal(session?.site, "session");
    assert.equal(session?.action, "skip");
    assert.equal(session?.by, "rule");
    assert.equal(session?.session, 2);
    assert.ok((session?.estimateUsd ?? 0) > (session?.thresholdUsd ?? 1));
    assert.equal(ofType(events, "attempt.started").length, 1, "the second session was not launched");
    assert.match(result.problems[0]?.reason ?? "", /1 gate/);
  });

  it("lets the exploration floor launch the sessions the rule skips, and says so", async () => {
    const { events } = await demoRun({
      responses: [check("sorry"), say("notes"), check("exact trivial_proof")],
      config: { ...widened, gate: { floor: 1, share: { wave: 1, session: 0.0001 } } },
    });
    const session = gates(events).find((g) => g.site === "session");
    assert.equal(session?.action, "launch");
    assert.equal(session?.by, "floor");
    assert.equal(session?.exploration, true);
    assert.equal(ofType(events, "attempt.started").length, 2);
  });

  it("is off without the option: no answer, no probe, the provers start together as before", async () => {
    const { events } = await demoRun({ responses: [check("bad"), say("n"), check("bad"), say("n")], config: { provers: 2, sessions: 1 } });
    assert.deepEqual(gates(events), []);
    assert.equal(ofType(events, "attempt.started").length, 2);
  });
});

/** The demo bench as a checkout of the revision and toolchain given, so that its environment can be compared. */
function benchIn(source: Partial<BenchIndex["source"]>, shared = demoBench()): { checkout: string; index: BenchIndex } {
  return { checkout: shared.checkout, index: { ...shared.index, source: { ...shared.index.source, ...source } } };
}
const ENV_A = { rev: "rev-a", lean: "leanprover/lean4:v4.20.0" };
const ENV_B = { rev: "rev-b", lean: "leanprover/lean4:v4.20.0" };

describe("the budget gate: a run on earlier memory", () => {
  it("relaunches nothing already certified under the same environment, and spends no model call on it", async () => {
    const shared = demoBench();
    const a = await demoRun({ bench: benchIn(ENV_A, shared), certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    assert.equal(a.result.problems[0]?.outcome, "proved");
    const bench = benchIn(ENV_A, shared);
    const b = await demoRun({ bench, memoryFrom: a.dir, responses: [], config: { sessions: 2, gate: {} } });
    assert.equal(b.faux.state.callCount, 0, "no model was called");
    assert.equal(ofType(b.events, "attempt.started").length, 0, "no session was launched");
    assert.equal(ofType(b.events, "tool_run.started").filter((e) => e.data.capability === "lean.check").length <= 1, true, "at most the reference check of the file");
    assert.deepEqual(summary(b.events), ["wave:skip:memory"]);
    assert.equal(b.result.problems[0]?.outcome, "skipped");
    assert.match(b.result.problems[0]?.reason ?? "", /already proved in the memory this run started on, under the same Lean environment/);
    assert.equal(b.result.usd, 0);
    // The skip credits nothing to this run: the problem is not counted as solved.
    assert.equal(ofType(b.events, "run.finished")[0]?.data.solved, 0);
  });

  it("launches again under another environment, where the earlier status counts for nothing", async () => {
    const shared = demoBench();
    const a = await demoRun({ bench: benchIn(ENV_A, shared), certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    const b = await demoRun({ bench: benchIn(ENV_B, shared), memoryFrom: a.dir, responses: [check("bad"), say("notes")], config: { sessions: 1, gate: { floor: 0 } } });
    assert.deepEqual(summary(b.events).slice(0, 1), ["wave:probe:probe"]);
    assert.equal(ofType(b.events, "attempt.started").length, 1);
  });

  it("without the gate a run on earlier memory still works the problem again, as it always did", async () => {
    const shared = demoBench();
    const a = await demoRun({ bench: benchIn(ENV_A, shared), certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    const b = await demoRun({ bench: benchIn(ENV_A, shared), memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 } });
    assert.equal(ofType(b.events, "attempt.started").length, 1);
    assert.deepEqual(gates(b.events), []);
  });

  it("prices what the failure memory holds: the earlier runs' failures, discounted, lower the chance the gate draws from", async () => {
    const shared = demoBench();
    // Six sessions that failed in the earlier run: soft evidence, not a door closed for good.
    const a = await demoRun({ bench: benchIn(ENV_A, shared), responses: Array.from({ length: 6 }, () => [check("bad"), say("notes")]).flat(), config: { provers: 1, sessions: 6 } });
    const b = await demoRun({
      bench: benchIn(ENV_A, shared),
      memoryFrom: a.dir,
      responses: [check("sorry"), say("notes"), check("bad"), say("notes")],
      config: { provers: 1, sessions: 2, seed: "memory", gate: { floor: 0, share: { wave: 1, session: 1 } } },
    });
    const widen = gates(b.events).find((g) => g.action === "widen");
    assert.match(widen?.reason ?? "", /posterior Beta\(1\.00, 6\.80\) from 7 attempts/, "6 failures at 0.8, and the probe's");
    // A claim with no earlier run has only the probe behind it.
    const c = await demoRun({ bench: benchIn(ENV_A, demoBench()), responses: [check("sorry"), say("notes"), check("bad"), say("notes")], config: { provers: 1, sessions: 2, seed: "memory", gate: { floor: 0, share: { wave: 1, session: 1 } } } });
    assert.match(gates(c.events).find((g) => g.action === "widen")?.reason ?? "", /posterior Beta\(1\.00, 2\.00\) from 1 attempts/);
  });
});

describe("the budget gate: where the rule has no numbers", () => {
  it("asks decide at budget.wave with a state of counts and dollars, and journals the answer with the gate's", async () => {
    // The probe says nothing (no check): no attempt counts, so the posterior is the flat prior and the floor (1) widens anyway.
    const { events, dir } = await demoRun({
      responses: [say("I do not know where to start."), say("notes"), say(JSON.stringify({ verdict: "launch", reason: "cheap" })), check("exact trivial_proof")],
      config: { provers: 1, sessions: 3, seed: "cold", budget: { problemUsd: 1 }, gate: { floor: 1 } },
    });
    const answers = gates(events);
    assert.deepEqual(answers.map((g) => `${g.site}:${g.action}:${g.by}`).slice(0, 3), ["wave:probe:probe", "wave:widen:floor", "session:launch:decide"]);
    const cold = answers[2];
    const decision = ofType(events, "decision.made")[0]?.data;
    assert.equal(decision?.site, "budget.wave");
    assert.equal(decision?.answer, "launch");
    assert.equal(cold?.decisionId, decision?.decisionId);
    assert.match(cold?.reason ?? "", /no posterior: budget\.wave answered launch \(llm\)/);
    // The state holds counts and dollars, and nothing of the mathematics: no statement, no goal, no name of the problem or its claim.
    const call = ofType(events, "model_call.finished").find((e) => e.data.site === "budget.wave");
    assert.ok(call !== undefined, "the question was a charged call of the budget.wave site");
    const request = JSON.parse(new BlobStore(join(dir, "blobs")).get(call.data.requestHash) ?? "{}") as { prompt: string };
    const state = request.prompt.split("\n\nQuestion:")[0]?.replace(/^State:\n/, "") ?? "";
    assert.match(
      state,
      /^site session\nwhy no posterior yet\nattempts counted 0\nsessions paid 1\nestimate \d+\.\d{4} dollars\nremaining \d+\.\d{4} of 1\.0000 dollars\nrung 0$/,
      state,
    );
    assert.doesNotMatch(request.prompt, /add_zero|theorem|Demo|n \+ 0|prb_|clm_|p1/);
    assert.equal(call.data.line, "gate", "booked to the gate, not to a line");
  });
});

describe("the report", () => {
  it("shows the avoided spend by site as the gate's estimate, from the journal alone", async () => {
    const { events, result } = await demoRun({
      responses: [check("sorry"), say("notes")],
      config: { provers: 1, sessions: 3, seed: "report", budget: { problemUsd: 1 }, gate: { floor: 0, share: { wave: 1, session: 0.0001 } } },
    });
    const skipped = gates(events).filter((g) => g.action === "skip");
    assert.equal(skipped.length, 1);
    const g = result.report.gate;
    assert.equal(g?.answers, 3);
    assert.deepEqual([g?.probes, g?.widened, g?.stoppedAtProbe, g?.certifiedEarlier], [1, 1, 0, 0]);
    const session = g?.bySite.find((s) => s.site === "session");
    assert.deepEqual([session?.launched, session?.skipped], [0, 1]);
    assert.equal(session?.avoidedUsd, skipped[0]?.estimateUsd);
    assert.equal(g?.avoidedUsd, skipped[0]?.estimateUsd);
    const text = renderRunReport(result.report);
    assert.match(text, /Budget gate: 3 answer\(s\)\. Probe first: 1 problem\(s\) probed, 1 widened/);
    assert.match(text, /Avoided spend: \$\d+\.\d\d, the gate's estimate of what the skipped launches would have cost \(an estimate/);
    assert.match(text, /\| Site \| Launched \| Skipped \| Let through by the floor \| Decided by decide \| Avoided \(estimate\) \|/);
    assert.match(text, /\| session \| 0 \| 1 \| 0 \(\$0\.00\) \| 0 \| \$\d+\.\d\d \|/);
    // Rebuilt from the journal alone, a run's report says the same.
    assert.deepEqual(buildReport(events).gate, g);
  });

  it("has no gate section for a run without a gate, and counts what the memory had certified", async () => {
    const plain = await demoRun({ responses: [check("bad"), say("n")], config: { sessions: 1 } });
    assert.equal(plain.result.report.gate, undefined);
    assert.doesNotMatch(renderRunReport(plain.result.report), /Budget gate/);
    const shared = demoBench();
    const a = await demoRun({ bench: benchIn(ENV_A, shared), certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    const b = await demoRun({ bench: benchIn(ENV_A, shared), memoryFrom: a.dir, responses: [], config: { gate: {} } });
    assert.equal(b.result.report.gate?.certifiedEarlier, 1);
    assert.match(renderRunReport(b.result.report), /1 not launched because the memory had certified them under the same environment/);
  });
});

describe("the budget gate across an interruption", () => {
  const config = { provers: 2, sessions: 2, seed: "resume", budget: { problemUsd: 1 }, gate: { floor: 0, share: { wave: 1, session: 1 } } };
  const script = () => [check("sorry"), say("notes"), check("exact trivial_proof"), check("exact trivial_proof"), say("notes")];

  it("does not probe a second time when the process ended after the probe, and goes on to the widening it had not decided", async () => {
    const whole = await demoRun({ config, responses: script() });
    assert.deepEqual(summary(whole.events).slice(0, 2), ["wave:probe:probe", "wave:widen:rule"]);
    // Cut just before the widening is written: the probe is over, the decision about it is not.
    const cut = whole.events.findIndex((e) => e.type === "budget.gated" && e.data.action === "widen");
    const dir = killedAt(whole.dir, cut);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: script().slice(2) });
    const kinds = ofType(resumed.events, "budget.gated").map((e) => `${e.data.site}:${e.data.action}:${e.data.by}`);
    assert.equal(kinds.filter((k) => k === "wave:probe:probe").length, 1, "one probe in the journal");
    assert.equal(kinds.filter((k) => k.startsWith("wave:widen")).length, 1, "decided once, after the interruption");
    assert.equal(ofType(resumed.events, "attempt.started").filter((e) => e.data.iteration === 1 && e.data.prover === "p1").length, 1, "the probe's session was not run again");
    assert.equal(resumed.result.problems[0]?.outcome, whole.result.problems[0]?.outcome);
    assertSound(resumed.events);
  });

  it("does not widen again when the process ended after the widening", async () => {
    const whole = await demoRun({ config, responses: script() });
    const cut = whole.events.findIndex((e, i) => i > 0 && whole.events[i - 1]?.type === "budget.gated" && (whole.events[i - 1] as { data: { action: string } }).data.action === "widen");
    const dir = killedAt(whole.dir, cut);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: script().slice(2) });
    const kinds = ofType(resumed.events, "budget.gated").map((e) => e.data.action);
    assert.equal(kinds.filter((k) => k === "widen").length, 1);
    assert.equal(kinds.filter((k) => k === "probe").length, 1);
    assertSound(resumed.events);
  });
});

describe("the budget gate and a line's task", () => {
  /** A line that proposes one task, asks the gate about a judge call of its own, and works its task itself. */
  function worker(seen: string[]): Line {
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
          const asked = await problem.budget.ask?.({ site: "judge", estimateUsd: 0.01, pSuccess: 0.5 });
          seen.push(`ask:${asked === undefined ? "none" : `${asked.action}/${asked.by}`}`);
          problem.tasks.propose({ kind: "prove", acceptance: { type: "claim", claimId: problem.claimId, minStatus: "computed" }, budget: { sessions: 1 }, title: "its own work" });
        },
        runTask: async () => {
          seen.push("worked");
          return { ended: "failed", reason: "no luck" };
        },
      },
    };
  }
  const base = { lines: ["M12", "M14"], provers: 1, sessions: 2, seed: "task", budget: { problemUsd: 1 } };

  it("skips a task whose price is over its share, cancels it with the reason, and journals the numbers", { timeout: 30000 }, async () => {
    const seen: string[] = [];
    const { events } = await demoRun({
      lines: { M12: createM12Line(), M14: worker(seen) },
      config: { ...base, gate: { floor: 0, share: { task: 0.0001 } } },
      lean: new DemoLean(m12Answer),
      responses: [check("sorry"), say("notes"), say("notes"), say("notes")],
    });
    assert.deepEqual(seen, ["ask:launch/rule"], "the line's judge question was answered (0.01 against 0.1 x 1 x 0.5), and its task was never worked");
    const task = ofType(events, "task.created").find((e) => e.data.proposedBy === "line:M14");
    const skip = gates(events).find((g) => g.site === "task");
    assert.equal(skip?.action, "skip");
    assert.equal(skip?.taskId, task?.data.taskId);
    assert.ok((skip?.estimateUsd ?? 0) > (skip?.thresholdUsd ?? 1));
    const moves = ofType(events, "task.status_changed").filter((e) => e.data.taskId === task?.data.taskId);
    assert.equal(moves.at(-1)?.data.to, "cancelled");
    assert.match(moves.at(-1)?.data.reason ?? "", /^the budget gate skipped it: /);
    assert.ok(gates(events).some((g) => g.site === "judge" && g.action === "launch"));
  });

  it("works the task when the gate lets it through, and a line without a gate has no ask", { timeout: 30000 }, async () => {
    const seen: string[] = [];
    await demoRun({
      lines: { M12: createM12Line(), M14: worker(seen) },
      config: { ...base, gate: { floor: 0, share: { task: 1 } } },
      lean: new DemoLean(m12Answer),
      responses: [check("sorry"), say("notes"), say("notes"), say("notes")],
    });
    assert.deepEqual(seen, ["ask:launch/rule", "worked"]);
    const plain: string[] = [];
    await demoRun({ lines: { M12: createM12Line(), M14: worker(plain) }, config: base, lean: new DemoLean(m12Answer), responses: [check("bad"), say("notes"), say("notes")] });
    assert.deepEqual(plain, ["ask:none", "worked"]);
  });
});
