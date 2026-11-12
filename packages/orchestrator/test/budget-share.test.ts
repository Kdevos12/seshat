import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { check, DEMO_FILE, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";

const THREE = DEMO_FILE.replace("end Demo", `/-- Zero is a left identity. -/
@[category research solved, AMS 11]
theorem zero_add' (n : ℕ) : 0 + n = n := by
  sorry

end Demo`);
const PRICE = 10;
const win = check("exact trivial_proof");
/** The first problem never succeeds: sessions of one failing check and their notes, until its cap cuts it. */
const hopeless = (n: number) => Array.from({ length: n }, (_, k) => [check(`bad ${k}`), say("notes")]).flat();

describe("a problem's share of the run budget (PA4)", () => {
  const config = { sessions: 20, budget: { problemUsd: 5, runUsd: 0.3 } };

  it("without the setting the first problem takes the run budget and the others are never begun", async () => {
    const { result, events } = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config, responses: [...hopeless(20), win, win] });
    assert.equal(result.problems.length, 1);
    assert.ok((result.problems[0]?.usd ?? 0) >= 0.29);
    assert.ok(ofType(events, "problem.registered").every((e) => e.data.allowanceUsd === undefined), "nothing new in the journal");
  });

  it("caps the first problem at share x run budget / problems left, and the third still runs a session", async () => {
    const { result, events } = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: { ...config, budgetShare: 2 }, responses: [...hopeless(6), win, win, win] });
    assert.equal(result.problems.length, 3);
    const first = result.problems[0];
    assert.ok((first?.usd ?? 99) <= 0.2 + 0.02, `the first spent $${first?.usd}`);
    assert.ok((first?.usd ?? 0) >= 0.19);
    assert.ok((result.problems[2]?.attempts ?? 0) >= 1 && (result.problems[2]?.usd ?? 0) > 0, "the third problem ran a session");
    const allowances = ofType(events, "problem.registered").map((e) => e.data.allowanceUsd ?? -1);
    assert.ok(Math.abs((allowances[0] ?? 0) - 0.2) < 1e-9, "the cap used is in the journal");
    assert.ok((allowances[1] ?? 99) < 0.2 && (allowances[1] ?? 0) > 0);
  });

  it("bounds a problem's total over its slices when the budget is in rounds", async () => {
    const { result } = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: { ...config, budgetShare: 2, budgetRounds: true }, responses: [...hopeless(20), win, win, ...hopeless(20)] });
    for (const p of result.problems) assert.ok(p.usd <= 0.2 + 0.02, `${p.problemId} spent $${p.usd}`);
  });

  it("gives a resumed problem the bound it was opened with, from the journal", async () => {
    const responses = () => [...hopeless(20)];
    const cfg = { ...config, budgetShare: 2 };
    const whole = await demoRun({ pricePerMillion: PRICE, problems: 3, file: THREE, config: cfg, responses: responses() });
    const registered = ofType(whole.events, "problem.registered");
    assert.ok(registered.length >= 2);
    // The process ended after the second problem's first session.
    const opened = whole.events.indexOf(registered[1] as (typeof whole.events)[number]);
    const cut = whole.events.findIndex((e, i) => i > opened && e.type === "attempt.finished") + 1;
    assert.ok(opened > 0 && cut > opened);
    const calls = whole.events.slice(0, cut).filter((e) => e.type === "attempt.charged").length;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, pricePerMillion: PRICE, responses: responses().slice(calls) });
    const spent = (r: typeof whole.result) => r.problems.map((p) => [p.problemId, p.outcome, Math.round(p.usd * 1e6)]);
    assert.deepEqual(spent(resumed.result), spent(whole.result), "the same problems, outcomes and spend as the run that was not cut");
    assert.ok(Math.abs(resumed.result.usd - whole.result.usd) < 1e-9);
  });
});
