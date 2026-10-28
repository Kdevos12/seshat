import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { FinishedAttempt, JsonObject, ProblemContext, ResumedProblem, SessionContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { allocations, createFleet, FLEET_OPTIONS } from "../src/index.ts";

/**
 * A run's memory over a real journal, one claim, and the means to write the attempts a prover's session writes. The exploration floor
 * is off unless a test asks for it (`epsilon`): these tests are about the posteriors.
 */
async function setup(options: JsonObject = {}, fleet = createFleet()) {
  const dir = mkdtempSync(join(tmpdir(), "mh-fleet-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
  const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
  const registry = {};
  const controller = new AbortController();
  let attempts = 0;
  const hooks = fleet.hooks;

  const problem = (): ProblemContext =>
    ({ line: "fleet", runId: "run_1", problemId: "prob_1", claimId, memory: memory.withActor("line:fleet"), registry, signal: controller.signal, options: { ...FLEET_OPTIONS, epsilon: 0, ...options } }) as unknown as ProblemContext;
  const context = (prover: string, session: number): SessionContext =>
    ({ ...problem(), prover, session, sessions: 99, attemptId: `att_${prover}_${session}`, model: "faux/prover", regions: { aux: "", proof: "" } }) as unknown as SessionContext;

  type Finish = { outcome: "valid" | "invalid" | "no_submission"; failureClass?: string; strategy?: string };

  /** The start of a session: the decision of `beforeSession`, and the attempt that starts with it. */
  async function begin(prover: string, number: number) {
    const ctx = context(prover, number);
    const decision = await hooks.beforeSession?.(ctx);
    attempts += 1;
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
    return decision;
  }

  /** The end of a session in the orchestrator's order: `afterAttempt` runs first, and only after it is `attempt.finished` journaled. */
  async function end(prover: string, number: number, finish: Finish) {
    const attemptId = context(prover, number).attemptId;
    await hooks.afterAttempt?.(problem(), { attemptId, prover, session: number } as unknown as FinishedAttempt);
    journal.emit(
      "attempt.finished",
      {
        attemptId, outcome: finish.outcome, ...(finish.failureClass !== undefined ? { failureClass: finish.failureClass } : {}),
        ...(finish.strategy !== undefined ? { strategy: finish.strategy } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0,
      },
      `prover:${prover}`,
    );
  }

  /** A whole session, or only the decision for it when `finish` is undefined (no attempt is written then). */
  async function session(prover: string, number: number, finish: Finish | undefined) {
    if (finish === undefined) return hooks.beforeSession?.(context(prover, number));
    const decision = await begin(prover, number);
    await end(prover, number, finish);
    return decision;
  }
  return { memory, journal, claimId, hooks, context, problem, session, begin, end, controller, count: () => attempts };
}

describe("what the next session is told", () => {
  it("is a strategy drawn from the posteriors of what was tried, so a strategy that keeps failing is drawn rarely", async () => {
    const world = await setup({ widen: false, stick: false });
    for (let k = 1; k <= 10; k++) await world.session("p1", k, { outcome: "invalid", failureClass: "syntax", strategy: "induction" });
    const picks: Record<string, number> = {};
    for (let k = 1; k <= 60; k++) {
      const decision = await world.session("p2", k, undefined);
      picks[decision?.strategy ?? "none"] = (picks[decision?.strategy ?? "none"] ?? 0) + 1;
      await world.hooks.afterAttempt?.(world.problem(), { attemptId: `att_p2_${k}`, prover: "p2", session: k } as unknown as FinishedAttempt);
    }
    // Eleven candidates were never tried and one failed ten times: it is drawn far less than a twelfth of the time.
    assert.ok((picks.induction ?? 0) <= 2, JSON.stringify(picks));
    assert.ok(Object.keys(picks).length >= 8, JSON.stringify(picks));
    assert.equal(picks.other, undefined, "other says nothing, so it is never told");
  });

  it("is a strategy that has proved, far more often than a twelfth of the time", async () => {
    const world = await setup({ widen: false, stick: false });
    for (let k = 1; k <= 40; k++) await world.session("p1", k, { outcome: "valid", strategy: "cases" });
    const picks: string[] = [];
    for (let k = 1; k <= 30; k++) {
      picks.push((await world.session("p2", k, undefined))?.strategy ?? "none");
      await world.hooks.afterAttempt?.(world.problem(), { attemptId: `att_p2_${k}`, prover: "p2", session: k } as unknown as FinishedAttempt);
    }
    // Beta(41, 1) against eleven flat arms wins 41/52 of the draws, about 79%; a flat arm would win 1/12.
    assert.ok(picks.filter((p) => p === "cases").length >= 18, picks.join(","));
  });

  it("repeats for a seed and gives a record of what it drew", async () => {
    const a = await setup({ widen: false, seed: 9 });
    const b = await setup({ widen: false, seed: 9 });
    const c = await setup({ widen: false, seed: 10 });
    const [x, y, z] = [await a.session("p1", 1, undefined), await b.session("p1", 1, undefined), await c.session("p1", 1, undefined)];
    assert.equal(x?.strategy, y?.strategy);
    const [record] = allocations(a.memory, a.claimId);
    assert.deepEqual([record?.data.rule, record?.data.strategy, record?.data.width, record?.data.waited, record?.data.attempts, record?.data.successRate], ["thompson", x?.strategy, 1, false, 0, 0.5]);
    assert.equal(Object.keys(record?.data.draws ?? {}).length, 12);
    assert.equal(record?.node.kind, "allocation");
    // Another seed draws another strategy for some prover and session.
    const others = await Promise.all([1, 2, 3, 4, 5, 6].map(async (k) => (await (await setup({ widen: false, seed: 100 + k })).session("p1", 1, undefined))?.strategy));
    assert.ok(new Set([z?.strategy, ...others]).size >= 3);
  });

  it("keeps a prover on its strategy while Lean gets further with it, and draws again when it does not", async () => {
    const world = await setup({ widen: false, seed: 1 });
    const first = await world.session("p1", 1, { outcome: "invalid", failureClass: "unsolved_goals", strategy: "automation" });
    const second = await world.session("p1", 2, { outcome: "invalid", failureClass: "unsolved_goals", strategy: "automation" });
    const third = await world.session("p1", 3, undefined);
    const rules = allocations(world.memory, world.claimId).map((a) => a.data.rule);
    assert.deepEqual(rules, ["thompson", "continued", "thompson"]);
    assert.equal(second?.strategy, first?.strategy, "the first session got to unsolved goals, which is further than nothing");
    assert.ok(third !== undefined);
    const off = await setup({ widen: false, seed: 1, stick: false });
    await off.session("p1", 1, { outcome: "invalid", failureClass: "unsolved_goals" });
    await off.session("p1", 2, undefined);
    assert.deepEqual(allocations(off.memory, off.claimId).map((a) => a.data.rule), ["thompson", "thompson"]);
  });

  it("is never a strategy that another prover is working on, until its session ends", async () => {
    // Every draw equal: the first candidate wins, so only the exclusion tells the provers apart.
    const world = await setup({ widen: false }, createFleet({ random: () => () => 0.5 }));
    const first = await world.session("p1", 1, undefined);
    const second = await world.session("p2", 1, undefined);
    const third = await world.session("p3", 1, undefined);
    assert.deepEqual([first?.strategy, second?.strategy, third?.strategy], ["induction", "cases", "contradiction"]);
    await world.hooks.afterAttempt?.(world.problem(), { attemptId: "att_p1_1", prover: "p1", session: 1 } as unknown as FinishedAttempt);
    assert.equal((await world.session("p4", 1, undefined))?.strategy, "induction");
  });

  it("tells no strategy when the option says so, and then decides nothing without models", async () => {
    const world = await setup({ widen: false, strategies: false });
    assert.equal(await world.session("p1", 1, undefined), undefined);
    assert.deepEqual(allocations(world.memory, world.claimId), []);
  });
});

describe("which model works", () => {
  const models = ["PROVIDER/WEAK", "PROVIDER/GOOD"];

  it("is drawn from the models' posteriors, so the one that proves is chosen more often", async () => {
    const world = await setup({ widen: false, strategies: false, models });
    // Two models' attempts on the claim: the weak one fails, the good one proves.
    for (let k = 1; k <= 8; k++) {
      for (const [model, outcome] of [[models[0], "invalid"], [models[1], "valid"]] as const) {
        const attemptId = `att_${model}_${k}`;
        world.journal.emit("attempt.started", { attemptId, claimId: world.claimId, prover: "p1", iteration: k, model: model as string }, "prover:p1");
        world.journal.emit(
          "attempt.finished",
          { attemptId, outcome, ...(outcome === "invalid" ? { failureClass: "syntax" } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
          "prover:p1",
        );
      }
    }
    const picks: string[] = [];
    for (let k = 1; k <= 30; k++) picks.push((await world.session("p9", k, undefined))?.model ?? "none");
    assert.ok(picks.filter((m) => m === models[1]).length >= 25, picks.join(","));
  });

  it("is one of the models given, and any when nothing is known", async () => {
    const world = await setup({ widen: false, strategies: false, models, seed: 5 });
    const picks = new Set<string | undefined>();
    for (let k = 1; k <= 20; k++) picks.add((await world.session("p1", k, undefined))?.model);
    assert.deepEqual([...picks].sort(), [...models].sort());
  });

  it("is the stronger model once the decision is hard, as many times as the cap allows", async () => {
    const world = await setup({ widen: false, strategies: false, escalateTo: "PROVIDER/STRONG", escalateAfter: 2, escalateBelow: 0.5, maxEscalations: 2 });
    const used: Array<string | undefined> = [];
    for (let k = 1; k <= 6; k++) used.push((await world.session("p1", k, { outcome: "invalid", failureClass: "unsolved_goals" }))?.model);
    // Two failures give a rate of 1/4; the third and fourth sessions are escalated, the cap ends it.
    assert.deepEqual(used, [undefined, undefined, "PROVIDER/STRONG", "PROVIDER/STRONG", undefined, undefined]);
    // Only the escalated sessions leave a record: the others decided nothing.
    assert.deepEqual(allocations(world.memory, world.claimId).map((a) => [a.data.session, a.data.escalated]), [[3, true], [4, true]]);
  });

  it("is refused for options that are not model names", async () => {
    const world = await setup({ models: ["not-a-model"] });
    await assert.rejects(world.session("p1", 1, undefined), /the option models must be a list of PROVIDER\/ID strings/);
    const other = await setup({ escalateTo: 3 });
    await assert.rejects(other.session("p1", 1, undefined), /the option escalateTo must be a PROVIDER\/ID string or null/);
  });
});

describe("the width of the work", () => {
  it("keeps a second prover waiting while the first one is alive and does well, and lets it in when the first ends", async () => {
    const world = await setup({ strategies: false, models: ["PROVIDER/A"] });
    await world.session("p1", 1, undefined);
    let second: unknown;
    const pending = world.hooks.beforeSession?.(world.context("p2", 1))?.then((d) => (second = d));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second, undefined, "p2 waits");
    await world.hooks.afterProver?.(world.problem(), { prover: "p1", stop: "sessions", attempts: 1 });
    await pending;
    assert.deepEqual(second, { model: "PROVIDER/A" });
    const [first, later] = allocations(world.memory, world.claimId);
    assert.deepEqual([first?.data.waited, later?.data.waited], [false, true]);
  });

  it("lets it in when the posterior gets low, without p1 ending, once the attempt that lowered it is in the memory", async () => {
    const world = await setup({ strategies: false, models: ["PROVIDER/A"], minAttempts: 1, widenBelow: 0.9 });
    await world.begin("p1", 1);
    let second: unknown;
    const pending = world.hooks.beforeSession?.(world.context("p2", 1))?.then((d) => (second = d));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second, undefined);
    // p1's session fails: the rate is 1/3, under 0.9, so the width is 3. The orchestrator runs `afterAttempt`
    // before it journals the attempt, so only p1's next session, which starts after that, can show p2 the attempt.
    await world.end("p1", 1, { outcome: "invalid", failureClass: "unsolved_goals" });
    await world.begin("p1", 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(second, { model: "PROVIDER/A" }, "p2 is let in on the posterior that holds p1's first attempt");
    await pending;
    assert.equal(allocations(world.memory, world.claimId).filter((a) => a.data.prover === "p2").at(-1)?.data.width, 3);
  });

  it("lets a waiting prover go when the problem ends, and the prover then starts nothing", async () => {
    const world = await setup({ strategies: false, models: ["PROVIDER/A"] });
    await world.session("p1", 1, undefined);
    const pending = world.hooks.beforeSession?.(world.context("p3", 1));
    await new Promise((resolve) => setImmediate(resolve));
    world.controller.abort();
    assert.equal(await pending, undefined);
  });

  it("does not wait when the option says so", async () => {
    const world = await setup({ widen: false, strategies: false, models: ["PROVIDER/A"] });
    await world.session("p1", 1, undefined);
    assert.deepEqual(await world.session("p2", 1, undefined), { model: "PROVIDER/A" });
    assert.deepEqual(await world.session("p3", 1, undefined), { model: "PROVIDER/A" });
  });
});

describe("the sessions of the fleet's provers", () => {
  it("share nothing but the memory: the assignment names a strategy and nothing of another prover", async () => {
    const world = await setup({ widen: false, seed: 2 });
    const first = await world.session("p1", 1, undefined);
    const second = await world.session("p2", 1, undefined);
    const section = await world.hooks.briefing?.(world.context("p2", 1));
    assert.equal(section?.title, "Strategy for this session");
    assert.match(section?.text ?? "", new RegExp(`: ${second?.strategy} \\(`));
    assert.doesNotMatch(section?.text ?? "", new RegExp(`\\b${first?.strategy}\\b`));
    assert.doesNotMatch(section?.text ?? "", /p1|other prover/i);
    assert.equal(await world.hooks.briefing?.(world.context("p2", 7)), undefined, "a session with no assignment gets no section");
  });
});

describe("a problem taken up again after the process ended", () => {
  const held = (fields: Partial<ResumedProblem>): ResumedProblem => ({ begun: true, attempts: [], endedProvers: [], modelCalls: {}, workedClaims: [], ...fields });

  it("keeps a prover on the strategy of its last session that was not cut, and ignores the allocation of one that was", async () => {
    const world = await setup({ widen: false, seed: 1 });
    const first = await world.session("p1", 1, { outcome: "invalid", failureClass: "unsolved_goals", strategy: "automation" });
    // The second session was allocated another strategy and cut: its allocation is in the journal, its work is not carried.
    world.memory.withActor("line:fleet").recordNode({
      kind: "allocation",
      claimId: world.claimId,
      data: { attemptId: "att_p1_2", prover: "p1", session: 2, strategy: first?.strategy === "cases" ? "induction" : "cases", rule: "thompson", width: 1, waited: false, successRate: 0.25, attempts: 1 },
    });
    const attempts = [
      { attemptId: "att_p1_1", prover: "p1", session: 1, claimId: world.claimId, interrupted: false },
      { attemptId: "att_p1_2", prover: "p1", session: 2, claimId: world.claimId, interrupted: true },
    ];
    const other = createFleet();
    await other.hooks.resumeProblem?.(world.problem(), held({ attempts }));
    const next = await other.hooks.beforeSession?.(world.context("p1", 3));
    assert.equal(next?.strategy, first?.strategy, "the strategy of the session that finished");
    assert.equal(allocations(world.memory, world.claimId).at(-1)?.data.rule, "continued");
  });

  it("counts the claims the process worked on in the models' posteriors, though it has not run a session on them yet", async () => {
    const models = ["PROVIDER/WEAK", "PROVIDER/GOOD"];
    /** A run whose other claim has the good model proving and the weak one failing; the picks of a new process for a claim that has no attempt of its own. */
    const picksAfter = async (workedClaims: (elsewhere: string) => string[]): Promise<string[]> => {
      const world = await setup({ widen: false, strategies: false, models });
      const { claimId: elsewhere } = await world.memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", origin: "test" });
      for (let k = 1; k <= 8; k++) {
        for (const [model, outcome] of [[models[0], "invalid"], [models[1], "valid"]] as const) {
          const attemptId = `att_${model}_${k}`;
          world.journal.emit("attempt.started", { attemptId, claimId: elsewhere, prover: "p1", iteration: k, model: model as string }, "prover:p1");
          world.journal.emit(
            "attempt.finished",
            { attemptId, outcome, ...(outcome === "invalid" ? { failureClass: "syntax" } : {}), stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 },
            "prover:p1",
          );
        }
      }
      const resumed = createFleet();
      await resumed.hooks.resumeProblem?.(world.problem(), held({ workedClaims: workedClaims(elsewhere) }));
      const picks: string[] = [];
      for (let k = 1; k <= 30; k++) picks.push((await resumed.hooks.beforeSession?.(world.context("p9", k)))?.model ?? "none");
      return picks;
    };
    const informed = await picksAfter((elsewhere) => [elsewhere]);
    assert.ok(informed.filter((m) => m === models[1]).length >= 25, informed.join(","));
    // Without it the new process knows no claim but the one it works on, and chooses at random.
    const blind = await picksAfter(() => []);
    assert.ok(blind.filter((m) => m === models[1]).length < 25, blind.join(","));
  });
});
