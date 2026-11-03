import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { booleans, numbers, runValues } from "../src/index.ts";

describe("the sandbox for programs", () => {
  it("returns the JSON value of a function expression on each argument", async () => {
    const run = await runValues("(n) => ({ square: n * n, even: n % 2 === 0 })", [1, 2, 3]);
    assert.equal(run.stopped, undefined);
    assert.deepEqual(run.values, [{ square: 1, even: false }, { square: 4, even: true }, { square: 9, even: false }]);
    assert.deepEqual(numbers(await runValues("function (n) { return n + 0.5; }", [1, 2])), [1.5, 2.5]);
    assert.deepEqual(booleans(await runValues("(n) => n > 1", [1, 2])), [false, true]);
  });

  it("gives no value, with the reason, for a call that throws, loops, or returns what JSON cannot hold; the next call goes on", async () => {
    const run = await runValues("(n) => { if (n === 0) throw new Error('boom'); if (n === 1) { while (true) {} } if (n === 2) return undefined; if (n === 3) return 'x'.repeat(50); return n; }", [0, 1, 2, 3, 4], { callMs: 150, maxBytes: 20 });
    assert.deepEqual(run.values, [undefined, undefined, undefined, undefined, 4]);
    assert.match(run.notes[0] ?? "", /error: boom/);
    assert.match(run.notes[1] ?? "", /timeout \(150 ms\)/);
    assert.equal(run.notes[2], "no value");
    assert.match(run.notes[3] ?? "", /value over 20 characters/);
    assert.equal(run.stopped, undefined);
  });

  it("does not run the toString of a thrown object outside the time limit", async () => {
    const started = Date.now();
    const run = await runValues("(n) => { if (n === 1) throw { toString() { for (;;); } }; if (n === 2) throw { message: { toString() { for (;;); } } }; return n; }", [1, 2, 3], { callMs: 200, totalMs: 10_000 });
    assert.ok(Date.now() - started < 5000, "the child was not held until the total time");
    assert.equal(run.values[2], 3, "the later argument still has its value");
  });

  it("refuses a program that does not compile, an empty one and one over the length limit", async () => {
    assert.match((await runValues("(n) =>", [1])).stopped ?? "", /does not compile/);
    assert.match((await runValues("   ", [1])).stopped ?? "", /empty/);
    assert.match((await runValues(`(n) => ${"1 + ".repeat(6000)}1`, [1])).stopped ?? "", /at most 20000/);
    assert.deepEqual((await runValues("(n) => n", [])).values, []);
  });

  it("kills a run that goes over its total time, and keeps the values it had given", async () => {
    const run = await runValues("(n) => { if (n > 1) { for (;;) {} } return n; }", [1, 2, 3], { callMs: 60_000, totalMs: 1500 });
    assert.match(run.stopped ?? "", /went over its 1500 ms/);
    assert.deepEqual(run.values, [1, undefined, undefined]);
  });

  it("stops a program that fills the heap, and one that fills memory the heap limit does not count", async () => {
    const heap = await runValues("(n) => { const a = []; for (;;) a.push(new Array(100000).fill(n)); }", [1], { memoryMb: 48, callMs: 20_000, totalMs: 20_000 });
    assert.ok(heap.stopped !== undefined && heap.values[0] === undefined, heap.stopped);
    if (existsSync("/proc/self/statm")) {
      // A typed array's buffer is outside the V8 heap: only the resident-memory watcher sees it.
      const buffers = await runValues("(n) => { const keep = []; for (;;) { const b = new Uint8Array(32 * 1024 * 1024); b.fill(1); keep.push(b); } }", [1], { rssMb: 300, callMs: 20_000, totalMs: 20_000 });
      assert.match(buffers.stopped ?? "", /went over 300 MB of memory|ran out of memory|killed|SIGKILL/);
    }
  });

  it("gives the program nothing of this process: no require, process, fetch or eval, and a seeded Math.random", async () => {
    const run = await runValues(
      "(n) => [typeof require, typeof process, typeof fetch, typeof globalThis.constructor.constructor, (() => { try { return eval('1'); } catch (e) { return 'no eval'; } })(), (() => { try { return new Function('return 1')(); } catch (e) { return 'no Function'; } })()]",
      [0],
    );
    assert.deepEqual(run.values[0], ["undefined", "undefined", "undefined", "function", "no eval", "no Function"]);
    const draws = await runValues("(n) => [Math.random(), Math.random()]", [0, 0], { seed: 7 });
    const again = await runValues("(n) => [Math.random(), Math.random()]", [0, 0], { seed: 7 });
    const other = await runValues("(n) => [Math.random(), Math.random()]", [0, 0], { seed: 8 });
    assert.deepEqual(draws.values, again.values);
    assert.notDeepEqual(draws.values, other.values);
  });

  it("runs with an empty environment and a scratch directory that is removed, and cannot read or write files", async () => {
    process.env.SESHAT_SECRET_FOR_TEST = "hunter2";
    // A private temporary directory, so that tests running beside this one cannot add scratch directories to the listing.
    const outer = process.env.TMPDIR;
    const own = mkdtempSync(join(tmpdir(), "own-"));
    process.env.TMPDIR = own;
    try {
      const run = await runValues("(n) => typeof process === 'undefined' ? 'no process' : 'process'", [0]);
      assert.deepEqual(run.values, ["no process"]);
      assert.deepEqual(readdirSync(own), [], "the scratch directory is gone");
    } finally {
      delete process.env.SESHAT_SECRET_FOR_TEST;
      if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer;
    }
  });

  it("stops when it is cancelled", async () => {
    const controller = new AbortController();
    const running = runValues("(n) => { for (;;) {} }", [1], { callMs: 60_000, totalMs: 60_000 }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    assert.match((await running).stopped ?? "", /cancelled/);
    assert.match((await runValues("(n) => n", [1], {}, controller.signal)).stopped ?? "", /cancelled/);
  });
});
