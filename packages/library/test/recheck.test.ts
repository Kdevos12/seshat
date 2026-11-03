import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { ProblemContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { allLemmas, recheckLibrary, usableLemmas } from "../src/index.ts";
import { library } from "./helpers.ts";

describe("compiling the library again when the Mathlib revision changes (PE1)", () => {
  it("checks each lemma as a file of its own, and stops offering one that no longer compiles", async () => {
    const { memory, problem, asked } = await library("rev-b");
    assert.equal(usableLemmas(memory).length, 0, "under a new revision nothing is offered before it is compiled again");
    const result = await recheckLibrary(problem, { maxRecheck: 10 });
    assert.deepEqual(result, { rev: "rev-b", compiled: 1, stale: 1 });
    assert.equal(asked.length, 2);
    assert.match(asked[0] ?? "", /^import Mathlib\n\ntheorem aux_lib_good_000000 \(n : ℕ\) : n \+ 0 = n \+ 0 := by\n {2}omega\n$/);
    assert.deepEqual(usableLemmas(memory).map((l) => l.name), ["aux_lib_good_000000"]);
    assert.deepEqual(allLemmas(memory).map((l) => [l.checkedRev, l.stale]), [["rev-b", false], ["rev-b", true]]);
    // The revision is recorded: a second call has nothing due and asks Lean nothing.
    assert.equal(await recheckLibrary(problem, { maxRecheck: 10 }), undefined);
    assert.equal(asked.length, 2);
  });

  it("does nothing under the revision the lemmas were compiled with, and compiles at most the limit", async () => {
    const same = await library("rev-a");
    assert.equal(await recheckLibrary(same.problem, { maxRecheck: 10 }), undefined);
    assert.equal(same.asked.length, 0);
    const limited = await library("rev-b");
    assert.deepEqual(await recheckLibrary(limited.problem, { maxRecheck: 1 }), { rev: "rev-b", compiled: 1, stale: 0 });
    assert.deepEqual(usableLemmas(limited.memory).map((l) => l.name), ["aux_lib_good_000000"], "the lemma beyond the limit waits, unoffered");
    assert.deepEqual(await recheckLibrary(limited.problem, { maxRecheck: 1 }), { rev: "rev-b", compiled: 0, stale: 1 }, "the next call takes the next one");
  });

  it("leaves a lemma to the next call when Lean did not answer", async () => {
    const { memory, problem } = await library("rev-b");
    (problem.registry as unknown as { invoke: unknown }).invoke = async (_id: string, input: { snippets: Array<{ id: string }> }) => ({ output: { results: input.snippets.map((s) => ({ id: s.id, status: "server_error" })) } });
    assert.deepEqual(await recheckLibrary(problem, { maxRecheck: 10 }), { rev: "rev-b", compiled: 0, stale: 0 });
    assert.equal(usableLemmas(memory).length, 0, "a lemma Lean did not answer for is not offered");
    assert.deepEqual(allLemmas(memory).map((l) => l.checkedRev), [undefined, undefined]);
  });

  it("does not throw when Lean cannot be reached, and offers nothing until it can", async () => {
    const { memory, problem } = await library("rev-b");
    const logs: string[] = [];
    (problem as unknown as { log: (t: string) => void }).log = (t) => logs.push(t);
    (problem.registry as unknown as { invoke: unknown }).invoke = async () => {
      throw new Error("the Lean server is down");
    };
    assert.deepEqual(await recheckLibrary(problem, { maxRecheck: 10 }), { rev: "rev-b", compiled: 0, stale: 0 });
    assert.match(logs[0] ?? "", /2 lemma\(s\) could not be compiled again under revision rev-b, so they are not offered yet: the Lean server is down/);
    assert.equal(usableLemmas(memory).length, 0);
  });

  it("does nothing without a provenance context", async () => {
    const { problem } = await library("rev-b");
    const bare = new MemoryStore({ journal: Journal.open(mkdtempSync(join(tmpdir(), "mh-library-")), "run_2"), blobs: new BlobStore(join(tmpdir(), "mh-none")) });
    assert.equal(await recheckLibrary({ ...problem, memory: bare } as ProblemContext, { maxRecheck: 10 }), undefined);
  });
});
