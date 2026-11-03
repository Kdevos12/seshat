import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seeded } from "@seshat/core";
import type { Line, ProblemContext, SessionContext, TaskInfo, ValidateRequest, ValidateResult } from "@seshat/lines";
import {
  admitCounterexample,
  buildPrompt,
  cegisCounter,
  createM16,
  declareSearch,
  fillTemplate,
  leanTerm,
  M16_OPTIONS,
  makeScorer,
  ProgramDatabase,
  readCounterexamples,
  readM16Options,
  SEARCH_PROGRAM_KIND,
  SEARCH_RESULT_KIND,
  type SearchSpec,
} from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

const spec: SearchSpec = {
  description: "four distinct digits whose sum is as large as possible",
  signature: "(n) => an array of n distinct integers from 0 to 9",
  inputs: [4],
  score: "({input, output}) => Array.isArray(output) && output.length === input && new Set(output).size === input && output.every((v) => Number.isInteger(v) && v >= 0 && v <= 9) ? output.reduce((a, b) => a + b, 0) : null",
  target: 30,
  seeds: ["(n) => Array.from({length: n}, (_, i) => i)"],
  statement: "(w : List ℕ) (h : w = {witness}) : w.sum = 30",
  proof: "subst h; decide",
};
const limits = { callMs: 150, totalMs: 4000 };

describe("the program database", () => {
  const options = { temperature: 0.5, lengthBias: 1, clusterSize: 2 };
  const make = () => {
    const db = new ProgramDatabase(4, options);
    [[0, 1, "(n) => 1"], [0, 5, "(n) => 55555"], [1, 3, "(n) => 3"], [2, 9, "(n) => 9"], [2, 9, "(n) => 99"], [3, 2, "(n) => 2"]].forEach(([island, score, code]) =>
      db.add({ code: code as string, signature: [score as number], score: score as number, round: 0, island: island as number }),
    );
    return db;
  };

  it("clusters programs by their score signature, keeps the shortest of a cluster, and refuses a duplicate", () => {
    const db = make();
    assert.equal(db.islands[2]?.length, 1);
    assert.deepEqual(db.islands[2]?.[0]?.programs.map((p) => p.code), ["(n) => 9", "(n) => 99"]);
    assert.equal(db.add({ code: "(n) => 9", signature: [9], score: 9, round: 1, island: 2 }), false);
    db.add({ code: "(n) => 999", signature: [9], score: 9, round: 1, island: 2 });
    assert.equal(db.islands[2]?.[0]?.programs.length, 2, "at most clusterSize");
    assert.equal(db.best()?.score, 9);
  });

  it("samples with a seeded source, the same draws for the same seed, sorted by score, favoring high scores and short programs", () => {
    const draws = (seed: number) => {
      const db = make();
      const r = seeded(seed);
      return Array.from({ length: 40 }, () => db.sample(2, r));
    };
    assert.deepEqual(draws(7), draws(7));
    assert.notDeepEqual(draws(7), draws(8));
    for (const d of draws(7)) {
      assert.ok(d !== undefined);
      for (let i = 1; i < d.programs.length; i++) assert.ok((d.programs[i - 1]?.score ?? 0) <= (d.programs[i]?.score ?? 0));
    }
    // One island with a cluster of score 1 and one of score 5: the better cluster is drawn most of the time, not always.
    const one = new ProgramDatabase(1, options);
    one.add({ code: "(n) => 1", signature: [1], score: 1, round: 0, island: 0 });
    one.add({ code: "(n) => 55555", signature: [5], score: 5, round: 0, island: 0 });
    const r = seeded(3);
    const top = Array.from({ length: 400 }, () => one.sample(1, r)?.programs[0]?.score).filter((x) => x === 5).length;
    assert.ok(top > 300 && top < 400, `drawn ${top} times of 400`);
    // In one cluster, the shorter program is drawn more often than the longer.
    const cluster = new ProgramDatabase(1, { ...options, clusterSize: 4 });
    cluster.add({ code: "1", signature: [1], score: 1, round: 0, island: 0 });
    cluster.add({ code: "1+0+0+0+0+0+0+0+0+0+0+0", signature: [1], score: 1, round: 0, island: 0 });
    const shortOnes = Array.from({ length: 400 }, () => cluster.sample(1, r)?.programs[0]?.code).filter((c) => c === "1").length;
    assert.ok(shortOnes > 220, `the short one was drawn ${shortOnes} times of 400`);
  });

  it("resets the worse half of the islands, each with a copy of the best program of a survivor", () => {
    const db = make();
    const reset = db.reset(seeded(1));
    assert.deepEqual([...reset].sort(), [1, 3], "the two islands with the lowest best scores (3 and 2) are reset");
    for (const i of reset) {
      const best = db.best(i);
      assert.ok(best !== undefined && best.island === i && (best.score === 9 || best.score === 5));
    }
    assert.equal(db.islands[1]?.length, 1);
    assert.deepEqual(make().reset(seeded(1)), reset, "the same seed, the same reset");
  });
});

describe("what reaches Lean", () => {
  it("writes a witness only as integers, booleans and lists, and screens the template", () => {
    assert.equal(leanTerm([1, -2, [true]]), "[1, (-2), [true]]");
    assert.equal(leanTerm("sorry"), undefined);
    assert.equal(leanTerm({ a: 1 }), undefined);
    assert.equal(leanTerm(1.5), undefined);
    assert.deepEqual(fillTemplate("w = {witness}", [1, 2]), { text: "w = [1, 2]" });
    assert.ok("problem" in fillTemplate("w = {witness}", ["#eval 1"]));
    assert.ok("problem" in fillTemplate("w = {witness} := sorry", [1]));
  });

  it("builds a prompt with the programs sorted by score and the next version asked for", () => {
    const text = buildPrompt(spec, [{ code: "A", signature: [1], score: 1, round: 0, island: 0 }, { code: "B", signature: [2], score: 2, round: 0, island: 0 }], 3);
    assert.match(text, /version 0: score 1\nA\n\n\/\/ version 1: score 2\nB/);
    assert.match(text, /Write version 2/);
    assert.match(text, /30 is the score to reach/);
  });
});

describe("scoring in the sandbox", () => {
  it("scores a program, rejects an invalid output, and a program that does not stop", async () => {
    const score = makeScorer(spec, limits);
    assert.deepEqual(await score("(n) => [9, 8, 7, 6]"), { ok: true, signature: [30], score: 30 });
    const dup = await score("(n) => [9, 9, 7, 6]");
    assert.equal(dup.ok, false);
    const loops = await score("(n) => { for (;;) {} }");
    assert.equal(loops.ok, false);
    assert.match(loops.ok ? "" : loops.why, /timeout|no value/);
    const broken = await score("(n) => ");
    assert.equal(broken.ok, false);
    const { score: _s, ...noScore } = spec;
    assert.equal((await makeScorer({ ...noScore, scoreSage: "x" }, limits)("(n) => [1]")).ok, false, "Sage scoring with no Sage");
  });

  it("scores a candidate whose output breaks the Sage scoring as invalid, and lets an interruption through", async () => {
    const { score: _drop, ...rest } = spec;
    const broken = async () => { throw new Error("TypeError: unsupported operand"); };
    const got = await makeScorer({ ...rest, scoreSage: "x + 1" }, limits, broken)("(n) => [9, 8, 7, 6]");
    assert.equal(got.ok, false);
    assert.match(got.ok ? "" : got.why, /Sage scoring failed: TypeError/);
    const garbage = await makeScorer({ ...rest, scoreSage: "x" }, limits, async () => "'not json'")("(n) => [1]");
    assert.equal(garbage.ok, false);
    const { InterruptedError } = await import("@seshat/lines");
    await assert.rejects(makeScorer({ ...rest, scoreSage: "x" }, limits, async () => { throw new InterruptedError("paused"); })("(n) => [1]"), /paused/);
  });

  it("scores through Sage when the task asks for it, with a stand-in for compute.sage", async () => {
    const sage = async (code: string) => {
      assert.match(code, /json\.loads/);
      return "'[30]'";
    };
    const { score: _drop, ...rest } = spec;
    const got = await makeScorer({ ...rest, scoreSage: "sum(x)" }, limits, sage)("(n) => [9, 8, 7, 6]");
    assert.deepEqual(got, { ok: true, signature: [30], score: 30 });
  });
});

describe("the line M16", () => {
  const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
    const found = line.hooks[name];
    assert.ok(found !== undefined);
    return found;
  };

  /** A ledger stand-in: `propose` makes a ready task proposed by M16, `list` filters. */
  function ledger(initial: TaskInfo[]) {
    const all = [...initial];
    return {
      all,
      list: (q: { kinds?: string[]; claimId?: string } = {}) => all.filter((t) => (q.kinds === undefined || q.kinds.includes(t.kind)) && (q.claimId === undefined || t.claimId === q.claimId)),
      propose: (p: { kind: string; claimId?: string }) => {
        all.push({ taskId: `t${all.length + 1}`, kind: p.kind, status: "ready", claimId: p.claimId, dependsOn: [], proposedBy: "line:M16" } as unknown as TaskInfo);
        return { accepted: true, taskId: `t${all.length}` };
      },
    };
  }

  /** What the orchestrator does: the line proposes in beforeProvers, then works each ready task it proposed through runTask. */
  async function go(line: Line, problem: ProblemContext) {
    await hook(line, "beforeProvers")(problem);
    const ends = [];
    for (const t of (problem.tasks as unknown as ReturnType<typeof ledger>).all.filter((x) => x.proposedBy === "line:M16" && x.status === "ready")) ends.push(await hook(line, "runTask")(problem, t, "p1"));
    return ends;
  }

  async function setup(script: unknown[], options: Record<string, unknown> = {}, specs: SearchSpec[] = [spec], tasks: TaskInfo[] = []) {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n = n", header: "import Mathlib", origin: "bench:t" });
    for (const s of specs) declareSearch(memory, claimId, s);
    const requests: ValidateRequest[] = [];
    const logs: string[] = [];
    const llm = scriptedLlm(script);
    const problem = {
      line: "M16", runId: "r", problemId: "p", claimId, memory, llm, log: (t: string) => logs.push(t), signal: new AbortController().signal,
      budget: { exhausted: false, usd: 0, limitUsd: undefined },
      tasks: ledger(tasks),
      validate: async (request: ValidateRequest): Promise<ValidateResult> => (requests.push(request), { verdict: "valid", status: "computed", reasons: [] }),
      options: { ...M16_OPTIONS, samples: 1, rounds: 8, callMs: 150, totalMs: 4000, ...options },
    } as unknown as ProblemContext;
    return { problem, memory, claimId, requests, logs, llm };
  }

  const script = [{ program: "(n) => { for (;;) {} }" }, { program: "(n) => [1, 1, 1, 1]" }, { program: "(n) => Array.from({length: n}, (_, i) => 5 + i)" }, { program: "(n) => Array.from({length: n}, (_, i) => 9 - i)" }];

  it("improves a toy score with a faux model and submits the witness to Lean, as a claim derived from the target", async () => {
    const line = createM16();
    const { problem, memory, claimId, requests, llm } = await setup(script);
    const ends = await go(line, problem);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.ended, "done");
    assert.match(ends[0]?.reason ?? "", /best score 30, target reached; Lean: valid/);
    const results = memory.nodes(SEARCH_RESULT_KIND, { claimId });
    assert.equal(results.length, 1);
    const done = (results[0]?.data as unknown as { done: { best: { score: number }; reached: boolean; witness: number[]; verdict: string } }).done;
    assert.deepEqual([done.best.score, done.reached, done.witness, done.verdict], [30, true, [9, 8, 7, 6], "valid"]);
    // The score did not settle anything: Lean got a proof of a claim about the witness.
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.proof, "subst h; decide");
    const witnessClaim = memory.claim(requests[0]?.claimId as string);
    assert.equal(witnessClaim?.statement, "(w : List ℕ) (h : w = [9, 8, 7, 6]) : w.sum = 30");
    assert.deepEqual([witnessClaim?.status, witnessClaim?.origin, witnessClaim?.parentId], ["open", "line:M16", claimId]);
    assert.ok(memory.edges({ from: witnessClaim?.claimId as string, kinds: ["derived_from"] }).length === 1);
    // Programs are nodes, with their scores; the one that did not stop is not.
    const programs = memory.nodes(SEARCH_PROGRAM_KIND, { claimId }).map((n) => (n.data as { score: number }).score).sort((a, b) => a - b);
    assert.ok(programs.includes(30) && programs.includes(26) && programs.length >= 3);
    assert.ok(llm.requests.every((r) => r.site === "search.program" && r.reuse === true));
    const briefing = await hook(line, "briefing")({ ...problem } as unknown as SessionContext);
    assert.match(briefing?.text ?? "", /score 30.*\[9,8,7,6\].*valid.*A score proves nothing/s);
  });

  it("shows Lean's refuted witnesses in the prompt and drops a program that builds one before scoring it (PD5)", async () => {
    const line = createM16();
    const { problem, memory, claimId, llm } = await setup([{ program: "(n) => [1, 1, 1, 1]" }, { program: "(n) => [9, 8, 7, 6]" }, { program: "(n) => [9, 8, 7, 5]" }], { rounds: 3 });
    assert.deepEqual(admitCounterexample(memory, claimId, { object: [9, 8, 7, 6], id: "[9,8,7,6]", source: "lean_decide", refutes: "an earlier witness" }), { admitted: true, created: true });
    await go(line, problem);
    const prompts = llm.requests.map((r) => r.prompt);
    assert.ok(prompts.length >= 2 && prompts.every((t) => /already refuted for this task.*\[9,8,7,6\]/s.test(t)));
    const scored = memory.nodes(SEARCH_PROGRAM_KIND, { claimId }).map((n) => (n.data as { code: string }).code);
    assert.ok(!scored.includes("(n) => [9, 8, 7, 6]"), "the refuted witness was not scored");
    assert.ok(scored.includes("(n) => [9, 8, 7, 5]"));
    const counter = cegisCounter(memory, claimId);
    assert.deepEqual([counter.dropped, counter.byLine["line:M16"]], [1, 1]);
  });

  it("keeps the witness Lean rejected, so that the next search for the claim starts from it", async () => {
    const line = createM16();
    const { problem, memory, claimId } = await setup(script);
    (problem as { validate: unknown }).validate = async () => ({ verdict: "invalid", status: "open", reasons: ["decide failed"] });
    await go(line, problem);
    const set = readCounterexamples(memory, claimId);
    assert.deepEqual(set.map((c) => [c.object, c.source]), [[[9, 8, 7, 6], "lean_decide"]]);
  });

  it("does not submit a witness below the target, and says so to the provers", async () => {
    const line = createM16();
    const { problem, requests } = await setup([{ program: "(n) => [5, 6, 7, 8]" }], { rounds: 2 });
    await go(line, problem);
    assert.equal(requests.length, 0);
    const text = (await hook(line, "briefing")({ ...problem } as unknown as SessionContext))?.text ?? "";
    assert.match(text, /not checked by Lean/);
  });

  it("is not run twice when the process resumes, and asks the model nothing", async () => {
    const line = createM16();
    const { problem, memory, claimId, requests, llm } = await setup(script);
    await go(line, problem);
    const calls = llm.requests.length;
    await hook(line, "resumeProblem")(problem, {} as never);
    const ledgerOf = problem.tasks as unknown as ReturnType<typeof ledger>;
    assert.equal(ledgerOf.all.length, 1, "the resumed process finds the task and proposes none");
    const again = await hook(line, "runTask")(problem, ledgerOf.all[0] as TaskInfo, "p1");
    assert.equal(again.ended, "done");
    assert.equal(llm.requests.length, calls);
    assert.equal(requests.length, 1);
    assert.equal(memory.nodes(SEARCH_RESULT_KIND, { claimId }).length, 1);
    assert.match((await hook(line, "briefing")({ ...problem } as unknown as SessionContext))?.text ?? "", /score 30/);
  });

  it("stops asking when the problem's budget is gone, and works the claim of a search task", async () => {
    const line = createM16();
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n = n", origin: "bench:t" });
    const other = (await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "bench:t" })).claimId;
    declareSearch(memory, other, spec);
    const llm = scriptedLlm([{ program: "(n) => [9, 8, 7, 6]" }]);
    const base = {
      line: "M16", runId: "r", problemId: "p", claimId, memory, llm, log: () => undefined, signal: new AbortController().signal,
      validate: async () => ({ verdict: "invalid", status: "open", reasons: ["unsolved goals"] }),
      options: { ...M16_OPTIONS, samples: 1, callMs: 150, totalMs: 4000 },
    };
    const task = { taskId: "t1", kind: "search", status: "ready", claimId: other, dependsOn: [] } as unknown as TaskInfo;
    const broke = { ...base, budget: { exhausted: true, usd: 9, limitUsd: 9 }, tasks: ledger([task]) } as unknown as ProblemContext;
    const ends = await go(line, broke);
    assert.equal(ends.length, 1);
    assert.equal(llm.requests.length, 0, "no model call with an exhausted budget");
    const node = memory.nodes(SEARCH_RESULT_KIND, { claimId: other });
    assert.equal(node.length, 1, "the task's claim was searched");
    // Without the task, the claim is not the problem's: nothing to search.
    const line2 = createM16();
    const untasked = { ...base, budget: { exhausted: false, usd: 0, limitUsd: undefined }, tasks: ledger([]) } as unknown as ProblemContext;
    const logs: string[] = [];
    await go(line2, { ...untasked, log: (t: string) => logs.push(t) } as ProblemContext);
    assert.equal(memory.nodes(SEARCH_RESULT_KIND, { claimId }).length, 0);
  });

  it("lets an interruption through, leaving the task for the resumed process", async () => {
    const { InterruptedError } = await import("@seshat/lines");
    const line = createM16();
    const { problem } = await setup([() => { throw new InterruptedError("turn over"); }]);
    await hook(line, "beforeProvers")(problem);
    const task = (problem.tasks as unknown as ReturnType<typeof ledger>).all[0] as TaskInfo;
    await assert.rejects(hook(line, "runTask")(problem, task, "p1"), /./);
  });

  it("checks its options and declares how it resumes and where it sits on the ladder", () => {
    assert.equal(readM16Options(M16_OPTIONS).islands, 3);
    assert.throws(() => readM16Options({ ...M16_OPTIONS, rounds: -1 }), /option M16\.rounds/);
    const line = createM16();
    assert.deepEqual([line.id, line.rung, line.resume, typeof line.hooks.resumeProblem], ["M16", 2, "rebuild", "function"]);
  });
});
