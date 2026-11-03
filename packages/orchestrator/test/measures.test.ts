import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { measureRun } from "../src/measures.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { check, demoRun } from "./m0-helpers.ts";

const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${String(a)} is not ${b}`);

describe("measureRun on a scripted journal", () => {
  const run = scriptedRun({
    lines: ["M1", "M10"],
    problems: [
      // Proved by a session that was shown a lesson, with a library lemma.
      { id: "p1", outcome: "proved", path: "A.lean", attempts: [{ strategy: "induction", outcome: "invalid", usd: 0.1 }, { strategy: "automation", outcome: "valid", usd: 0.2, included: ["lesson:1"], library: true, toolTokens: 300, turns: 4, inputTokens: 4000 }] },
      // Proved by a session with a schema shown and reused.
      { id: "p2", outcome: "candidate", path: "A.lean", attempts: [{ strategy: "automation", outcome: "valid", usd: 0.1, hint: { shown: true, reused: true }, toolTokens: 500, turns: 1, inputTokens: 1000 }] },
      // Settled by the battery, with no model.
      { id: "p3", outcome: "proved", path: "B.lean", settledBy: "line:M10" },
      // Nothing found.
      { id: "p4", outcome: "unsolved", path: "B.lean", attempts: [{ strategy: "induction", usd: 0.3 }] },
    ],
    claims: [
      { id: "sub1", origin: "line:M12", parentId: "p4", decomposedFrom: "p4", validBy: "line:M10", status: "computed" },
      { id: "sub2", origin: "line:M12", parentId: "p4", decomposedFrom: "p4" },
      { id: "conj1", origin: "line:M8", parentId: "p1", status: "computed", validBy: "line:M11", checkedTo: "p1" },
      { id: "conj2", origin: "line:M13", parentId: "p1" },
    ],
    toolRuns: [{ actor: "line:M10", capability: "lean.check", durationMs: 40 }, { actor: "line:M11", capability: "lean.check", durationMs: 2 }, { actor: "prover:p1", capability: "lean.check", durationMs: 900 }],
  });
  const m = measureRun(run.events);

  it("counts the problems and divides the costs by the problems with a Lean-checked proof", () => {
    assert.equal(m.problems, 4);
    assert.deepEqual(m.outcomes, { proved: 2, candidate: 1, unsolved: 1 });
    assert.equal(m.certified, 2);
    assert.equal(m.solved, 3);
    near(m.usd, 0.7);
    near(m.usdPerSolve, 0.7 / 3);
    near(m.tokensPerSolve, m.tokens / 3);
    assert.equal(m.attempts, 4);
  });

  it("reads the context and the tool declarations of the sessions", () => {
    // Input tokens over responses, for the sessions that made any: (1000 + 4000 + 1000 + 1000) / (2 + 4 + 1 + 2).
    near(m.meanContextTokens, 7000 / 9);
    near(m.toolDefinitionTokens, 400);
  });

  it("finds the proofs that used an element of the memory, by kind", () => {
    assert.deepEqual(m.memory.byKind, { lesson: 1, library: 1, schema: 1 });
    assert.equal(m.memory.count, 2);
    assert.equal(m.memory.total, 3);
    near(m.memory.share, 2 / 3);
    // p1 reuses a library lemma and p2 reuses a schema's shape.
    assert.equal(m.reuse.count, 2);
  });

  it("counts the subgoals and conjectures a program settled, and its time", () => {
    assert.deepEqual([m.modelFree.subgoals.count, m.modelFree.subgoals.total], [1, 2]);
    assert.deepEqual([m.modelFree.conjectures.count, m.modelFree.conjectures.total], [1, 2]);
    assert.equal(m.modelFree.cpuMs, 42, "the tool runs of M10 and M11, not the prover's");
  });

  it("measures the diversity of the proofs, and the proofs that go through an inductive hypothesis", () => {
    assert.equal(m.mechanisms.proofs, 3);
    assert.equal(m.mechanisms.strategies, 1, "automation, twice (the battery's proof has no label)");
    assert.equal(m.mechanisms.sources, 2, "the provers and the battery");
    assert.ok(m.mechanisms.entropyBits > 0);
    assert.deepEqual([m.inductive.count, m.inductive.total], [1, 3], "p1 is linked by a checked edge to a settled claim of M8");
  });

  it("splits the spend by site and keeps each problem for the split by difficulty", () => {
    assert.deepEqual(m.sites.map((s) => s.site), ["prover.session"]);
    assert.deepEqual(m.perProblem.map((p) => p.problemId), ["p1", "p2", "p3", "p4"]);
  });

  it("calls a strategy new when it had not been tried on the claim's file before, in order, after the earlier journals", () => {
    // A.lean: induction (new), automation (new), automation (not); B.lean: induction (new). New dollars: 0.1 + 0.2 + 0.3.
    near(m.novelStrategy.usd, 0.1 + 0.2 + 0.3);
    near(m.novelStrategy.totalUsd, 0.7);
    const earlier = scriptedRun({ problems: [{ id: "p1", outcome: "unsolved", path: "A.lean", attempts: [{ strategy: "induction", usd: 0.05 }] }] });
    const later = measureRun(run.events, { earlier: earlier.events });
    near(later.novelStrategy.usd, 0.2 + 0.3, "induction on A.lean is known from the earlier journal");
  });
});

describe("measureRun on a run with the simulated stack", () => {
  it("measures a plain run: one proof, its dollars, the context and the declarations of the session", async () => {
    const { events } = await demoRun({ responses: [check("exact trivial_proof")] });
    const m = measureRun(events);
    assert.equal(m.solved, 1);
    assert.equal(m.usdPerSolve, m.usd);
    assert.ok((m.meanContextTokens ?? 0) > 100);
    assert.ok((m.toolDefinitionTokens ?? 0) > 20, "lean_check is declared");
    assert.equal(m.memory.total, 1);
    assert.equal(m.memory.count, 0);
    assert.equal(m.redundancy, undefined, "no strategy label without the M1 line");
  });
});
