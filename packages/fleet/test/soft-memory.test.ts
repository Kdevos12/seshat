import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, type ValidationReport } from "@seshat/core";
import { type FinishedAttempt, InterruptedError, type JsonObject, type ProblemContext, type SessionContext } from "@seshat/lines";
import { type Attempt, MemoryStore } from "@seshat/memory";
import {
  allocations, attemptWeights, betaUpdate, checkStepDag, createFleet, DIRECTIVES, FLEET_OPTIONS, modelOrderOf, posteriorOf, runsBetween, sampleSettings, seeded,
  settingsConfigOf, stepStates, strategyPosteriors, UNIFORM,
} from "../src/index.ts";

/** A world over a real journal and one claim, as in hooks.test.ts, with the exploration floor as the test sets it. */
async function setup(options: JsonObject = {}, fleet = createFleet()) {
  const dir = mkdtempSync(join(tmpdir(), "mh-soft-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
  const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
  const registry = {};
  const controller = new AbortController();
  const hooks = fleet.hooks;
  const problem = (): ProblemContext =>
    ({ line: "fleet", runId: "run_1", problemId: "prob_1", claimId, memory: memory.withActor("line:fleet"), registry, signal: controller.signal, options: { ...FLEET_OPTIONS, widen: false, ...options } }) as unknown as ProblemContext;
  const context = (prover: string, session: number): SessionContext =>
    ({ ...problem(), prover, session, sessions: 999, attemptId: `att_${prover}_${session}`, model: "faux/prover", regions: { aux: "", proof: "" } }) as unknown as SessionContext;

  /** A session as the orchestrator runs it: the decision, the attempt that records it, and its end. */
  async function run(prover: string, number: number, outcome: "valid" | "invalid", failureClass = "unsolved_goals") {
    const ctx = context(prover, number);
    const decision = await hooks.beforeSession?.(ctx);
    journal.emit(
      "attempt.started",
      {
        attemptId: ctx.attemptId, claimId, prover, iteration: number, model: decision?.model ?? "faux/prover",
        ...(decision?.strategy !== undefined ? { strategy: decision.strategy } : {}),
        ...(decision?.settings !== undefined ? { settings: decision.settings } : {}),
        ...(decision?.exploration !== undefined ? { exploration: decision.exploration } : {}),
      },
      `prover:${prover}`,
    );
    await hooks.afterAttempt?.(problem(), { attemptId: ctx.attemptId, prover, session: number } as unknown as FinishedAttempt);
    journal.emit(
      "attempt.finished",
      { attemptId: ctx.attemptId, outcome, ...(outcome === "invalid" ? { failureClass } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
      `prover:${prover}`,
    );
    return decision;
  }
  /** An attempt written with the settings given, as a past session would have been. */
  function put(id: string, settings: JsonObject, outcome: "valid" | "invalid") {
    journal.emit("attempt.started", { attemptId: id, claimId, prover: "old", iteration: 1, model: "faux/prover", settings }, "prover:old");
    journal.emit(
      "attempt.finished",
      { attemptId: id, outcome, ...(outcome === "invalid" ? { failureClass: "syntax" } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
      "prover:old",
    );
  }
  return { memory, journal, claimId, hooks, context, problem, run, put };
}

const attempt = (over: Partial<Attempt>): Attempt => {
  const base = { attemptId: "a", claimId: "c", prover: "p", iteration: 1, model: "m", role: "prover", startedSeq: 1, outcome: "invalid", failureClass: "syntax" };
  const merged: Record<string, unknown> = { ...base, ...over };
  if (merged.outcome === "valid") delete merged.failureClass;
  return merged as unknown as Attempt;
};

describe("the exploration floor", () => {
  it("takes about epsilon of the sessions, whatever the posteriors say, and records each one", async () => {
    const world = await setup({ epsilon: 0.1, stick: false, seed: 42 });
    const decisions = [];
    for (let k = 1; k <= 300; k++) decisions.push(await world.run("p1", k, "invalid", "syntax"));
    const explored = decisions.filter((d) => d?.exploration === true).length;
    // Binomial(300, 0.1): mean 30, standard deviation about 5.2. The draws are seeded, so the count is the same every run.
    assert.ok(explored >= 15 && explored <= 48, `explored ${explored} of 300`);
    const rules = allocations(world.memory, world.claimId).map((a) => a.data.rule);
    assert.equal(rules.filter((rule) => rule === "exploration").length, explored);
    const recorded = world.memory.attempts(world.claimId);
    assert.equal(recorded.filter((a) => a.exploration === true).length, explored, "the attempt records the flag");
    assert.equal(recorded.filter((a) => a.exploration === false).length, 300 - explored, "and a session drawn from the posteriors records that it was not");
    // An exploration draw is uniform among the labels: most of the twelve show up over the run.
    const labels = new Set(allocations(world.memory, world.claimId).filter((a) => a.data.rule === "exploration").map((a) => a.data.strategy));
    assert.ok(labels.size >= 8, [...labels].join(","));
    assert.equal(
      allocations(world.memory, world.claimId).filter((a) => a.data.rule === "exploration").every((a) => a.data.draws === undefined),
      true,
      "an exploration draw has no posterior draws to show",
    );
  });

  it("is off at epsilon 0, and every session at epsilon 1, even for a strategy that failed ten times", async () => {
    const off = await setup({ epsilon: 0, stick: false, seed: 1 });
    for (let k = 1; k <= 100; k++) assert.equal((await off.run("p1", k, "invalid", "syntax"))?.exploration, undefined);
    assert.equal(off.memory.attempts(off.claimId).some((a) => a.exploration === true), false);
    const all = await setup({ epsilon: 1, stick: false, seed: 1 });
    for (let k = 1; k <= 10; k++) await all.run("p1", k, "invalid", "syntax");
    const picks = new Map<string, number>();
    for (let k = 11; k <= 400; k++) {
      const decision = await all.run("p1", k, "invalid", "syntax");
      assert.equal(decision?.exploration, true);
      picks.set(decision?.strategy ?? "none", (picks.get(decision?.strategy ?? "none") ?? 0) + 1);
    }
    // 390 uniform draws among the twelve labels a session can be told: about 32 each.
    assert.equal(picks.size, 12);
    for (const [label, n] of picks) assert.ok(n >= 14 && n <= 55, `${label}: ${n}`);
  });

  it("leaves the posterior draws of a session as a run without the floor makes them, until the floor changes what was tried", async () => {
    // The floor has its own stream of the session's key: a session it does not take draws what it would have drawn
    // from the same history. After its first exploration the histories differ, so the check ends there.
    const without = await setup({ epsilon: 0, stick: false, seed: 7 });
    const withFloor = await setup({ epsilon: 0.1, stick: false, seed: 7 });
    for (let k = 1; k <= 40; k++) {
      const a = await without.run("p1", k, "invalid", "syntax");
      const b = await withFloor.run("p1", k, "invalid", "syntax");
      if (b?.exploration === true) break;
      assert.equal(b?.strategy, a?.strategy, `session ${k}`);
    }
  });

  it("is refused for a value outside [0, 1]", async () => {
    const world = await setup({ epsilon: 1.5 });
    await assert.rejects(world.run("p1", 1, "invalid"), /the option epsilon must be between 0 and 1/);
    const other = await setup({ gamma: -0.1 });
    await assert.rejects(other.run("p1", 1, "invalid"), /the option gamma must be between 0 and 1/);
  });
});

describe("the discount of earlier runs", () => {
  const epochOne = (epoch: number): number => (epoch === 0 ? 1 : 0.5);

  it("weighs an attempt gamma to the power of the runs on the problem since it", () => {
    const attempts = [attempt({ runsAgo: 0 }), attempt({ runsAgo: 1 }), attempt({ runsAgo: 2 }), attempt({})];
    const weigh = attemptWeights(attempts, { gamma: 0.8, epochWeight: () => 1 });
    const weights = attempts.map(weigh);
    assert.deepEqual(weights.map((w) => Math.round(w * 1e6) / 1e6), [1, 0.8, 0.64, 1], "an attempt with no runsAgo is the current run's");
  });

  it("counts the runs that worked on the problem, so a run that made no attempt discounts nothing", () => {
    // Runs 0 and 3 worked on the claim; 1 and 2 did not: the old attempts are one run behind, not three.
    const attempts = [attempt({ runsAgo: 3 }), attempt({ runsAgo: 3 })];
    assert.equal(runsBetween(attempts)(attempts[0] as Attempt), 1, "the current run counts as 0 even before it made an attempt");
    const mixed = [attempt({ runsAgo: 0 }), attempt({ runsAgo: 3 }), attempt({ runsAgo: 5 })];
    assert.deepEqual(mixed.map(runsBetween(mixed)), [0, 1, 2]);
    const weigh = attemptWeights(mixed, { gamma: 0.5, epochWeight: () => 1 });
    assert.deepEqual(mixed.map(weigh), [1, 0.5, 0.25]);
  });

  it("multiplies it by the probation weight of the attempt's epoch", () => {
    const attempts = [attempt({ runsAgo: 1, epoch: 0 }), attempt({ runsAgo: 1, epoch: 1 }), attempt({ runsAgo: 0, epoch: 1 })];
    const weigh = attemptWeights(attempts, { gamma: 0.8, epochWeight: epochOne });
    assert.deepEqual(attempts.map(weigh), [0.8, 0.8 * 0.5, 0.5]);
  });

  it("is a weight of 1 for everything with one run, and of 0 at gamma 0 for an earlier run", () => {
    const one = [attempt({}), attempt({ runsAgo: 0 })];
    assert.deepEqual(one.map(attemptWeights(one, { gamma: 0.8, epochWeight: () => 1 })), [1, 1]);
    const two = [attempt({ runsAgo: 0 }), attempt({ runsAgo: 1 })];
    assert.deepEqual(two.map(attemptWeights(two, { gamma: 0, epochWeight: () => 1 })), [1, 0]);
  });

  it("shrinks an old failure's pull on a posterior: Beta(1 + 10 gamma, ...) not Beta(11, ...)", () => {
    // Ten failures with syntax errors, all of the last run: rewards 0, so beta takes the weight.
    const old = Array.from({ length: 10 }, (_, i) => attempt({ attemptId: `o${i}`, runsAgo: 1 }));
    const weigh = attemptWeights(old, { gamma: 0.8, epochWeight: () => 1 });
    const discounted = posteriorOf(old, 0.5, weigh);
    const plain = posteriorOf(old, 0.5);
    assert.equal(plain.success.beta, 11);
    assert.ok(Math.abs(discounted.success.beta - (1 + 10 * 0.8)) < 1e-9, String(discounted.success.beta));
    assert.equal(discounted.attempts, 10, "the attempts that said something are counted once each, whatever their weight");
    // A new outcome counts in full on top of them.
    const now = [...old, attempt({ attemptId: "n", runsAgo: 0, outcome: "valid" })];
    const posterior = posteriorOf(now, 0.5, attemptWeights(now, { gamma: 0.8, epochWeight: () => 1 }));
    assert.equal(posterior.success.alpha, 2);
    assert.ok(Math.abs(posterior.success.beta - 9) < 1e-9);
  });

  it("is the weighted update: alpha takes the weighted reward and beta the rest", () => {
    assert.deepEqual(betaUpdate(UNIFORM, 1, 0.8), { alpha: 1.8, beta: 1 });
    assert.deepEqual(betaUpdate(UNIFORM, 0, 0.8), { alpha: 1, beta: 1.8 });
    const half = betaUpdate(UNIFORM, 0.25, 0.4);
    assert.ok(Math.abs(half.alpha - 1.1) < 1e-12 && Math.abs(half.beta - 1.3) < 1e-12);
    assert.deepEqual(betaUpdate(UNIFORM, 1, 0), UNIFORM, "a weight of 0 changes nothing");
    assert.deepEqual(betaUpdate(UNIFORM, 1), { alpha: 2, beta: 1 });
  });

  it("moves a strategy's draw: a strategy that failed in an earlier run is drawn more than one that failed just now", () => {
    const recent = Array.from({ length: 6 }, (_, i) => attempt({ attemptId: `r${i}`, strategy: "induction", runsAgo: 0 }));
    const older = Array.from({ length: 6 }, (_, i) => attempt({ attemptId: `d${i}`, strategy: "induction", runsAgo: 3 }));
    const fresh = strategyPosteriors(recent, 0.5, attemptWeights(recent, { gamma: 0.8, epochWeight: () => 1 })).get("induction");
    const stale = strategyPosteriors(older, 0.5, attemptWeights([...older, attempt({ runsAgo: 0 })], { gamma: 0.8, epochWeight: () => 1 })).get("induction");
    assert.ok(fresh !== undefined && stale !== undefined);
    // Six failures in the current run: beta 7. The same six, one run on the problem behind: 1 + 6 * 0.8.
    assert.equal(fresh.success.beta, 7);
    assert.ok(Math.abs(stale.success.beta - 5.8) < 1e-9);
    assert.ok(stale.choice.beta < fresh.choice.beta);
  });
});

describe("which model ranks as stronger", () => {
  it("is the ranking given, else the run's model and the escalation model; the order of `models` is never a ranking", () => {
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS }), ["a/run"]);
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS, escalateTo: "a/top" }), ["a/run", "a/top"]);
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS, escalateTo: "a/run" }), ["a/run"]);
    // `models: [big, small]` lists what to choose among: it says nothing of which is stronger, so no model of it is "the strongest".
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS, models: ["a/big", "a/small"] }), ["a/run"]);
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS, models: ["a/mid", "a/low"], escalateTo: "a/top" }), ["a/run", "a/top"]);
    assert.deepEqual(modelOrderOf("a/run", { ...FLEET_OPTIONS, models: ["a/big", "a/small"], ranking: ["a/small", "a/run", "a/big"] }), ["a/small", "a/run", "a/big"]);
  });
});

describe("the settings a session is given", () => {
  it("reads the distributions, and says what is wrong with the ones it cannot", () => {
    assert.deepEqual(settingsConfigOf({}), {});
    assert.deepEqual(settingsConfigOf({ temperature: 0.7 }), { temperature: { fixed: 0.7 } });
    assert.deepEqual(settingsConfigOf({ temperature: [0.2, 1] }), { temperature: { values: [0.2, 1] } });
    assert.deepEqual(settingsConfigOf({ temperature: { min: 0.2, max: 1 } }), { temperature: { min: 0.2, max: 1 } });
    assert.deepEqual(settingsConfigOf({ thinking: ["low", "high", "low"] }).thinking, ["low", "high"]);
    assert.deepEqual(settingsConfigOf({ directives: true }).directives, { ...DIRECTIVES });
    assert.deepEqual(settingsConfigOf({ directives: { a: "Do a." } }).directives, { a: "Do a." });
    assert.deepEqual(settingsConfigOf({ modes: ["standard", "nl_first"] }).modes, ["standard", "nl_first"]);
    assert.throws(() => settingsConfigOf({ temperature: 3 }), /temperature takes numbers from 0 to 2/);
    assert.throws(() => settingsConfigOf({ temperature: [] }), /empty list/);
    assert.throws(() => settingsConfigOf({ temperature: { min: 1, max: 0.5 } }), /min above max/);
    assert.throws(() => settingsConfigOf({ temperature: "hot" }), /a number, a list of numbers or \{min, max\}/);
    assert.throws(() => settingsConfigOf({ thinking: ["deep"] }), /thinking levels/);
    assert.throws(() => settingsConfigOf({ thinking: [] }), /thinking levels/);
    assert.throws(() => settingsConfigOf({ directives: {} }), /label to text/);
    assert.throws(() => settingsConfigOf({ directives: { a: "" } }), /label to text/);
    assert.throws(() => settingsConfigOf({ modes: ["quick"] }), /modes is a non-empty list/);
  });

  it("is sampled from the configured distributions, recorded on the attempt, and repeats for a seed", async () => {
    const options = { strategies: false, seed: 3, temperature: { min: 0.2, max: 1 }, thinking: ["low", "high"], directives: true };
    const a = await setup(options);
    const b = await setup(options);
    const [x, y] = [await a.run("p1", 1, "invalid"), await b.run("p1", 1, "invalid")];
    assert.deepEqual(x?.settings, y?.settings);
    const settings = x?.settings ?? {};
    assert.ok(typeof settings.temperature === "number" && settings.temperature >= 0.2 && settings.temperature <= 1);
    assert.ok(settings.thinking === "low" || settings.thinking === "high");
    assert.ok(typeof settings.directive === "string" && settings.directive in DIRECTIVES);
    assert.equal(settings.mode, undefined, "a setting that is not configured is not sampled");
    assert.deepEqual(a.memory.attempts(a.claimId)[0]?.settings, settings, "the attempt carries the settings, rebuilt from the journal");
    const [record] = allocations(a.memory, a.claimId);
    assert.deepEqual(record?.data.settings, settings);
    assert.deepEqual(Object.keys(record?.data.settingDraws ?? {}).sort(), ["directive", "thinking"], "the draws of the learned settings are kept; the range is not learned");
    // Many sessions cover the range and every learned value.
    const temperatures: number[] = [];
    const levels = new Set<unknown>();
    for (let k = 2; k <= 60; k++) {
      const next = await a.run("p1", k, "invalid");
      temperatures.push(next?.settings?.temperature as number);
      levels.add(next?.settings?.thinking);
    }
    assert.ok(Math.min(...temperatures) < 0.4 && Math.max(...temperatures) > 0.8);
    assert.deepEqual([...levels].sort(), ["high", "low"]);
  });

  it("decides nothing when no setting is configured, and with the strategies off", async () => {
    const world = await setup({ strategies: false });
    assert.equal(await world.run("p1", 1, "invalid"), undefined);
    assert.equal(world.memory.attempts(world.claimId)[0]?.settings, undefined);
  });

  it("learns the discrete settings: the thinking level that proved is drawn far more often", () => {
    const attempts = [
      ...Array.from({ length: 12 }, (_, i) => attempt({ attemptId: `h${i}`, settings: { thinking: "high" }, outcome: "valid" })),
      ...Array.from({ length: 12 }, (_, i) => attempt({ attemptId: `l${i}`, settings: { thinking: "low" } })),
    ];
    const random = seeded(11);
    const picks = { high: 0, low: 0, medium: 0 };
    for (let k = 0; k < 200; k++) {
      const { settings } = sampleSettings(random, { thinking: ["low", "medium", "high"] }, attempts, 0.5);
      picks[settings.thinking as keyof typeof picks] += 1;
    }
    assert.ok(picks.high > 120, JSON.stringify(picks));
    assert.ok(picks.low < 20, JSON.stringify(picks));
    assert.ok(picks.medium > 0, "a value nothing is known of has the flat posterior, so it is tried");
  });

  it("learns them through the discount too: an old win counts for less", () => {
    const attempts = [attempt({ attemptId: "w", settings: { mode: "nl_first" }, outcome: "valid", runsAgo: 4 })];
    const weigh = attemptWeights([...attempts, attempt({ runsAgo: 0 })], { gamma: 0.5, epochWeight: () => 1 });
    const draws = sampleSettings(seeded(1), { modes: ["standard", "nl_first"] }, attempts, 0.5, weigh).draws.mode ?? {};
    assert.ok("standard" in draws && "nl_first" in draws);
  });
});

describe("a session that writes its settings and its flag into the attempt", () => {
  it("records the exploration flag with the strategy, and projects the settings back", async () => {
    const world = await setup({ epsilon: 0.5, stick: false, seed: 5, thinking: ["low", "high"] });
    for (let k = 1; k <= 20; k++) await world.run("p1", k, "invalid", "syntax");
    const attempts = world.memory.attempts(world.claimId);
    assert.equal(attempts.length, 20);
    for (const a of attempts) {
      assert.equal(typeof a.exploration, "boolean");
      assert.ok(a.settings?.thinking === "low" || a.settings?.thinking === "high");
    }
    assert.ok(attempts.some((a) => a.exploration) && attempts.some((a) => !a.exploration));
  });

  it("learns the settings of earlier attempts from the journal alone", async () => {
    const world = await setup({ strategies: false, seed: 2, thinking: ["low", "high"] });
    for (let k = 0; k < 10; k++) {
      world.put(`h${k}`, { thinking: "high" }, "valid");
      world.put(`l${k}`, { thinking: "low" }, "invalid");
    }
    let high = 0;
    for (let k = 1; k <= 30; k++) if ((await world.run("p9", k, "invalid"))?.settings?.thinking === "high") high += 1;
    assert.ok(high >= 25, `high: ${high} of 30`);
  });
});

describe("the shape of a step DAG", () => {
  const step = (id: string, dependsOn: string[] = [], statement = `claim ${id}`) => ({ id, statement, dependsOn });
  const dag = (...steps: ReturnType<typeof step>[]) => ({ proof: "p", steps });

  it("accepts an acyclic DAG whose steps are used", () => {
    assert.deepEqual(checkStepDag(dag(step("s1"), step("s2"), step("s3", ["s1", "s2"])), 8), []);
    assert.deepEqual(checkStepDag(dag(step("only")), 8), []);
  });

  it("refuses a cycle, and says which", () => {
    const [problem] = checkStepDag(dag(step("a", ["c"]), step("b", ["a"]), step("c", ["b"])), 8);
    assert.match(problem ?? "", /cycle: a -> c -> b -> a/);
    assert.match(checkStepDag(dag(step("a", ["a"])), 8)[0] ?? "", /cycle: a -> a/);
  });

  it("refuses a forward reference", () => {
    const problems = checkStepDag(dag(step("a", ["b"]), step("b"), step("c", ["a", "b"])), 8);
    assert.ok(problems.some((p) => /forward reference: step a uses b/.test(p)), problems.join("; "));
  });

  it("refuses a step that nothing uses, but not the last one", () => {
    assert.deepEqual(checkStepDag(dag(step("a"), step("b"), step("c", ["a"])), 8), ["step b is not used by any later step (every step but the last must be used)"]);
  });

  it("refuses an unknown dependency, a duplicate id, a bad id, an empty statement and too many steps", () => {
    assert.match(checkStepDag(dag(step("a"), step("b", ["zzz", "a"])), 8)[0] ?? "", /step b uses zzz, which is not a step/);
    assert.match(checkStepDag(dag(step("a"), step("a", ["a"])), 8)[0] ?? "", /used by two steps/);
    assert.match(checkStepDag(dag(step("Bad Id")), 8)[0] ?? "", /not a short lowercase name/);
    assert.match(checkStepDag(dag(step("a", [], "  ")), 8)[0] ?? "", /empty statement/);
    assert.match(checkStepDag(dag(step("a"), step("b", ["a"]), step("c", ["b"])), 2)[0] ?? "", /3 steps, at most 2/);
    assert.deepEqual(checkStepDag(dag(), 8), ["the DAG has no step"]);
  });
});

describe("what Lean said of each step", () => {
  const checked = [
    "import Mathlib",
    "lemma aux_s1 : 1 + 1 = 2 := by", // 2
    "  decide",
    "",
    "lemma aux_s2 : 2 + 2 = 4 := by", // 5
    "  omega_nonsense",
    "",
    "lemma aux_s3 : 3 = 3 := by", // 8
    "  sorry",
    "",
    "theorem main : True := by", // 11
    "  trivial",
  ].join("\n");
  const pos = (line: number) => ({ line, column: 2 });
  const report = (messages: Array<{ severity: "error" | "warning" | "info"; line: number; text: string }>, sorries: number[]): Pick<ValidationReport, "checked" | "messages" | "sorries"> =>
    ({
      checked,
      messages: messages.map((m) => ({ severity: m.severity, text: m.text, pos: pos(m.line) })),
      sorries: sorries.map((line) => ({ pos: pos(line), goal: "" })),
    }) as unknown as Pick<ValidationReport, "checked" | "messages" | "sorries">;
  const dag = { proof: "p", steps: [{ id: "s1", statement: "x", dependsOn: [] }, { id: "s2", statement: "y", dependsOn: ["s1"] }, { id: "s3", statement: "z", dependsOn: ["s2"] }, { id: "s4", statement: "w", dependsOn: ["s3"] }] };

  it("maps an error to the lemma it falls in, a sorry to its lemma, and a lemma never written to missing", () => {
    const states = stepStates(dag, report([{ severity: "error", line: 6, text: "unknown tactic" }], [9]));
    assert.deepEqual(states, { s1: "closed", s2: "error", s3: "hole", s4: "missing" });
  });

  it("gives an error of the main proof to no step", () => {
    const states = stepStates(dag, report([{ severity: "error", line: 12, text: "type mismatch" }], []));
    assert.deepEqual(states, { s1: "closed", s2: "closed", s3: "closed", s4: "missing" });
  });

  it("reads the warning 'declaration uses sorry' as a hole when the report lists no sorry", () => {
    const states = stepStates(dag, report([{ severity: "warning", line: 8, text: "declaration uses 'sorry'" }], []));
    assert.equal(states.s3, "hole");
  });
});

describe("informal-first sessions in a fleet", () => {
  const dag = { proof: "p", steps: [{ id: "s1", statement: "claim one", dependsOn: [] }, { id: "s2", statement: "claim two", dependsOn: ["s1"] }] };
  /** The context of a session that can call a model: `answer` is what the DAG call does. */
  const withLlm = (world: Awaited<ReturnType<typeof setup>>, prover: string, answer: () => Promise<unknown>): SessionContext =>
    ({
      ...world.context(prover, 1),
      target: { theorem: "t", statement: "(n : ℕ) : n + 0 = n" },
      budget: { exhausted: false },
      llm: { complete: async () => { throw new Error("not used"); }, completeJson: answer },
    }) as unknown as SessionContext;

  it("never gives two provers the same strategy on a subgoal while one waits for its DAG", async () => {
    let collisions = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = await setup({ epsilon: 0, stick: false, seed, modes: ["nl_first"] });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      // Both provers draw `nl_first`; the model call of the DAG takes as long as the test lets it.
      const answer = async () => {
        await released;
        return { value: dag, text: "", cost: {}, model: "faux/prover", modelCallId: "m", modelCallIds: ["m"] };
      };
      const first = world.hooks.beforeSession?.(withLlm(world, "p1", answer));
      const second = world.hooks.beforeSession?.(withLlm(world, "p2", answer));
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.ok(a?.strategy !== undefined && b?.strategy !== undefined);
      if (a.strategy === b.strategy) collisions += 1;
    }
    assert.equal(collisions, 0, "two provers were told the same strategy");
  });

  it("records the mode that ran and the mode that was drawn when the DAG cannot be written, and counts the arm that ran", async () => {
    const world = await setup({ epsilon: 0, strategies: false, seed: 3, modes: ["nl_first"] });
    const decision = await world.hooks.beforeSession?.(withLlm(world, "p1", async () => { throw new Error("the model errs"); }));
    assert.deepEqual(decision?.settings, { mode: "standard", drawnMode: "nl_first" });
    const [record] = allocations(world.memory, world.claimId);
    assert.deepEqual(record?.data.settings, { mode: "standard", drawnMode: "nl_first" });
    assert.match(record?.data.dagNote ?? "", /could not be written: the model errs/);
    // The outcome of such a session is counted for `standard`, the arm that ran, and not for `nl_first`.
    world.put("a1", { mode: "standard", drawnMode: "nl_first" }, "valid");
    world.put("a2", { mode: "nl_first" }, "invalid");
    const modes = settingsConfigOf({ modes: ["standard", "nl_first"] });
    const attempts = world.memory.attempts(world.claimId);
    let standard = 0;
    for (let k = 0; k < 40; k++) if (sampleSettings(seeded(100 + k), modes, attempts, 0.5).settings.mode === "standard") standard += 1;
    assert.ok(standard >= 30, `standard drawn ${standard} of 40`);
  });

  it("records nothing, decides nothing and gives its place back when the turn refuses the DAG call", async () => {
    const world = await setup({ epsilon: 0, stick: false, seed: 3, modes: ["nl_first"] });
    const refused = async () => { throw new InterruptedError("the turn is over"); };
    assert.equal(await world.hooks.beforeSession?.(withLlm(world, "p1", refused)), undefined, "no decision: the session does not start");
    assert.deepEqual(allocations(world.memory, world.claimId), [], "no allocation");
    assert.deepEqual(world.memory.nodes("step_dag_failure", { claimId: world.claimId }), [], "a refused call is not a failed try");
    // The place is free: another prover is not kept off the strategy the first would have taken, and the next turn asks again.
    const dagCalls: number[] = [];
    const answer = async () => { dagCalls.push(1); return { value: dag, text: "", cost: {}, model: "faux/prover", modelCallId: "m", modelCallIds: ["m"] }; };
    const decision = await world.hooks.beforeSession?.(withLlm(world, "p1", answer));
    assert.ok(decision !== undefined, "the next turn decides");
    assert.equal(dagCalls.length, 1);
  });
});
