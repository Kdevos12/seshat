import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Gate, posteriorOf, shouldEscalate, widthFor, type WidthOptions } from "../src/index.ts";
import { failedAt, proved } from "./helpers.ts";

const options: WidthOptions = { widenBelow: 0.3, minAttempts: 2, maxWidth: 4, maxWidthProblem: 8 };
const failures = (n: number) => Array.from({ length: n }, () => failedAt("unsolved_goals", "induction"));

describe("the width of a subgoal", () => {
  it("is 1 while a single agent does well, or little is known", () => {
    assert.equal(widthFor(posteriorOf([], 0.5), options), 1);
    assert.equal(widthFor(posteriorOf(failures(1), 0.5), options), 1, "one attempt is not evidence");
    assert.equal(widthFor(posteriorOf([proved(), ...failures(1)], 0.5), options), 1, "a rate of 1/2 is not low");
  });

  it("grows as the single-agent posterior gets lower, up to the cap of the subgoal", () => {
    // After n failures the rate is 1 / (n + 2): 2 failures give 0.25, 6 give 0.125, 14 give 0.0625.
    assert.deepEqual([2, 3, 6, 10, 14, 30, 100].map((n) => widthFor(posteriorOf(failures(n), 0.5), options)), [2, 2, 3, 3, 4, 4, 4]);
    assert.equal(widthFor(posteriorOf(failures(100), 0.5), { ...options, maxWidth: 2 }), 2);
    assert.equal(widthFor(posteriorOf(failures(100), 0.5), { ...options, maxWidthProblem: 3 }), 3, "the cap of the problem bounds it too");
    assert.equal(widthFor(posteriorOf(failures(100), 0.5), { ...options, maxWidth: 0 }), 1);
  });

  it("falls back to 1 when the rate recovers", () => {
    assert.equal(widthFor(posteriorOf([...failures(6), proved(), proved(), proved()], 0.5), options), 1);
  });
});

describe("the gate", () => {
  const live = () => new AbortController();

  it("admits the lowest alive prover at once, and keeps the others for the width", async () => {
    const gate = new Gate();
    const { signal } = live();
    assert.deepEqual(await gate.admit("p1", "g", { width: () => 1, cap: 8, signal }), { admitted: true, waited: false, width: 1 });
    let second: unknown;
    const waiting = gate.admit("p2", "g", { width: () => 1, cap: 8, signal }).then((r) => (second = r));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second, undefined);
    assert.equal(gate.waiting, 1);
    gate.ended("p1");
    await waiting;
    assert.deepEqual(second, { admitted: true, waited: true, width: 1 });
    assert.equal(gate.waiting, 0);
  });

  it("lets a prover in when the width grows, after the gate is woken", async () => {
    const gate = new Gate();
    const { signal } = live();
    let width = 1;
    await gate.admit("p1", "g", { width: () => width, cap: 8, signal });
    const results: unknown[] = [];
    const waiting = [2, 3, 4].map((n) => gate.admit(`p${n}`, "g", { width: () => width, cap: 8, signal }).then((r) => results.push([n, r.admitted, r.width])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(results, []);
    width = 2;
    gate.wake();
    await new Promise((resolve) => setImmediate(resolve));
    // p2 has one prover ahead of it and a width of 2; p3 and p4 have more ahead.
    assert.deepEqual(results, [[2, true, 2]]);
    width = 3;
    gate.wake();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(results, [[2, true, 2], [3, true, 3]]);
    gate.ended("p1");
    await Promise.all(waiting);
    assert.deepEqual(results.at(-1), [4, true, 3]);
  });

  it("holds the provers of the problem to its cap, whatever the width", async () => {
    const gate = new Gate();
    const { signal } = live();
    assert.equal(gate.allowed("p1", "g", 5, 2), true);
    await gate.admit("p1", "g", { width: () => 5, cap: 2, signal });
    await gate.admit("p2", "g", { width: () => 5, cap: 2, signal });
    assert.equal(gate.allowed("p3", "g", 5, 2), false);
    gate.ended("p1");
    assert.equal(gate.allowed("p3", "g", 5, 2), true);
  });

  it("counts the provers of a subgoal against its width only, and those that have not said which one against all", async () => {
    const gate = new Gate();
    const { signal } = live();
    await gate.admit("p1", "A", { width: () => 1, cap: 8, signal });
    await gate.admit("p2", "B", { width: () => 1, cap: 8, signal });
    assert.equal(gate.allowed("p3", "A", 1, 8), false);
    assert.equal(gate.allowed("p3", "B", 1, 8), false);
    assert.equal(gate.allowed("p3", "C", 1, 8), true);
    // p4 sees p3, which has not started a session, as possibly on its own subgoal.
    assert.equal(gate.allowed("p4", "C", 1, 8), false);
  });

  it("frees every waiter when the problem ends", async () => {
    const gate = new Gate();
    const controller = new AbortController();
    await gate.admit("p1", "g", { width: () => 1, cap: 8, signal: controller.signal });
    const waiting = Promise.all([2, 3].map((n) => gate.admit(`p${n}`, "g", { width: () => 1, cap: 8, signal: controller.signal })));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.deepEqual((await waiting).map((r) => [r.admitted, r.waited]), [[false, true], [false, true]]);
    assert.equal(gate.waiting, 0);
    assert.equal((await gate.admit("p5", "g", { width: () => 1, cap: 8, signal: controller.signal })).admitted, false);
  });

  it("never keeps the lowest alive prover waiting, whoever has ended", async () => {
    const gate = new Gate();
    const { signal } = live();
    gate.ended("p1");
    gate.ended("p2");
    assert.equal((await gate.admit("p3", "g", { width: () => 1, cap: 1, signal })).waited, false);
  });

  it("does not gate a prover that is not named p<number>", async () => {
    const gate = new Gate();
    assert.equal(Gate.index("p12"), 12);
    assert.equal(Gate.index("prover-x"), undefined);
    assert.equal((await gate.admit("prover-x", "g", { width: () => 1, cap: 1, signal: live().signal })).admitted, true);
  });
});

describe("escalation", () => {
  const to = { escalateTo: "PROVIDER/STRONG", after: 3, below: 0.25, max: 2 };

  it("escalates a decision that is hard: enough attempts, a low rate, escalations left", () => {
    // After 3 failures the rate is 1/5, under 0.25; after 2 it is 1/4, which is not.
    assert.equal(shouldEscalate(posteriorOf(failures(3), 0.5), 0, to), true);
    assert.equal(shouldEscalate(posteriorOf(failures(2), 0.5), 0, to), false);
    assert.equal(shouldEscalate(posteriorOf([...failures(3), proved(), proved()], 0.5), 0, to), false, "the rate recovered");
  });

  it("stops at the cap, and without a stronger model", () => {
    assert.equal(shouldEscalate(posteriorOf(failures(5), 0.5), 1, to), true);
    assert.equal(shouldEscalate(posteriorOf(failures(5), 0.5), 2, to), false);
    assert.equal(shouldEscalate(posteriorOf(failures(5), 0.5), 0, { ...to, escalateTo: null }), false);
  });
});
