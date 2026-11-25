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
  normalizedEditDistance,
  ProgramDatabase,
  readCounterexamples,
  runSearch,
  SEARCH_DEFAULTS,
  readM16Options,
  SEARCH_PROGRAM_KIND,
  SEARCH_RESULT_KIND,
  SEARCH_LOCAL_KIND,
  type SearchSpec,
  runLocalSearch,
  neighborhoodMoves,
  makeLocalPhase,
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

describe("novelty and balanced parents (plan change LH5)", () => {
  it("measures the edit distance of two program texts, white space apart", () => {
    assert.equal(normalizedEditDistance("(n) => n + 1", "(n)  =>   n + 1"), 0);
    assert.equal(normalizedEditDistance("abcd", "abce"), 0.25);
    assert.equal(normalizedEditDistance("", ""), 0);
    assert.equal(normalizedEditDistance("aaaa", "bbbb"), 1);
  });

  it("rejects a candidate too close to one already scored before it runs, and scores a different one", async () => {
    const scored: string[] = [];
    const scorer = async (code: string) => {
      scored.push(code);
      return { ok: true as const, signature: [code.length], score: code.length };
    };
    const candidates = ["(n) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].slice(0, n)", "(n) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].slice(0, n) ", "(n) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 8].slice(0, n)", "(n) => Array.from({length: n}, (_, i) => 9 - i)"];
    const run = async (novelty: number | undefined) => {
      scored.length = 0;
      const llm = scriptedLlm(candidates.slice(1).map((program) => ({ program })));
      await runSearch(llm, { ...(({ target: _t, ...rest }) => rest)(spec), seeds: [candidates[0] as string] }, { ...SEARCH_DEFAULTS, islands: 1, rounds: 3, samples: 1, ...(novelty !== undefined ? { novelty } : {}) }, scorer, seeded(1));
      return [...scored];
    };
    assert.equal((await run(undefined)).length, 4, "off: every candidate is scored");
    const kept = await run(0.1);
    assert.equal(kept.length, 2, "the seed and the one candidate far enough from it");
    assert.equal(kept[1], candidates[3]);
  });

  it("draws parents half from the best cluster and half from the rest", () => {
    const db = new ProgramDatabase(1, { temperature: 0.5, lengthBias: 0, clusterSize: 2, parentSplit: true });
    for (const [score, code] of [[9, "best"], [1, "low-a"], [2, "low-b"], [3, "low-c"]] as const) db.add({ code, signature: [score], score, round: 0, island: 0 });
    const r = seeded(5);
    let fromBest = 0;
    let fromRest = 0;
    for (let i = 0; i < 100; i++) {
      const drawn = db.sample(2, r);
      assert.equal(drawn?.programs.length, 2);
      for (const p of drawn?.programs ?? []) (p.code === "best" ? fromBest++ : fromRest++);
    }
    assert.equal(fromBest, 100, "one parent of each two is the best's");
    assert.equal(fromRest, 100, "the other is from the rest");
    const greedy = new ProgramDatabase(1, { temperature: 0.01, lengthBias: 0, clusterSize: 2 });
    for (const [score, code] of [[9, "best"], [1, "low"]] as const) greedy.add({ code, signature: [score], score, round: 0, island: 0 });
    assert.ok(greedy.sample(1, seeded(1))?.programs[0]?.code === "best", "without the option the draw is the softmax");
  });
});

describe("the iid baseline (plan change CX2)", () => {
  const seed = "(n) => [0]";
  const candidates = ["(n) => [0, 1]", "(n) => [0, 1, 2]", "(n) => [0, 1, 2, 3]", "(n) => [0, 1, 2, 3, 4]", "(n) => [0, 1, 2, 3, 4, 5]", "(n) => [0, 1, 2, 3, 4, 5, 6]", "(n) => [0, 1, 2, 3, 4, 5, 6, 7]", "(n) => [0, 1, 2, 3, 4, 5, 6, 7, 8]"];
  const scorer = async (code: string) => ({ ok: true as const, signature: [code.length], score: code.length });
  const noTarget: SearchSpec = { ...(({ target: _t, ...rest }) => rest)(spec), seeds: [seed] };
  const run = async (strategy: "islands" | "iid" | undefined) => {
    const llm = scriptedLlm(candidates.map((program) => ({ program })));
    const resets: number[][] = [];
    const islands = new Set<number>();
    const options = { ...SEARCH_DEFAULTS, rounds: 4, samples: 2, resetEvery: 2, ...(strategy !== undefined ? { strategy } : {}) };
    const result = await runSearch(llm, noTarget, options, scorer, seeded(4), { events: { reset: (e) => resets.push(e.islands), program: (e) => islands.add(e.island) } });
    return { result, prompts: llm.requests.map((r) => r.prompt), resets, islands };
  };

  it("asks the same prompt every time, with one island and no resets, for the same number of calls", async () => {
    const iid = await run("iid");
    const islands = await run(undefined);
    assert.equal(iid.prompts.length, 8, "rounds x samples");
    assert.equal(islands.prompts.length, 8, "the same spend as the islands");
    const body = (p: string) => p.replace(/ \(round \d+\)/g, "").replace(/ \(draft \d+ of \d+\)/g, "");
    assert.equal(new Set(iid.prompts.map(body)).size, 1, "one prompt");
    assert.equal(new Set(iid.prompts).size, 8, "each call is its own for reuse");
    assert.ok(iid.prompts.every((p) => p.includes(seed) && !candidates.some((c) => p.includes(c))), "only the seed is shown");
    assert.deepEqual([iid.resets, [...iid.islands]], [[], [0]]);
    assert.equal(iid.result.best?.code, candidates[7], "the best program found is kept");
    assert.ok(islands.resets.length > 0 && islands.islands.size === 3, "the islands reset and use three islands");
    assert.ok(islands.prompts.some((p) => candidates.some((c) => p.includes(c))), "the islands feed found programs back");
  });

  it("is the islands when absent, and reads the option", async () => {
    const absent = await run(undefined);
    const named = await run("islands");
    assert.deepEqual([named.prompts, named.result, named.resets], [absent.prompts, absent.result, absent.resets]);
    assert.equal(M16_OPTIONS.strategy, "islands");
    assert.equal("strategy" in readM16Options(M16_OPTIONS), false, "the default leaves the search options as they were");
    assert.equal(readM16Options({ ...M16_OPTIONS, strategy: "iid" }).strategy, "iid");
    const { strategy: _s, ...older } = M16_OPTIONS;
    assert.equal(readM16Options(older).strategy, undefined, "options written before CX2 are the islands");
    assert.throws(() => readM16Options({ ...M16_OPTIONS, strategy: "beam" }), /option M16\.strategy/);
  });

  it("runs the line with M16.strategy=iid and submits the witness it finds", async () => {
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n = n", header: "import Mathlib", origin: "bench:t" });
    declareSearch(memory, claimId, spec);
    const llm = scriptedLlm([{ program: "(n) => [1, 1, 1, 1]" }, { program: "(n) => Array.from({length: n}, (_, i) => 9 - i)" }]);
    const requests: ValidateRequest[] = [];
    const tasks: TaskInfo[] = [];
    const problem = {
      line: "M16", runId: "r", problemId: "p", claimId, memory, llm, log: () => {}, signal: new AbortController().signal,
      budget: { exhausted: false, usd: 0, limitUsd: undefined },
      tasks: {
        list: (q: { kinds?: string[]; claimId?: string } = {}) => tasks.filter((t) => (q.kinds === undefined || q.kinds.includes(t.kind)) && (q.claimId === undefined || t.claimId === q.claimId)),
        propose: (p: { kind: string; claimId?: string }) => (tasks.push({ taskId: "t1", kind: p.kind, status: "ready", claimId: p.claimId, dependsOn: [], proposedBy: "line:M16" } as unknown as TaskInfo), { accepted: true, taskId: "t1" }),
      },
      validate: async (request: ValidateRequest): Promise<ValidateResult> => (requests.push(request), { verdict: "valid", status: "computed", reasons: [] }),
      options: { ...M16_OPTIONS, samples: 1, rounds: 8, callMs: 150, totalMs: 4000, strategy: "iid" },
    } as unknown as ProblemContext;
    const line = createM16();
    await line.hooks.beforeProvers?.(problem);
    const end = await line.hooks.runTask?.(problem, tasks[0] as TaskInfo, "p1");
    assert.match(end?.reason ?? "", /best score 30, target reached; Lean: valid/);
    assert.equal(requests.length, 1);
    assert.equal(llm.requests.length, 2, "stopped at the target");
    assert.ok(llm.requests.every((r) => r.prompt.includes("Array.from({length: n}, (_, i) => i)") && !r.prompt.includes("[1, 1, 1, 1]")), "the seed's prompt each time");
  });
});

describe("local search between model rounds (plan change CX5)", () => {
  const ones = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const settings = { method: "anneal" as const, steps: 200, neighbors: 4, plateau: 30, restarts: 1, temperature: 0, cooling: 1, tabuTenure: 8 };

  it("climbs with annealing at temperature 0, takes worse moves under tabu, and draws the same for the same seed", async () => {
    const problem = (score: (x: number[]) => number) => ({
      start: () => Array(10).fill(0) as number[],
      moves: (x: number[], count: number) => Array.from({ length: count }, () => x),
      score: async (xs: number[][]) => xs.map(score),
    });
    const flips = (seed: number) => {
      const random = seeded(seed);
      const bits = neighborhoodMoves("bits", Array(10).fill(0), random, {});
      assert.ok("moves" in bits);
      return { random, moves: bits.moves as unknown as (x: number[], count: number) => Promise<number[][]> };
    };
    const run = async (method: "anneal" | "tabu", seed: number) => {
      const { random, moves } = flips(seed);
      return runLocalSearch({ ...problem(ones), moves, isHit: (_x, s) => s >= 10 }, { ...settings, method }, random);
    };
    const climb = await run("anneal", 3);
    assert.deepEqual(climb.hit?.object, Array(10).fill(1));
    assert.deepEqual(await run("anneal", 3), climb, "the same seed, the same search");
    // A score that punishes every move: the climb never moves and ends on its plateau; tabu moves all the same.
    const { random, moves } = flips(5);
    const flat = await runLocalSearch({ ...problem((x) => 0 - ones(x)), moves }, { ...settings, plateau: 5 }, random);
    assert.deepEqual([flat.steps, flat.best?.score], [5, 0]);
    const t = flips(5);
    let visited = 0;
    const tabu = await runLocalSearch({ ...problem((x) => 0 - ones(x)), moves: async (x, c) => (visited++, t.moves(x, c)) }, { ...settings, method: "tabu", plateau: 5 }, t.random);
    assert.equal(tabu.steps, 5);
    assert.equal(tabu.best?.score, 0, "the best stays the start");
  });

  it("moves each neighborhood within its kind, and says why a witness is not one it moves", async () => {
    const r = seeded(9);
    const check = async (spec: Parameters<typeof neighborhoodMoves>[0], start: unknown, ok: (x: unknown) => boolean) => {
      const n = neighborhoodMoves(spec, start as never, r, { callMs: 150, totalMs: 4000 });
      assert.ok("moves" in n, JSON.stringify(n));
      for (const x of await n.moves(start as never, 20)) assert.ok(ok(x), JSON.stringify(x));
    };
    await check("bits", [0, 1, true], (x) => Array.isArray(x) && x.length === 3);
    await check({ kind: "intList", min: 0, max: 5 }, [0, 5, 3], (x) => Array.isArray(x) && x.every((v) => Number.isInteger(v) && v >= 0 && v <= 5));
    await check("permutation", [0, 1, 2, 3], (x) => Array.isArray(x) && [...x].sort().join() === "0,1,2,3");
    await check({ kind: "graph", min: 3, max: 5 }, { n: 4, edges: [[0, 1]] }, (x) => {
      const g = x as { n: number; edges: number[][] };
      return g.n >= 3 && g.n <= 5 && g.edges.every(([u, v]) => (u as number) < (v as number) && (v as number) < g.n);
    });
    await check({ move: "(x) => x.map((v) => v + (Math.random() < 0.5 ? 1 : 0))" }, [1, 2], (x) => Array.isArray(x) && x.length === 2);
    assert.match(String((neighborhoodMoves("bits", [2], r, {}) as { problem: string }).problem), /0\/1/);
    assert.ok("problem" in neighborhoodMoves({ kind: "graph" }, [1], r, {}));
    assert.ok("problem" in neighborhoodMoves("cube" as never, [1], r, {}));
  });

  const bitsSpec: SearchSpec = {
    description: "twelve bits with as many ones as possible",
    signature: "(n) => an array of n bits",
    inputs: [12],
    score: "({input, output}) => Array.isArray(output) && output.length === input && output.every((b) => b === 0 || b === 1) ? output.reduce((a, b) => a + b, 0) : null",
    target: 12,
    seeds: ["(n) => Array(n).fill(0)"],
    statement: "(w : List ℕ) (h : w = {witness}) : w.sum = 12",
    proof: "subst h; decide",
  };
  // The faux model improves by two ones a round: six rounds to the target.
  const slowScript = [2, 4, 6, 8, 10, 12].map((k) => ({ program: `(n) => Array.from({length: n}, (_, i) => (i < ${k} ? 1 : 0))` }));

  async function runLine(spec: SearchSpec, options: Record<string, unknown> = {}, memory = openMemory("orchestrator-test")) {
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n = n", header: "import Mathlib", origin: "bench:t" });
    declareSearch(memory, claimId, spec);
    const llm = scriptedLlm(slowScript);
    const requests: ValidateRequest[] = [];
    const tasks: TaskInfo[] = [];
    const problem = {
      line: "M16", runId: "r", problemId: "p", claimId, memory, llm, log: () => {}, signal: new AbortController().signal, seed: 11,
      budget: { exhausted: false, usd: 0, limitUsd: undefined },
      tasks: {
        list: (q: { kinds?: string[]; claimId?: string } = {}) => tasks.filter((t) => (q.kinds === undefined || q.kinds.includes(t.kind)) && (q.claimId === undefined || t.claimId === q.claimId)),
        propose: (p: { kind: string; claimId?: string }) => (tasks.push({ taskId: "t1", kind: p.kind, status: "ready", claimId: p.claimId, dependsOn: [], proposedBy: "line:M16" } as unknown as TaskInfo), { accepted: true, taskId: "t1" }),
      },
      validate: async (request: ValidateRequest): Promise<ValidateResult> => (requests.push(request), { verdict: "valid", status: "computed", reasons: [] }),
      options: { ...M16_OPTIONS, samples: 1, rounds: 8, callMs: 300, totalMs: 6000, ...options },
    } as unknown as ProblemContext;
    const line = createM16();
    await line.hooks.beforeProvers?.(problem);
    const end = await line.hooks.runTask?.(problem, tasks[0] as TaskInfo, "p1");
    const local = memory.nodes(SEARCH_LOCAL_KIND, { claimId }).map((n) => (n.data as unknown as { record: { phase: number; seed: number; steps: number; bestScore: number | null; improved: boolean } }).record);
    const done = (memory.nodes(SEARCH_RESULT_KIND, { claimId })[0]?.data as unknown as { done: { claimId: string; witness: unknown; local?: { score: number } } }).done;
    return { end, llm, requests, local, done, memory, claimId };
  }

  it("reaches the target of a toy score in fewer model rounds than without it, and submits the improved witness to Lean", async () => {
    const without = await runLine(bitsSpec);
    const withLocal = await runLine({ ...bitsSpec, neighborhood: "bits" });
    assert.equal(without.llm.requests.length, 6, "six model rounds without the local search");
    assert.ok(withLocal.llm.requests.length < without.llm.requests.length, `${withLocal.llm.requests.length} model rounds with it`);
    assert.match(withLocal.end?.reason ?? "", /best score 12, target reached; Lean: valid/);
    assert.deepEqual(withLocal.done.witness, Array(12).fill(1));
    assert.equal(withLocal.requests[0]?.proof, "subst h; decide");
    assert.equal(withLocal.requests.length, 1, "Lean, not the score, settles the witness");
    assert.ok(withLocal.local.length >= 1 && withLocal.local.some((r) => r.improved), "each phase is journaled with its seed");
    assert.equal(without.local.length, 0);
  });

  it("is the search it was without a neighborhood, whatever the local options say", async () => {
    const a = await runLine(bitsSpec);
    const b = await runLine(bitsSpec, { localMethod: "tabu", localSteps: 3, plateauSteps: 1, localNeighbors: 2, localMs: 100 });
    assert.deepEqual(b.llm.requests.map((r) => r.prompt), a.llm.requests.map((r) => r.prompt));
    const bare = (d: { claimId?: string }) => ({ ...d, claimId: "" });
    assert.deepEqual([bare(b.done), b.end], [bare(a.done), a.end]);
    const { localMethod: _m, localSteps: _s, plateauSteps: _p, localNeighbors: _n, localTemperature: _t, tabuTenure: _u, localMs: _ms, ...older } = M16_OPTIONS;
    assert.deepEqual(readM16Options(older).local, readM16Options(M16_OPTIONS).local, "options written before CX5 take the defaults");
    assert.throws(() => readM16Options({ ...M16_OPTIONS, localMethod: "beam" }), /option M16\.localMethod/);
  });

  it("replays a journaled phase with its seed and step count, not the wall time", async () => {
    // A move program that never improves: every phase ends on its plateau.
    const spec: SearchSpec = { ...bitsSpec, target: 13, neighborhood: { move: "(x) => x.map((b) => (Math.random() < 0.3 ? 0 : b))" } };
    const first = await runLine(spec, { plateauSteps: 3, rounds: 2 });
    assert.ok(first.local.length >= 2 && first.local.every((r) => r.steps === 3 && r.improved === false));
    // A process that resumes finds the phases' nodes: each phase runs the steps on record, though its time is now too short for one.
    const memory = openMemory("orchestrator-test");
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n = n", header: "import Mathlib", origin: "bench:t" });
    const key = (first.memory.nodes(SEARCH_LOCAL_KIND, { claimId: first.claimId })[0]?.data as { key: string }).key;
    for (const record of first.local) memory.recordNode({ kind: SEARCH_LOCAL_KIND, claimId, data: { key, record } as never });
    const again = await runLine(spec, { plateauSteps: 3, rounds: 2, localMs: 100 }, memory);
    assert.deepEqual(again.local, first.local);
    assert.deepEqual({ ...again.done, claimId: "" }, { ...first.done, claimId: "" });
  });

  it("says why a phase does nothing: a Sage score, a witness its neighborhood does not move", async () => {
    const records: unknown[] = [];
    const best = { code: "(n) => 7", signature: [0], score: 0, round: 0, island: 0 };
    const phase = makeLocalPhase({ ...bitsSpec, neighborhood: "bits" }, { method: "anneal", steps: 5, neighbors: 2, plateauSteps: 2, temperature: 0, tabuTenure: 0, ms: 2000 }, { callMs: 150, totalMs: 4000 }, 1, { record: (r) => records.push(r) });
    assert.equal(await phase(best, undefined, 1), undefined);
    assert.match(JSON.stringify(records[0]), /not a non-empty list of 0\/1/);
    const { score: _s, ...sage } = bitsSpec;
    const none = makeLocalPhase({ ...sage, scoreSage: "1", neighborhood: "bits" }, { method: "anneal", steps: 5, neighbors: 2, plateauSteps: 2, temperature: 0, tabuTenure: 0, ms: 2000 }, {}, 1, { record: (r) => records.push(r) });
    assert.equal(await none(best, undefined, 1), undefined);
    assert.match(JSON.stringify(records[1]), /JavaScript scoring program/);
  });
});
