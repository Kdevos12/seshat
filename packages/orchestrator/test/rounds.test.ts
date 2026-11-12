import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { markProgress, NO_MARK, recordedRounds, roundCap } from "../src/rounds.ts";
import { check, DEMO_FILE, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";

const THREE = DEMO_FILE.replace("end Demo", `/-- Zero is a left identity. -/
@[category research solved, AMS 11]
theorem zero_add' (n : ℕ) : 0 + n = n := by
  sorry

end Demo`);
/** Set against the prover prompt's length (m0-2.2): a longer prompt costs more per call. */
const PRICE = 90;
/** One failing session of one check and its notes: about $0.26 at this price. */
const fail = (n: number): FauxResponseStep[] => [check(`bad ${n}`), say("notes")];

describe("the arithmetic of the rounds", () => {
  it("gives round r a problem at most runUsd / (4K) * 2^r in all", () => {
    assert.deepEqual([0, 1, 2, 3].map((r) => roundCap(12, 3, r)), [1, 2, 4, 8]);
    assert.equal(roundCap(2, 1, 0), 0.5);
  });

  it("reads Lean progress as the ladder does, and a check that typed every step as the gate's probe does", () => {
    assert.equal(markProgress(undefined, { ...NO_MARK }), undefined);
    assert.match(markProgress(undefined, { proved: 1, holes: null, depth: 2 }) ?? "", /1 more subclaim/);
    assert.match(markProgress({ proved: 0, holes: 3, depth: 2 }, { proved: 0, holes: 2, depth: 2 }) ?? "", /2 open hole/);
    assert.match(markProgress({ proved: 0, holes: null, depth: 2 }, { proved: 0, holes: null, depth: 6 }) ?? "", /got further/);
    assert.equal(markProgress({ proved: 0, holes: null, depth: 2 }, { proved: 0, holes: null, depth: 4 }), undefined);
    assert.equal(markProgress({ proved: 0, holes: null, depth: 6 }, { proved: 0, holes: null, depth: 6 }), undefined);
  });
});

describe("a run's budget in rounds (CA8)", () => {
  const config = { sessions: 20, budget: { problemUsd: 5, runUsd: 3 } };

  it("without the option the first problem takes the whole budget", async () => {
    const responses = Array.from({ length: 20 }, (_, k) => fail(k)).flat();
    const { result, events } = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config, responses });
    assert.equal(result.stopped, "budget_exhausted");
    assert.equal(result.problems.length, 1, "the other two are never begun");
    assert.ok((result.problems[0]?.usd ?? 0) >= 2.9);
    assert.equal(ofType(events, "budget.round").length, 0);
  });

  it("gives each problem a slice, parks the ones without Lean progress, takes them up again, and solves what the first would have starved", async () => {
    const win = check("exact trivial_proof");
    const { result, events } = await demoRun({
      pricePerMillion: PRICE,
      problems: 3,
      file: THREE,
      config: { ...config, budgetRounds: true },
      responses: [
        // round 0 (cap $0.25): the first and the second fail with nothing to show, the third is solved
        ...fail(1), ...fail(2), win,
        // round 1 (cap $0.50, the parked ones taken up again): the first gets as far as holes, the second is solved
        check("sorry"), win,
        // round 2 (cap $1): the first is solved
        win,
      ],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["candidate", "candidate", "candidate"]);
    const rounds = ofType(events, "budget.round").map((e) => e.data);
    assert.deepEqual(rounds.map((r) => [r.round, r.capUsd, r.problems.length]), [[0, 0.25, 3], [1, 0.5, 2], [2, 1, 1]]);
    assert.equal(rounds[0]?.marks, undefined, "round 0 begins from nothing");
    assert.equal(rounds[1]?.resumed?.length, 2, "round 1 takes up the two parked problems");
    assert.ok(rounds[1]?.marks !== undefined && rounds[2]?.marks !== undefined);
    const parked = ofType(events, "problem.parked").map((e) => [e.data.round, e.data.problemId]);
    const ids = rounds[0]?.problems ?? [];
    assert.deepEqual(parked, [[0, ids[0]], [0, ids[1]]], "the first two had no Lean progress in round 0; the first had some in round 1");
    assert.match(ofType(events, "problem.parked")[0]?.data.reason ?? "", /no Lean progress in round 0/);
    const first = result.problems.find((p) => p.problemId === ids[0]);
    assert.ok((first?.usd ?? 99) < 0.92 * 3, "no problem took 92% of the budget");
    assert.ok(result.usd <= 3 + 1e-9);
    // A session the slice cut is no failure: no failure class, nothing for the router; its last check's class is kept apart for the rotation.
    const cut = ofType(events, "attempt.finished").filter((e) => e.data.outcome === "budget_exhausted");
    assert.ok(cut.length > 0, "a slice cut a session");
    assert.deepEqual(cut.map((e) => e.data.failureClass), cut.map(() => undefined));
    assert.ok(cut.some((e) => e.data.lastCheckClass === "holes"), "the cut check that typed the sketch is kept as lastCheckClass");
    const routed = ofType(events, "task.routed").map((e) => e.data.attemptId).filter((id) => cut.some((c) => c.data.attemptId === id));
    assert.deepEqual(routed, [], "the router saw no failure in a budget cut");
    // Every slice respects its round's cap: nobody had spent more than the cap of its round plus the response that crossed it.
    for (const p of result.problems) assert.ok(p.usd <= 1.5, `${p.problemId} stayed within its rounds`);
  });

  it("changes nothing with one problem, and warns once when the problem allowance is above its fair share", async () => {
    const lines: string[] = [];
    const { events } = await demoRun({
      pricePerMillion: PRICE,
      problems: 1,
      config: { sessions: 2, budget: { problemUsd: 5, runUsd: 3 }, budgetRounds: true },
      responses: [check("exact trivial_proof")],
      log: (line) => lines.push(line),
    });
    assert.equal(ofType(events, "budget.round").length, 0);
    assert.equal(lines.filter((l) => /fair share/.test(l)).length, 1);
  });

  it("runs two slices at a time with concurrency 2, within the caps, and ends where concurrency 1 does", async () => {
    // Every response fails the same way, so the order the two workers draw them in does not matter.
    const responses = Array.from({ length: 60 }, (_, k) => check(`bad ${k}`));
    const cfg = { sessions: 20, budget: { problemUsd: 5, runUsd: 3 }, budgetRounds: true };
    const one = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: { ...cfg, concurrency: 1 }, responses });
    const two = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: { ...cfg, concurrency: 2 }, responses });
    let open = 0;
    let most = 0;
    for (const e of two.events) {
      if (e.type === "attempt.started") most = Math.max(most, ++open);
      if (e.type === "attempt.finished") open--;
    }
    assert.ok(most >= 1 && most <= 2, `at most two slices at once, saw ${most}`);
    const shape = (events: typeof one.events) => ofType(events, "budget.round").map((e) => [e.data.round, e.data.capUsd, [...e.data.problems].sort()]);
    assert.deepEqual(shape(two.events), shape(one.events), "the same rounds and caps");
    assert.deepEqual(two.result.problems.map((p) => p.outcome).sort(), one.result.problems.map((p) => p.outcome).sort());
    assert.equal(two.result.stopped, one.result.stopped);
    // The response that crosses a cap is paid for, as with concurrency 1.
    assert.ok(two.result.usd <= 3.05 && Math.abs(two.result.usd - one.result.usd) < 0.05, "the run cap holds, as with concurrency 1");
    const caps = ofType(two.events, "budget.round").map((e) => e.data.capUsd);
    for (const p of two.result.problems) assert.ok(p.usd <= (caps.at(-1) ?? 0) * 3 + 0.6, `${p.problemId} within its rounds`);
  });

  it("reads the rotation back from the journal", async () => {
    const { events } = await demoRun({
      pricePerMillion: PRICE, problems: 3, file: THREE, config: { ...config, budgetRounds: true },
      responses: [...fail(1), ...fail(2), check("exact trivial_proof"), check("exact trivial_proof"), check("exact trivial_proof")],
    });
    const recorded = recordedRounds(events);
    assert.equal(recorded?.round, 1);
    assert.equal(recorded?.parked.length, 0, "the parked problems were taken up again");
  });

  it("continues the same rotation after an interruption at every round boundary", async () => {
    const win = check("exact trivial_proof");
    const script = (): FauxResponseStep[] => [...fail(1), ...fail(2), win, check("sorry"), win, win];
    const cfg = { ...config, budgetRounds: true };
    const whole = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: cfg, responses: script() });
    const shape = (events: typeof whole.events) => ({
      rounds: ofType(events, "budget.round").map((e) => [e.data.round, e.data.capUsd, e.data.problems, e.data.resumed ?? []]),
      parked: ofType(events, "problem.parked").map((e) => [e.data.round, e.data.problemId]),
    });
    const wholeShape = shape(whole.events);
    const cuts = whole.events.flatMap((e, i) => (e.type === "budget.round" || e.type === "problem.parked" || e.type === "problem.finished" ? [i, i + 1] : []));
    assert.ok(cuts.length >= 8);
    for (const at of cuts) {
      if (at >= whole.events.length) continue;
      const used = whole.events.slice(0, at).filter((e) => e.type === "attempt.charged").length;
      const resumed = await demoResume({ dir: killedAt(whole.dir, at), bench: whole.bench, pricePerMillion: PRICE, responses: script().slice(used) });
      assert.deepEqual(shape(resumed.events), wholeShape, `cut at event ${at} (${whole.events[at]?.type})`);
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome).sort(), ["candidate", "candidate", "candidate"], `cut at ${at}`);
    }
  });
});

describe("a probe that a slice paused", () => {
  // At this price one model response costs about $0.97. Two problems, a problem allowance of $28 (a probe cap of $2.80) and a run allowance of $7:
  // round 0's slice is $7 / 8 = $0.875, under the probe's cap, so the probe's one response crosses the slice and the slice pauses it.
  const SLICE_PRICE = 400;
  const cfg = { provers: 2, sessions: 3, seed: "slice-probe", budget: { problemUsd: 28, runUsd: 7 }, budgetRounds: true, gate: { floor: 0 } };
  const gates = (events: Parameters<typeof ofType>[0]) => ofType(events, "budget.gated").map((e) => e.data);

  it("goes on at the next slice, as a probe, within the probe's cap; the gate answers once, and the problem is solved when the probe succeeds", async () => {
    const win = check("exact trivial_proof");
    const { result, events } = await demoRun({
      pricePerMillion: SLICE_PRICE, problems: 2, file: THREE, config: cfg,
      responses: [check("bad 1"), check("bad 2"), win, win],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["candidate", "candidate"]);
    const cut = ofType(events, "attempt.finished").filter((e) => e.data.outcome === "budget_exhausted");
    assert.ok(cut.length >= 1, "a slice cut a probe's session");
    const probeCap = 0.1 * 28;
    // One probe row and no gate answer more than once: a probe is journaled once, and a solved problem was never judged.
    for (const problemId of new Set(gates(events).map((g) => g.problemId))) {
      assert.equal(gates(events).filter((g) => g.problemId === problemId && g.action === "probe").length, 1);
    }
    const started = ofType(events, "task.status_changed").filter((e) => e.data.to === "running");
    const perTask = new Map<string, number>();
    for (const e of started) perTask.set(e.data.taskId, (perTask.get(e.data.taskId) ?? 0) + 1);
    assert.ok([...perTask.values()].every((n) => n === 1), "no task is started twice");
    assert.ok(result.problems.every((p) => p.usd <= probeCap), "the probe stayed within its cap");
  });

  it("judges as before when the continued probe makes no progress", async () => {
    const { result, events } = await demoRun({
      pricePerMillion: SLICE_PRICE, problems: 2, file: THREE, config: cfg,
      responses: Array.from({ length: 12 }, (_, k) => check(`bad ${k}`)),
    });
    assert.ok(result.problems.every((p) => p.outcome === "unsolved"));
    for (const problemId of new Set(gates(events).map((g) => g.problemId))) {
      const own = gates(events).filter((g) => g.problemId === problemId);
      assert.deepEqual(own.map((g) => `${g.action}:${g.by}`), ["probe:probe", "skip:progress"]);
    }
    for (const p of result.problems) assert.ok(p.usd <= 2.8 + 1, `${p.problemId} spent ${p.usd} on its probe: its cap and the response that crossed it`);
  });
});
