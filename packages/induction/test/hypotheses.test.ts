import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanChecker, LeanCheckResult, LeanSnippet } from "@seshat/core";
import type { Decide } from "@seshat/lines";
import { integerBattery } from "@seshat/models";
import { SimulatedDecide } from "../../models/test/simulated-lean.ts";
import {
  buildTable,
  cheapTactics,
  dependencyMatch,
  executeHypotheses,
  formalizeHypothesis,
  type Hypothesis,
  interestOf,
  prunePool,
  poolScore,
  proposeHypotheses,
  proposeHypothesisDag,
  recordHypothesisDag,
  relevanceOf,
  screenLeanText,
  statementProblem,
  testLemmas,
} from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

const battery = integerBattery(20, { min: 0 });
const ints = battery.objects.map((o) => (o.kind === "integer" ? o.value : 0));
const table = () => buildTable({ family: "integers", objects: ints, objectIds: ints.map(String), columns: [{ name: "n", program: "(n) => n" }, { name: "sq", program: "(n) => n * n" }] });

describe("the strict screen", () => {
  it("refuses forbidden tokens, commands and comment openers Lean may read, and accepts a signature", () => {
    assert.deepEqual(screenLeanText("(n : ℕ) : n + 0 = n"), []);
    assert.match(screenLeanText("(n : ℕ) : n = n #eval 1").join(), /'#'|#eval/);
    assert.match(screenLeanText("(n : ℕ) : n = n <-- note").join(), /--/);
    assert.match(screenLeanText("(n : ℕ) : n = n ∧ sorry").join(), /sorry/);
    assert.equal(statementProblem("(n : ℕ) : n + 0 = n"), undefined);
    assert.match(statementProblem("n + 0 = n") ?? "", /./);
    assert.match(statementProblem("") ?? "", /empty/);
    assert.match(statementProblem(`(n : ℕ) : ${"n = n ∧ ".repeat(600)}True`) ?? "", /4000/);
  });
});

describe("interest measures", () => {
  const n = 10;
  const evens = Array.from({ length: n }, (_, i) => i % 2 === 0);
  it("scores a sharp, supported, surprising hypothesis above a vacuous one", () => {
    const premise = Array.from({ length: n }, (_, i) => i >= 4);
    const conclusion = Array.from({ length: n }, (_, i) => i >= 4 || i === 1); // false outside the premise at most places
    const sharp = interestOf({ premise, conclusion }, [], [evens]);
    assert.equal(sharp.support, 6);
    assert.deepEqual(sharp.counterexamples, []);
    assert.ok(sharp.significance > 0.9);
    assert.equal(sharp.novelty, 1);
    assert.equal(sharp.vacuous, false);
    const vacuous = interestOf({ premise: Array.from({ length: n }, () => false), conclusion }, []);
    assert.equal(vacuous.vacuous, true);
    assert.equal(vacuous.nonVacuity, 0);
    assert.ok(sharp.score > vacuous.score);
  });

  it("gives no surprise to a conclusion that is true everywhere, or that one property restates", () => {
    const always = interestOf({ conclusion: Array.from({ length: n }, () => true) });
    assert.equal(always.surprise, 0);
    const restated = interestOf({ conclusion: evens }, [], [evens]);
    assert.equal(restated.surprise, 0);
    const unrelated = interestOf({ conclusion: evens }, [], [Array.from({ length: n }, (_, i) => i < 3)]);
    assert.ok(unrelated.surprise > 0.4);
  });

  it("is not novel when a known fact covers it, and has no significance with a counterexample", () => {
    const premise = Array.from({ length: n }, (_, i) => i >= 6);
    const conclusion = Array.from({ length: n }, (_, i) => i >= 4);
    const knownFact = { premise: Array.from({ length: n }, (_, i) => i >= 4), conclusion };
    assert.equal(interestOf({ premise, conclusion }, [knownFact]).novelty, 0);
    assert.equal(interestOf({ premise: Array.from({ length: n }, (_, i) => i >= 2), conclusion }, [knownFact]).novelty, 1);
    const broken = interestOf({ conclusion: evens });
    assert.deepEqual(broken.counterexamples, [1, 3, 5, 7, 9]);
    assert.equal(broken.significance, 0);
  });
});

describe("hypotheses a model proposes", () => {
  const answer = {
    hypotheses: [
      { id: "square_grows", level: "observation", informal: "n <= n^2", conclusion: "(n) => n <= n * n", uses: ["n", "sq", "ghost"] },
      { id: "squares_even", level: "pattern", informal: "an even number has an even square", premise: "(n) => n % 2 === 0", conclusion: "(n) => (n * n) % 2 === 0", statement: "(n : ℕ) (h : n % 2 = 0) : (n * n) % 2 = 0", uses: ["n"] },
      { id: "bad_claim", level: "pattern", informal: "all squares are even", conclusion: "(n) => (n * n) % 2 === 0", statement: "(n : ℕ) : (n * n) % 2 = 0 #eval 1", uses: [] },
      { id: "squares_even", level: "pattern", informal: "again", conclusion: "(n) => true", uses: [] },
    ],
  };

  it("are proposed, with the strict screen on the Lean text and dependencies on known columns only", async () => {
    const llm = scriptedLlm([answer]);
    const t = await table();
    const got = await proposeHypotheses(llm, { target: "(n : ℕ) : n ≤ n * n", table: t, count: 10, round: 1, known: ["n + 0 = n"] });
    assert.equal(llm.requests[0]?.site, "induction.hypotheses");
    assert.match(llm.requests[0]?.prompt ?? "", /Round 1/);
    assert.match(llm.requests[0]?.prompt ?? "", /Facts already established[\s\S]*n \+ 0 = n/);
    assert.match(llm.requests[0]?.system ?? "", /Be truthful/);
    assert.deepEqual(got.hypotheses.map((h) => h.id), ["square_grows", "squares_even", "bad_claim"]);
    assert.deepEqual(got.hypotheses[0]?.uses, ["n", "sq"]);
    assert.equal(got.hypotheses[2]?.statement, undefined, "the statement with #eval is dropped; the hypothesis stays informal");
    assert.ok(got.refused.some((r) => /bad_claim: statement refused/.test(r)));
    assert.ok(got.refused.some((r) => /squares_even: the id is used twice/.test(r)));
  });

  it("are run on the data in the sandbox: a hypothesis with a counterexample is dropped with the objects that break it", async () => {
    const t = await table();
    const hyps: Hypothesis[] = [
      { id: "ok", level: "pattern", informal: "", premise: "(n) => n % 2 === 0", conclusion: "(n) => (n * n) % 2 === 0", uses: [] },
      { id: "bad", level: "pattern", informal: "", conclusion: "(n) => (n * n) % 2 === 0", uses: [] },
      { id: "broken", level: "pattern", informal: "", conclusion: "(n) => n.nope.x", uses: [] },
    ];
    const [ok, bad, broken] = await executeHypotheses(t, hyps);
    assert.deepEqual(ok?.counterexamples, []);
    assert.deepEqual(bad?.counterexamples.slice(0, 3), [1, 3, 5]);
    assert.ok(broken?.conclusion.every((v) => v === null));
  });
});

describe("informal hypotheses", () => {
  const hypothesis: Hypothesis = { id: "h", level: "structure", informal: "the sum of the first n odd numbers is n squared", conclusion: "(n) => true", uses: [] };
  const dag = { proof: "induction", steps: [{ id: "s1", statement: "the n-th odd number is 2n-1", dependsOn: [] }, { id: "s2", statement: "the sum is n squared", dependsOn: ["s1"] }] };

  it("go through the step DAG: checked, and sent back once when it does not check", async () => {
    const bad = { proof: "x", steps: [{ id: "s1", statement: "a", dependsOn: ["s2"] }, { id: "s2", statement: "b", dependsOn: [] }] };
    const llm = scriptedLlm([bad, dag]);
    const got = await proposeHypothesisDag(llm, hypothesis, "T");
    assert.deepEqual(got.dag?.steps.map((s) => s.id), ["s1", "s2"]);
    assert.equal(llm.requests.length, 2);
    assert.match(llm.requests[1]?.prompt ?? "", /previous DAG was refused/);
    assert.equal(llm.requests[0]?.site, "induction.dag");
    const failing = await proposeHypothesisDag(scriptedLlm([bad]), hypothesis, "T");
    assert.equal(failing.dag, undefined);
    assert.match(failing.problems.join(), /forward reference|cycle/);
  });

  it("are recorded as informal claims with decomposes_into proposals and a stamped node, and no status moves", async () => {
    const memory = openMemory();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n ≤ n * n", origin: "bench:t" });
    const recorded = await recordHypothesisDag(memory, claimId, "h", dag);
    assert.deepEqual(Object.keys(recorded.claims), ["s1", "s2"]);
    assert.ok(Object.values(recorded.claims).every((id) => memory.claim(id)?.status === "open" && memory.claim(id)?.kind === "informal" && memory.claim(id)?.origin === "line:M8"));
    assert.deepEqual(memory.edges({ from: recorded.claims.s2 as string }).map((e) => [e.kind, e.status]), [["decomposes_into", "proposed"]]);
    assert.ok(memory.node(recorded.nodeId)?.provenance !== undefined);
    await recordHypothesisDag(memory, claimId, "h", dag);
    assert.equal(memory.edges({ kinds: ["decomposes_into"] }).length, 2, "the edges are not added twice");
  });

  it("measure the dependency match of the formalization against the DAG", () => {
    const good = "lemma aux_s1 : True := trivial\nlemma aux_s2 : True := by exact aux_s1\n";
    assert.deepEqual(dependencyMatch(dag, good), { score: 1, declared: 1, found: 1 });
    const missing = "lemma aux_s1 : True := trivial\nlemma aux_s2 : True := trivial\n";
    assert.equal(dependencyMatch(dag, missing).score, 0);
    const wrong = "lemma aux_s1 : True := by exact aux_s2\nlemma aux_s2 : True := trivial\n";
    assert.equal(dependencyMatch(dag, wrong).score, 0);
  });

  it("are formalized into a statement, screened", async () => {
    const ok = await formalizeHypothesis(scriptedLlm([{ statement: "(n : ℕ) : n ≤ n * n" }]), hypothesis, "T", "import Mathlib");
    assert.equal(ok.statement, "(n : ℕ) : n ≤ n * n");
    const refused = await formalizeHypothesis(scriptedLlm([{ statement: "(n : ℕ) : n ≤ n * n #eval 1" }]), hypothesis, "T", "import Mathlib");
    assert.equal(refused.statement, undefined);
    assert.match(refused.problem ?? "", /./);
  });
});

describe("test lemmas and triviality", () => {
  it("tries a statement about a number on its first cases in Lean, and drops one Lean refutes", async () => {
    const lean = new SimulatedDecide({ truth: (instance) => (instance.kind === "nat" && instance.value !== 3) });
    const failed = await testLemmas(lean, "import Mathlib", "(n : ℕ) : n ≠ 3", 8);
    assert.equal(failed.result, "failed");
    assert.equal(failed.failedAt, 3);
    const all = await testLemmas(new SimulatedDecide({ truth: () => true }), "import Mathlib", "(n : ℕ) : n < n + 1", 8);
    assert.deepEqual([all.result, all.tried], ["passed", 8]);
    const skipped = await testLemmas(new SimulatedDecide({ truth: () => true }), "import Mathlib", "(G : Type) [Group G] : True", 8);
    assert.equal(skipped.result, "skipped");
  });

  it("call a statement trivial when the cheap tactics close it, and not when Lean does not accept the file", async () => {
    const seen: string[] = [];
    const checker = (accept: boolean): LeanChecker => ({
      implementation: "t",
      version: "0",
      check: async (snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> => {
        seen.push(...snippets.map((s) => s.code));
        return snippets.map((s) => ({ id: s.id, status: accept ? "valid" : "lean_error", messages: [], sorries: [], timeMs: 1 }));
      },
    });
    assert.deepEqual(await cheapTactics(checker(true))("(n : ℕ) : n + 0 = n", "import Mathlib"), { trivial: true, by: "rfl | decide | omega | simp | norm_num" });
    assert.deepEqual(await cheapTactics(checker(false))("(n : ℕ) : n + 0 = n", "import Mathlib"), { trivial: false });
    assert.match(seen[0] ?? "", /theorem induction_triviality_probe \(n : ℕ\) : n \+ 0 = n := by\n  first \| rfl/);
    // A statement the screen refuses never reaches the file.
    const before = seen.length;
    assert.deepEqual(await cheapTactics(checker(true))("(n : ℕ) : n = n #eval 1", "import Mathlib"), { trivial: false });
    assert.equal(seen.length, before);
  });
});

describe("the conjecture pool", () => {
  it("asks decide for a Score on the statement alone, and judge when decide is absent or off", async () => {
    const asked: unknown[] = [];
    const decide = { backendFor: () => "llm", decide: async (r: unknown) => (asked.push(r), { answer: "useful", probabilities: {}, expected: 2, backend: "llm", requested: "llm", model: "m", costUsd: 0, decisionId: "d", replayed: false }) } as unknown as Decide;
    const llm = scriptedLlm([{ score: 0.9 }]);
    const viaDecide = await relevanceOf({ decide, llm }, "T", "(n : ℕ) : n < n + 1");
    assert.deepEqual([viaDecide.via, viaDecide.value.toFixed(2)], ["decide", "0.67"]);
    const request = asked[0] as { site: string; state: string; use: string; question: { type: string; levels: string[] } };
    assert.deepEqual([request.site, request.state, request.use, request.question.type, request.question.levels.length], ["conjecture.relevance", "(n : ℕ) : n < n + 1", "order", "score", 4]);
    assert.equal(llm.requests.length, 0);
    const off = { ...decide, backendFor: () => "off" } as unknown as Decide;
    const viaJudge = await relevanceOf({ decide: off, llm }, "T", "(n : ℕ) : n < n + 1");
    assert.deepEqual([viaJudge.via, viaJudge.value], ["judge", 0.9]);
    assert.equal(llm.requests[0]?.site, "conjecture.relevance");
    const none = await relevanceOf({ llm: scriptedLlm([{ score: 0.2 }]) }, "T", "x");
    assert.equal(none.via, "judge");
  });

  it("falls back to judge when decide fails, and lets an interruption through", async () => {
    const failing = { backendFor: () => "llm", decide: async () => { throw new Error("down"); } } as unknown as Decide;
    const got = await relevanceOf({ decide: failing, llm: scriptedLlm([{ score: 0.5 }]) }, "T", "x");
    assert.equal(got.via, "judge");
    const { InterruptedError } = await import("@seshat/lines");
    const interrupted = { backendFor: () => "llm", decide: async () => { throw new InterruptedError("turn over"); } } as unknown as Decide;
    await assert.rejects(relevanceOf({ decide: interrupted, llm: scriptedLlm([{ score: 0.5 }]) }, "T", "x"), /turn over/);
  });

  it("scores by relevance, interest and proof rate, and prunes the irrelevant, the short-proved and the surplus", () => {
    const e = (claimId: string, relevance: number, extra: Partial<Parameters<typeof poolScore>[0]> = {}) => ({ claimId, statement: claimId, relevance, interest: 0.5, attempts: 0, proved: 0, ...extra });
    assert.ok(poolScore(e("a", 1)) > poolScore(e("b", 0.5)));
    assert.ok(poolScore(e("c", 0.5, { attempts: 4, proved: 4 })) > poolScore(e("d", 0.5, { attempts: 4, proved: 0 })));
    const { kept, pruned } = prunePool([e("low", 0.1), e("short", 0.9, { proofChars: 10, proved: 1, attempts: 1 }), e("x1", 0.9), e("x2", 0.8), e("x3", 0.7)], { keep: 2 });
    assert.deepEqual(kept.map((k) => k.claimId), ["x1", "x2"]);
    assert.deepEqual(pruned.map((p) => p.entry.claimId).sort(), ["low", "short", "x3"]);
    assert.match(pruned.find((p) => p.entry.claimId === "short")?.reason ?? "", /10 characters/);
  });
});
