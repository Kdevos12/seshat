import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, type Json } from "@seshat/core";
import type { ProblemContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { CANDIDATE_KIND, type CandidateData, DEFAULT_PROMOTION, promoteCandidates } from "../src/index.ts";

describe("promotion and definitions that are not reviewed (LC5)", () => {
  it("settles a candidate whose statement uses one as unproved, and goes on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-library-unreviewed-"));
    const memory = new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
    memory.recordDefinition({ name: "SeshatLib.Foo.mulDiv", keyword: "def", buildId: "b", testLemmas: ["mulDiv_one"] });
    const data = (name: string, statement: string): CandidateData => ({ status: "pending", problemId: "p", claimId: "c", attemptId: "a", name, statement, proof: "omega", header: "import Mathlib" });
    const bad = memory.recordNode({ kind: CANDIDATE_KIND, data: data("aux_bad", "(n : ℕ) : SeshatLib.Foo.mulDiv n 1 = n") as unknown as Json });
    const problem = { problemId: "p", claimId: "c", domain: [], target: { theorem: "t" }, memory, signal: new AbortController().signal, log: () => {}, validate: async () => ({ verdict: "invalid", reasons: ["no"] }) } as unknown as ProblemContext;
    const result = await promoteCandidates(problem, async () => ({ trivial: false }), DEFAULT_PROMOTION);
    assert.equal(result.unproved, 1);
    const node = memory.node(bad.nodeId)?.data as CandidateData;
    assert.equal(node.status, "unproved");
    assert.match(node.reason ?? "", /cannot be a claim: .*mulDiv \(unreviewed\)/);
    assert.equal(memory.claims().length, 0);
  });
});
