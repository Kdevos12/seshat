import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemEntry } from "@seshat/bench";
import { assertDisjoint, type Candidate, compareScores, type Evaluate, extractPrompt, gate, optimize, type OptimizeInput, optimizationSplits, paretoFront, pickParent, type Reflect, type Score } from "../src/optimize.ts";
import { promptTarget } from "../src/prompt-screen.ts";
import { RunSetupError } from "../src/run.ts";

const target = promptTarget("prover.system");
const entry = (path: string, fullName: string) => ({ id: `${path}#${fullName}`, path, fullName }) as unknown as ProblemEntry;
const ids = (list: ProblemEntry[]) => list.map((p) => p.id);

function cand(id: string, results: Record<string, [string, number]>): Candidate {
  return {
    id,
    text: id,
    parent: null,
    generation: 0,
    provenance: { modelId: "faux/x", promptVersion: "v", mathlibRev: "r", harnessVersion: "h", budgetClass: "small", createdAt: "2026-11-03T00:00:00.000Z" },
    scores: new Map(Object.entries(results).map(([p, [outcome, usd]]) => [p, { problemId: p, outcome, usd }])),
    feedback: new Map(),
  };
}

describe("the order of results", () => {
  it("puts a solved problem above an unsolved one and the cheaper above the dearer", () => {
    assert.equal(compareScores({ outcome: "proved", usd: 5 }, { outcome: "unsolved", usd: 0.1 }), 1);
    assert.equal(compareScores({ outcome: "refuted", usd: 0.1 }, { outcome: "proved", usd: 0.2 }), 1);
    assert.equal(compareScores({ outcome: "unsolved", usd: 0.3 }, { outcome: "unsolved", usd: 0.1 }), -1);
    assert.equal(compareScores({ outcome: "unsolved", usd: 0.1 }, { outcome: "unsolved", usd: 0.1 }), 0);
  });
});

describe("the Pareto set per problem", () => {
  const S = "proved";
  const U = "unsolved";

  it("keeps a candidate that is best on a problem the others lose, and drops one that is dominated", () => {
    const pool = [
      cand("a", { p1: [S, 1], p2: [U, 1], p3: [U, 1] }),
      cand("b", { p1: [U, 1], p2: [S, 1], p3: [U, 1] }),
      cand("c", { p1: [U, 1], p2: [U, 1], p3: [U, 1] }),
      cand("d", { p1: [S, 2], p2: [U, 1], p3: [U, 1] }),
    ];
    const front = paretoFront(pool, ["p1", "p2", "p3"]);
    assert.deepEqual(front.members.map((c) => c.id), ["a", "b"]);
    assert.deepEqual(front.leads.get("a"), ["p1"]);
    assert.deepEqual(front.leads.get("b"), ["p2"]);
    assert.equal(paretoFront([cand("n", { p1: [U, 1] })], ["p1"]).members[0]?.id, "n", "a pool that solves nothing still has a front");
  });

  it("lets one candidate that is best everywhere stand alone, and keeps the older of two that score alike", () => {
    const best = cand("best", { p1: [S, 1], p2: [S, 1] });
    const twin = cand("twin", { p1: [S, 1], p2: [S, 1] });
    const weak = cand("weak", { p1: [S, 1], p2: [U, 1] });
    assert.deepEqual(paretoFront([weak, best, twin], ["p1", "p2"]).members.map((c) => c.id), ["best"]);
  });

  it("separates candidates by cost on a problem they both solve", () => {
    const cheap = cand("cheap", { p1: [S, 0.1], p2: [U, 1] });
    const dear = cand("dear", { p1: [S, 0.5], p2: [S, 1] });
    const front = paretoFront([cheap, dear], ["p1", "p2"]);
    assert.deepEqual(front.members.map((c) => c.id), ["cheap", "dear"]);
    assert.deepEqual(front.leads.get("cheap"), ["p1"]);
  });

  it("draws a parent from the set, in proportion to the problems it leads on, the same way for the same seed", () => {
    const pool = [cand("a", { p1: [S, 1], p2: [S, 1], p3: [U, 1] }), cand("b", { p1: [U, 1], p2: [U, 1], p3: [S, 1] })];
    const front = paretoFront(pool, ["p1", "p2", "p3"]);
    const drawn = Array.from({ length: 300 }, (_, k) => pickParent(front, "s", `x${k}`).id);
    const a = drawn.filter((x) => x === "a").length;
    assert.ok(a > 150 && a < 250, `a drawn ${a} times of 300, expected about two thirds`);
    assert.equal(pickParent(front, "s", "x1").id, pickParent(front, "s", "x1").id);
  });
});

describe("the splits", () => {
  const problems = [
    entry("A.lean", "a1"), entry("A.lean", "a1.variants.x"), entry("B.lean", "b1"), entry("C.lean", "c1"), entry("D.lean", "d1"),
    entry("E.lean", "e1"), entry("F.lean", "f1"), entry("G.lean", "g1"),
  ];
  const dates = new Map<string, string>([
    ["A.lean#a1", "2024-01-01"], ["A.lean#a1.variants.x", "2025-09-01"], ["B.lean#b1", "2024-03-01"], ["C.lean#c1", "2024-05-01"],
    ["D.lean#d1", "2024-06-01"], ["E.lean#e1", "2025-08-01"], ["F.lean#f1", "2025-10-01"],
  ]);

  it("makes the temporal holdout of the problems newer than the cutoff and disjoint from the other two", () => {
    const s = optimizationSplits(problems, dates, { cutoff: "2025-01-01", seed: "s" });
    assert.deepEqual(ids(s.temporal).sort(), ["E.lean#e1", "F.lean#f1"]);
    assertDisjoint(s);
    assert.equal(s.dev.length + s.heldout.length, 5, "the older problems and the undated one, less nothing");
    assert.ok(s.dev.length >= 1 && s.heldout.length >= 1);
    assert.equal(s.undated, 1);
    assert.deepEqual(optimizationSplits(problems, dates, { cutoff: "2025-01-01", seed: "s" }), s, "the same seed cuts the same way");
  });

  it("leaves out a newer variant of an older problem, since it would not be unseen", () => {
    const s = optimizationSplits(problems, dates, { cutoff: "2025-01-01", seed: "s" });
    assert.deepEqual(s.leaked, ["A.lean#a1.variants.x"]);
    assert.ok(!ids(s.temporal).includes("A.lean#a1.variants.x"));
    const family = (p: ProblemEntry) => p.path;
    for (const f of new Set(s.dev.map(family))) assert.ok(!s.heldout.some((p) => family(p) === f), "a problem and its variants are on one side");
  });

  it("refuses a bad cutoff, a bench with nothing newer, and one with too little older", () => {
    assert.throws(() => optimizationSplits(problems, dates, { cutoff: "last week", seed: "s" }), /ISO 8601/);
    assert.throws(() => optimizationSplits(problems, dates, { cutoff: "2030-01-01", seed: "s" }), /no temporal holdout/);
    assert.throws(() => optimizationSplits(problems, dates, { cutoff: "2023-01-01", seed: "s" }), RunSetupError);
  });

  it("refuses splits that share a problem or are empty", () => {
    const p = entry("Z.lean", "z");
    assert.throws(() => assertDisjoint({ dev: [p], heldout: [p], temporal: [entry("Y.lean", "y")] }), /must not overlap/);
    assert.throws(() => assertDisjoint({ dev: [p], heldout: [], temporal: [entry("Y.lean", "y")] }), /heldout split is empty/);
  });
});

const RULE = { minSavings: 0.05, alpha: 0.1 };

describe("the gate", () => {
  const problems = [entry("A", "a"), entry("B", "b"), entry("C", "c")];
  const base = (rows: Array<[string, number]>) => cand("base", Object.fromEntries(problems.map((p, k) => [p.id, rows[k] as [string, number]])));
  const trial = (rows: Array<[string, number]>) => cand("c1", Object.fromEntries(problems.map((p, k) => [p.id, rows[k] as [string, number]])));

  it("accepts a gain only when the sign test supports it, at the level it is given", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((x) => entry("G", x));
    const rows = (n: number) => Object.fromEntries(six.map((p, k) => [p.id, [k < n ? "proved" : "unsolved", 1] as [string, number]]));
    const none = cand("base", rows(0));
    const all = gate("heldout", none, cand("c1", rows(6)), six, RULE);
    assert.deepEqual([all.beats, all.significant, all.accepted], [true, true, true]);
    assert.ok(all.p < 0.02);
    const four = cand("c1", rows(4));
    assert.equal(gate("heldout", none, four, six, RULE).accepted, true, "4-0 is p=0.0625, enough at 0.1");
    const corrected = gate("heldout", none, four, six, { ...RULE, alpha: 0.05 });
    assert.deepEqual([corrected.beats, corrected.accepted], [true, false], "but not at 0.1 shared by two finalists");
    assert.match(corrected.note, /not significant: sign test p=0\.063 against 0\.050/);
    const two = gate("heldout", none, cand("c1", rows(2)), six, RULE);
    assert.deepEqual([two.beats, two.accepted], [true, false], "a gain of two problems is indicative only");
  });

  it("never accepts a saving at a tie, which has no test", () => {
    const six = ["a", "b", "c"].map((x) => entry("G", x));
    const mk = (usd: number) => cand("x", Object.fromEntries(six.map((p) => [p.id, ["proved", usd] as [string, number]])));
    const g = gate("temporal", mk(1), mk(0.5), six, RULE);
    assert.deepEqual([g.beats, g.significant, g.accepted], [true, false, false]);
    assert.match(g.note, /a saving at a tie has no test/);
  });

  it("beats on more problems solved", () => {
    const g = gate("heldout", base([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), trial([["proved", 1], ["proved", 1], ["unsolved", 1]]), problems, RULE);
    assert.equal(g.beats, true);
    assert.equal(g.comparison.deltaSolved, 1);
  });

  it("refuses fewer problems solved, and the same number at the same price", () => {
    assert.equal(gate("heldout", base([["proved", 1], ["proved", 1], ["unsolved", 1]]), trial([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), problems, RULE).beats, false);
    const tie = gate("heldout", base([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), trial([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), problems, RULE);
    assert.equal(tie.beats, false);
  });

  it("accepts a tie only when it saves enough", () => {
    const b = base([["proved", 1], ["unsolved", 1], ["unsolved", 1]]);
    assert.equal(gate("temporal", b, trial([["proved", 0.5], ["unsolved", 1], ["unsolved", 1]]), problems, RULE).beats, true);
    const small = gate("temporal", b, trial([["proved", 1], ["unsolved", 0.97], ["unsolved", 1]]), problems, RULE);
    assert.equal(small.beats, false);
    assert.match(small.note, /saves less than 5%/);
  });

  it("counts certified outcomes only: a fast-check candidate is no win, and is shown apart", () => {
    const g = gate("heldout", base([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), trial([["proved", 1], ["candidate", 1], ["candidate", 1]]), problems, RULE);
    assert.equal(g.beats, false);
    assert.equal(g.comparison.deltaSolved, 0);
    assert.deepEqual([g.baseline.solved, g.baseline.candidates, g.candidate.solved, g.candidate.candidates], [1, 0, 1, 2]);
    const lost = gate("heldout", base([["proved", 1], ["candidate", 1], ["unsolved", 1]]), trial([["candidate", 1], ["candidate", 1], ["candidate", 1]]), problems, RULE);
    assert.equal(lost.beats, false, "more fast-check passes, fewer certified");
    assert.ok(compareScores({ outcome: "proved", usd: 9 }, { outcome: "candidate", usd: 0.1 }) > 0);
    assert.ok(compareScores({ outcome: "refuted", usd: 1 }, { outcome: "unsolved", usd: 1 }) > 0);
  });

  it("is not comparable when a split was not finished alike", () => {
    const partial = cand("c1", { [problems[0]!.id]: ["proved", 1] });
    const g = gate("heldout", base([["proved", 1], ["unsolved", 1], ["unsolved", 1]]), partial, problems, RULE);
    assert.equal(g.beats, false);
    assert.match(g.note, /not comparable/);
  });
});

describe("extracting a rewrite", () => {
  it("takes the text between the tags, and nothing when there are none", () => {
    assert.equal(extractPrompt("Here:\n<prompt>\nHello {{X}}\n</prompt>\nbye"), "Hello {{X}}");
    assert.equal(extractPrompt("no tags"), undefined);
    assert.equal(extractPrompt("<prompt>  </prompt>"), undefined);
  });
});

describe("the search and the acceptance rule", () => {
  const dev = ["d1", "d2", "d3", "d4"].map((x) => entry("Dev.lean", x));
  const heldout = ["h1", "h2", "h3", "h4", "h5", "h6"].map((x) => entry("Held.lean", x));
  const temporal = ["t1", "t2", "t3", "t4", "t5", "t6"].map((x) => entry("New.lean", x));
  const splits = { dev, heldout, temporal };

  const rewrite = (marker: string) => target.current.replace("Method", `Method ${marker}`).replace("# Method", `# Method (${marker})`);
  const answer = (marker: string) => `<prompt>\n${rewrite(marker)}\n</prompt>`;

  /** A simulated bench: which problems a prompt solves is decided by the marker words in its text. */
  function simulate(solves: Record<string, string[]>): { evaluate: Evaluate; calls: Array<{ label: string; marker: string; problems: string[] }> } {
    const calls: Array<{ label: string; marker: string; problems: string[] }> = [];
    const evaluate: Evaluate = async ({ label, template, problems }) => {
      const marker = template === undefined ? "merged" : (/\(([A-Za-z]+)\)/.exec(template)?.[1] ?? "unknown");
      calls.push({ label, marker, problems: problems.map((p) => p.fullName) });
      const solved = new Set(solves[marker] ?? []);
      return {
        scores: problems.map((p): Score => ({ problemId: p.id, outcome: solved.has(p.fullName) ? "proved" : "unsolved", usd: 0.1 })),
        feedback: Object.fromEntries(problems.map((p) => [p.id, solved.has(p.fullName) ? "Lean accepted the proof." : "error: unsolved goals"])),
      };
    };
    return { evaluate, calls };
  }

  const scripted = (answers: string[]): { reflect: Reflect; prompts: string[] } => {
    const prompts: string[] = [];
    let k = 0;
    return { prompts, reflect: async ({ prompt }) => { prompts.push(prompt); return { text: answers[k++ % answers.length] as string, usd: 0.01 }; } };
  };

  const base = (extra: Partial<OptimizeInput> & Pick<OptimizeInput, "evaluate" | "reflect">): OptimizeInput => ({
    target,
    splits,
    provenance: { modelId: "faux/reflector", promptVersion: "m0-2.1", mathlibRev: "rev", harnessVersion: "h", budgetClass: "small" },
    seed: "s",
    iterations: 4,
    minibatch: 4,
    now: () => new Date("2026-11-03T00:00:00.000Z"),
    ...extra,
  });

  it("accepts a candidate that beats the merged prompt on the held-out split and on the temporal holdout", async () => {
    const sim = simulate({
      merged: ["d1", "h1", "t1"],
      Better: ["d1", "d2", "d3", "h1", "h2", "h3", "h4", "h5", "h6", "t1", "t2", "t3", "t4", "t5", "t6"],
    });
    const r = await optimize(base({ evaluate: sim.evaluate, ...scripted([answer("Better")]) }));
    assert.equal(r.finalists.length, 1);
    const [f] = r.finalists;
    assert.equal(f?.status, "accepted");
    assert.equal(f?.accepted, true);
    assert.deepEqual(f?.gates.map((g) => [g.split, g.accepted]), [["heldout", true], ["temporal", true]]);
    assert.equal(f?.dev.solved, 3);
    assert.equal(f?.candidate.provenance.modelId, "faux/reflector");
    assert.equal(f?.candidate.provenance.createdAt, "2026-11-03T00:00:00.000Z");
    assert.equal(r.trials[0]?.status, "added");
  });

  it("measures the merged prompt and the candidate on the same problems, with one call each per split", async () => {
    const sim = simulate({ merged: ["d1"], Better: ["d1", "d2"] });
    await optimize(base({ evaluate: sim.evaluate, ...scripted([answer("Better")]) }));
    const held = sim.calls.filter((c) => c.label.endsWith("-heldout"));
    assert.deepEqual(held.map((c) => c.label), ["baseline-heldout", "c1-heldout"]);
    assert.deepEqual(held[0]?.problems, held[1]?.problems);
    const time = sim.calls.filter((c) => c.label.endsWith("-temporal"));
    assert.deepEqual(time[0]?.problems, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    assert.deepEqual(time[0]?.problems, time[1]?.problems);
  });

  it("rejects a candidate that wins on dev and loses on the held-out split (it fit the dev problems)", async () => {
    const sim = simulate({ merged: ["d1", "h1", "h2", "t1"], Overfit: ["d1", "d2", "d3", "d4", "t1", "t2", "t3", "t4", "t5", "t6"] });
    const r = await optimize(base({ evaluate: sim.evaluate, ...scripted([answer("Overfit")]) }));
    const [f] = r.finalists;
    assert.equal(f?.accepted, false);
    assert.deepEqual(f?.gates.map((g) => g.accepted), [false, true]);
  });

  it("marks a candidate that beats the merged prompt on both splits by a margin the sign test does not support as needing review", async () => {
    const sim = simulate({ merged: ["d1", "h1", "t1"], Better: ["d1", "d2", "d3", "h1", "h2", "h3", "h4", "t1", "t2", "t3", "t4"] });
    const r = await optimize(base({ evaluate: sim.evaluate, ...scripted([answer("Better")]) }));
    const f = r.finalists[0];
    assert.equal(f?.status, "needs_review");
    assert.equal(f?.accepted, false);
    assert.deepEqual(f?.gates.map((g) => [g.beats, g.significant]), [[true, false], [true, false]]);
    assert.ok((f?.gates[0]?.p ?? 0) > 0.1);
  });

  it("divides the level of the sign test among the finalists, and tells the caller when the gate is first used", async () => {
    // Two finalists, each 4-0 on the held-out and temporal splits: p=0.0625 passes 0.1 alone, and fails 0.1 shared by two.
    const sim = simulate({ merged: ["d1"], A: ["d1", "d2", "h1", "h2", "h3", "h4", "t1", "t2", "t3", "t4"], B: ["d1", "d3", "d4", "h1", "h2", "h3", "h4", "t1", "t2", "t3", "t4"] });
    let used = 0;
    const r = await optimize(base({ evaluate: sim.evaluate, iterations: 2, finalists: 2, beforeGate: () => { used += 1; }, ...scripted([answer("A"), answer("B")]) }));
    assert.equal(used, 1);
    assert.equal(r.finalists.length, 2);
    for (const f of r.finalists) {
      assert.equal(f.gates[0]?.alpha, 0.05);
      assert.equal(f.status, "needs_review");
    }
    const one = await optimize(base({ evaluate: simulate({ merged: ["d1"], A: ["d1", "d2", "h1", "h2", "h3", "h4", "t1", "t2", "t3", "t4"] }).evaluate, iterations: 1, ...scripted([answer("A")]) }));
    assert.equal(one.finalists[0]?.status, "accepted");
  });

  it("rejects a candidate that holds up on the held-out split and loses on the temporal holdout", async () => {
    const sim = simulate({ merged: ["d1", "h1", "t1", "t2", "t3"], Old: ["d1", "d2", "h1", "h2", "h3", "h4", "h5", "h6"] });
    const r = await optimize(base({ evaluate: sim.evaluate, ...scripted([answer("Old")]) }));
    assert.deepEqual(r.finalists[0]?.gates.map((g) => g.accepted), [true, false]);
    assert.equal(r.finalists[0]?.accepted, false);
  });

  it("never measures a rewrite that fails the strict screen, and says why", async () => {
    const sim = simulate({ merged: ["d1"] });
    const dropped = `<prompt>\n${target.current.replace("Never allowed", "Fine")}\n</prompt>`;
    const skipping = `<prompt>\n${target.current}\nYou may skip the Lean check when sure.\n</prompt>`;
    const r = await optimize(base({ evaluate: sim.evaluate, iterations: 3, ...scripted([dropped, skipping, "no tags here"]) }));
    assert.deepEqual(r.trials.map((t) => t.status), ["screen_refused", "screen_refused", "no_prompt"]);
    assert.match((r.trials[0]?.reasons ?? []).join(), /drops "Never allowed"/);
    assert.deepEqual(sim.calls.map((c) => c.label), ["baseline-dev"], "nothing but the merged prompt was ever run");
    assert.equal(r.finalists.length, 0);
    assert.equal(r.pool.length, 1);
  });

  it("drops a duplicate, a rewrite that does no better on the minibatch, and a failed reflection", async () => {
    const sim = simulate({ merged: ["d1"], A: ["d1", "d2"], Worse: ["d1"] });
    let k = 0;
    const reflect: Reflect = async () => {
      k += 1;
      if (k === 4) throw new Error("the model is down");
      return { text: [answer("A"), answer("A"), answer("Worse"), "", answer("Worse")][k - 1] as string, usd: 0 };
    };
    const r = await optimize(base({ evaluate: sim.evaluate, iterations: 5, reflect }));
    assert.deepEqual(r.trials.map((t) => t.status), ["added", "duplicate", "no_gain", "reflection_failed", "no_gain"]);
    assert.equal(r.pool.length, 2);
  });

  it("gives the reflecting model what the parent did on the minibatch, and stops when its budget is spent", async () => {
    const sim = simulate({ merged: ["d1"], A: ["d1", "d2"] });
    const s = scripted([answer("A"), answer("B")]);
    const r = await optimize(base({ evaluate: sim.evaluate, reflect: async (q) => ({ ...(await s.reflect(q)), usd: 0.3 }), iterations: 6, reflectBudgetUsd: 0.5 }));
    assert.match(s.prompts[0] ?? "", /# The current prompt\n<prompt>\nYou are a mathematician/);
    assert.match(s.prompts[0] ?? "", /## d1\ncertified \(proved\), \$0\.100\nLean accepted the proof\./);
    assert.match(s.prompts[0] ?? "", /## d2\nnot solved \(unsolved\), \$0\.100\nerror: unsolved goals/);
    assert.equal(r.trials.length, 2);
    assert.match(r.stoppedBy ?? "", /budget/);
    assert.ok(r.reflectUsd >= 0.5);
  });

  it("keeps a Pareto set: a candidate that solves what the parent does not stays beside it, and a child can come from either", async () => {
    const sim = simulate({ merged: ["d1"], A: ["d1", "d2"], B: ["d1", "d3", "d4"] });
    const r = await optimize(base({ evaluate: sim.evaluate, iterations: 2, ...scripted([answer("A"), answer("B")]) }));
    assert.equal(r.pool.length, 3);
    assert.deepEqual(r.front.members.map((c) => c.id).sort(), ["c1", "c2"], "c1 is the only one to solve d2, c2 solves more in all");
    assert.equal(r.front.members.some((c) => c.id === "c0"), false, "the merged prompt is dominated by both");
  });

  it("measures no finalist when no candidate beats the merged prompt on dev", async () => {
    const sim = simulate({ merged: ["d1", "d2"], Worse: ["d1"] });
    const r = await optimize(base({ evaluate: sim.evaluate, iterations: 1, ...scripted([answer("Worse")]) }));
    assert.equal(r.finalists.length, 0);
    assert.deepEqual(sim.calls.map((c) => c.label).filter((l) => l.includes("heldout") || l.includes("temporal")), []);
  });

  it("refuses overlapping splits before it spends anything", async () => {
    const sim = simulate({});
    await assert.rejects(optimize(base({ evaluate: sim.evaluate, ...scripted([answer("A")]), splits: { dev, heldout: dev, temporal } })), /must not overlap/);
    assert.equal(sim.calls.length, 0);
  });
});
