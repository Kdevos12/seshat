import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allMagmas, integerBattery, programArgument, runPredicate, runProgram } from "../src/index.ts";

describe("predicates given as JavaScript programs", () => {
  it("runs an arrow function or a function expression on JSON arguments, in order", async () => {
    const run = await runPredicate("(n) => n % 2 === 0", [0, 1, 2, 3, 4]);
    assert.deepEqual(run.verdicts, [true, false, true, false, true]);
    assert.equal(run.stopped, undefined);
    const named = await runPredicate("function isBig(graph) { return graph.edges.length > 1; }", [{ n: 3, edges: [[0, 1]] }, { n: 3, edges: [[0, 1], [1, 2]] }]);
    assert.deepEqual(named.verdicts, [false, true]);
  });

  it("gives a battery's objects to the program as numbers, magmas and graphs", async () => {
    const evenDouble = await runProgram("(n) => (n * 2) % 4 === 0", integerBattery(5).objects);
    assert.deepEqual(evenDouble.verdicts, [true, false, true, false, true, false]);
    const commutative = `(m) => { for (let a = 0; a < m.size; a++) for (let b = 0; b < m.size; b++) if (m.table[a * m.size + b] !== m.table[b * m.size + a]) return false; return true; }`;
    const magmas = allMagmas(2);
    const run = await runProgram(commutative, magmas);
    assert.deepEqual(run.verdicts, magmas.map((m) => m.table[1] === m.table[2]));
    assert.deepEqual(programArgument(allMagmas(1)[0]!), { size: 1, table: [0] });
  });

  it("gives no verdict to a call that throws, loops or does not return a boolean, and goes on with the next", async () => {
    const run = await runPredicate(
      "(n) => { if (n === 1) throw new Error('boom'); if (n === 2) { while (true) {} } if (n === 3) return 1; if (n === 4) return undefined; return true; }",
      [0, 1, 2, 3, 4, 5],
      { callMs: 100 },
    );
    assert.deepEqual(run.verdicts, [true, null, null, null, null, true]);
    assert.deepEqual(run.notes, [undefined, "error: boom", "timeout (100 ms)", "not a boolean", "not a boolean", undefined]);
    assert.equal(run.stopped, undefined);
  });

  it("refuses a program that does not compile, an empty one, and one that is too long", async () => {
    const broken = await runPredicate("(n) => {", [1, 2]);
    assert.match(broken.stopped ?? "", /does not compile/);
    assert.deepEqual(broken.verdicts, [null, null]);
    assert.match(broken.notes[0] ?? "", /does not compile/);
    assert.match((await runPredicate("  ", [1])).stopped ?? "", /empty/);
    assert.match((await runPredicate(`(n) => n === ${"1".repeat(30_000)}`, [1])).stopped ?? "", /at most 20000/);
  });

  it("gives the program nothing of the process: no globals, no files, no code from strings", async () => {
    const probes = [
      "(n) => typeof process === 'undefined' && typeof require === 'undefined' && typeof globalThis.fetch === 'undefined'",
      "(n) => typeof setTimeout === 'undefined' && typeof Buffer === 'undefined' && typeof URL === 'undefined'",
      "(n) => [].constructor.constructor('return typeof process')() === 'undefined'",
      "(n) => (0, eval)('1 + 1') === 2",
      "(n) => new Function('return 1')() === 1",
    ];
    const runs = await Promise.all(probes.map((p) => runPredicate(p, [0])));
    assert.deepEqual(runs.map((r) => r.verdicts[0]), [true, true, null, null, null]);
    for (const run of runs.slice(2)) assert.match(run.notes[0] ?? "", /error: .*[Cc]ode generation/);
  });

  it("keeps the verdicts so far when the program fills the memory, and the run goes on to its end", async () => {
    const run = await runPredicate("(n) => { if (n === 2) { const a = new Array(2 ** 28).fill(1); return a.length > 0; } return true; }", [0, 1, 2, 3], { memoryMb: 64 });
    assert.deepEqual(run.verdicts, [true, true, null, null]);
    assert.match(run.stopped ?? "", /ended after 2 of 4 calls/);
    assert.match(run.notes[3] ?? "", /ended after 2 of 4 calls/);
  });

  it("stops a run that goes over its total time, and a run that is cancelled", async () => {
    const slow = await runPredicate("(n) => { if (n === 1) { while (true) {} } return true; }", [0, 1, 2], { callMs: 60_000, totalMs: 700 });
    assert.deepEqual(slow.verdicts, [true, null, null]);
    assert.match(slow.stopped ?? "", /went over its 700 ms/);
    const controller = new AbortController();
    const pending = runPredicate("(n) => { while (true) {} }", [0], { callMs: 60_000 }, controller.signal);
    setTimeout(() => controller.abort(), 400);
    assert.match((await pending).stopped ?? "", /cancelled/);
    assert.match((await runPredicate("(n) => true", [0], {}, AbortSignal.abort())).stopped ?? "", /cancelled/);
  });
});
