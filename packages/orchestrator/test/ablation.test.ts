import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProblemEntry } from "@seshat/bench";
import { LINES } from "../src/lines.ts";
import { type Arm, ablationProblems, armConfig, compareArms, cumulativeArms, cumulativeNames, runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { measureRun } from "../src/measures.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult, RunSetupError } from "../src/index.ts";
import { consortium } from "./turns-helpers.ts";
import { scriptedRun, type ScriptedSpec } from "./ablate-helpers.ts";
import { check, config as demoConfig, DemoLean, demoBench, demoRegistry, fauxModels, tempDir } from "./m0-helpers.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };

describe("the cumulative configurations", () => {
  it("are M0 and each line in plan section 7's order, the suspended lines left out", () => {
    const names = cumulativeNames();
    assert.deepEqual(names, ["M0", "M1", "M10", "M2", "M11", "M12", "M18", "M4", "M6", "fleet", "M3", "M15", "M8", "M16", "M13", "M14", "M5", "M17"]);
    assert.equal(names.includes("M7"), false);
    assert.equal(names.includes("M9"), false);
    const arms = cumulativeArms();
    assert.deepEqual(arms[0]?.lines, []);
    assert.deepEqual(arms[3]?.lines, ["M1", "M10", "M2"], "M2 is M0 + M1 + M10 + M2 (Ruling 8)");
    assert.equal(arms.at(-1)?.lines.length, 17, "M17 comes last: every line there is but the suspended two");
  });

  it("are all runnable lines: each resolves against the registry", () => {
    assert.deepEqual(ablationProblems(base, cumulativeArms()), []);
  });

  it("are chosen by name, and a name that is not one is refused", () => {
    assert.deepEqual(cumulativeArms(["M0", "M12"]).map((a) => a.lines.length), [0, 5]);
    assert.throws(() => cumulativeArms(["M99"]), RunSetupError);
  });

  it("refuse a turn limit and the human breakpoints (Task 17), an off-peak wait, a suspended line and a twin name", () => {
    assert.match(ablationProblems({ ...base, consortium: consortium({ tokens: 5000 }) }, cumulativeArms(["M0"])).join(), /a turn limit or --human cannot go with an ablation/);
    assert.match(ablationProblems({ ...base, offpeak: {} }, cumulativeArms(["M0"])).join(), /--offpeak/);
    assert.match(ablationProblems(base, [{ name: "x", description: "", lines: ["M7"] }]).join(), /line M7 .* is suspended/);
    assert.match(ablationProblems(base, [{ name: "x", description: "", lines: [] }, { name: "x", description: "", lines: [] }]).join(), /two arms are named x/);
    assert.match(ablationProblems(base, [{ name: "x", description: "", lines: ["M1"], lineOptions: { M1: { nothing: 1 } } }]).join(), /no option nothing/);
    assert.match(ablationProblems(base, [{ name: "x", description: "", lines: [], versus: "y" }]).join(), /compared with y/);
  });

  it("give each run the table's configuration with the arm's lines, options and settings", () => {
    const arm: Arm = { name: "a", description: "", lines: ["M1"], lineOptions: { M1: {} }, packetMode: "append_only", decide: { backend: "jev" }, tools: ["lean.lsp"], model: "faux/other" };
    const config = armConfig({ ...base, lines: ["M12"], tools: [], budget: { problemUsd: 2 } }, arm);
    assert.deepEqual([config.lines, config.packetMode, config.decide, config.tools, config.model, config.budget.problemUsd], [["M1"], "append_only", { backend: "jev" }, ["lean.lsp"], "faux/other", 2]);
    assert.equal("lines" in armConfig(base, { name: "m0", description: "", lines: [] }), false);
  });
});

function fakeRun(specs: Record<string, ScriptedSpec>, seen: RunOptions[] = []): (o: RunOptions) => Promise<RunResult> {
  return async (o) => {
    seen.push(o);
    const key = `${o.config.lines?.join("+") ?? "M0"}${o.memoryFrom !== undefined ? ":on-memory" : ""}`;
    const spec = specs[key] ?? specs["*"];
    if (spec === undefined) throw new Error(`no script for ${key}`);
    const run = scriptedRun(spec, o.dir);
    const report = buildReport(run.events);
    return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
  };
}

describe("runAblation on scripted runs", () => {
  const problems = ["p1", "p2", "p3"].map((id) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry);
  const specs: Record<string, ScriptedSpec> = {
    M0: { problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }, { id: "p3", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] },
    M1: { lines: ["M1"], problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }, { id: "p3", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] },
    "M1+M10": { lines: ["M1", "M10"], problems: [{ id: "p1", outcome: "proved", settledBy: "line:M10" }, { id: "p2", outcome: "candidate", attempts: [{ outcome: "valid", usd: 0.3 }] }, { id: "p3", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] },
  };
  const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions;

  it("runs each arm on the same problems and measures each from its journal", async () => {
    const seen: RunOptions[] = [];
    const dir = tempDir("mh-ablate-run-");
    const result = await runAblation({ template, config: base, problems, arms: cumulativeArms(["M0", "M1", "M10"]), dir, run: fakeRun(specs, seen) });
    assert.deepEqual(result.arms.map((a) => [a.arm.name, a.measures.solved]), [["M0", 1], ["M1", 1], ["M10", 2]]);
    assert.deepEqual(seen.map((o) => o.config.lines ?? []), [[], ["M1"], ["M1", "M10"]]);
    for (const o of seen) {
      assert.deepEqual(o.problems.map((p) => p.id), ["p1", "p2", "p3"]);
      assert.equal(o.config.seed, "ablate", "every arm draws from one seed");
      assert.equal(o.config.budget.problemUsd, base.budget.problemUsd, "the budget is the table's");
    }
    assert.equal(JSON.parse(readFileSync(join(dir, "ablation.json"), "utf8")).arms.length, 3);
  });

  it("says whether each arm beats the one before it, and by which problems", async () => {
    const result = await runAblation({ template, config: base, problems, arms: cumulativeArms(["M0", "M1", "M10"]), dir: tempDir("mh-ablate-run-"), run: fakeRun(specs) });
    const [, m1, m10] = result.arms;
    assert.equal(m1?.comparison?.verdict, "does not beat", "M1 solves what M0 did, at the same price");
    assert.equal(m10?.comparison?.verdict, "beats");
    assert.deepEqual(m10?.comparison?.onlyThis, ["p2"]);
    assert.deepEqual(m10?.comparison?.onlyThat, []);
    assert.equal(result.arms[0]?.comparison, undefined);
  });

  it("splits the problems by M0's outcomes, which no comparison depends on, and gives M0 no split of its own", async () => {
    const result = await runAblation({ template, config: base, problems, arms: cumulativeArms(["M0", "M1", "M10"]), dir: tempDir("mh-ablate-run-"), run: fakeRun(specs) });
    const m10 = result.arms[2];
    assert.deepEqual([m10?.difficulty?.easy.solved, m10?.difficulty?.easy.problems, m10?.difficulty?.hard.solved, m10?.difficulty?.hard.problems], [1, 1, 1, 2]);
    assert.equal(result.arms[0]?.difficulty, undefined, "M0's split would be by construction");
    assert.equal(result.difficultyBasis, "M0");
    assert.match(renderAblation(result), /M0 has no row here because its split is by construction/);
  });

  it("gives no split when the table has no arm outside the comparison and no pilot, and splits by a pilot when one is given", async () => {
    const arms = cumulativeArms(["M1", "M10"]);
    const none = await runAblation({ template, config: base, problems, arms, dir: tempDir("mh-ablate-run-"), run: fakeRun(specs) });
    assert.equal(none.difficultyBasis, undefined);
    assert.ok(none.arms.every((a) => a.difficulty === undefined));
    assert.match(renderAblation(none), /Not split: the table has no arm that no comparison depends on/);
    const pilot = measureRun(scriptedRun(specs.M0 as ScriptedSpec).events);
    const piloted = await runAblation({ template, config: base, problems, arms, dir: tempDir("mh-ablate-run-"), run: fakeRun(specs), pilot });
    assert.equal(piloted.difficultyBasis, "a pilot run");
    assert.ok(piloted.arms.every((a) => a.difficulty !== undefined), "every arm is split, the first included");
  });

  it("renders the table of plan section 6", async () => {
    const result = await runAblation({ template, config: base, problems, arms: cumulativeArms(["M0", "M1", "M10"]), dir: tempDir("mh-ablate-run-"), run: fakeRun(specs) });
    const text = renderAblation(result);
    for (const heading of ["| Configuration | Solved |", "Per solve ($)", "Tokens per solve", "Redundant", "Mean context", "Tool defs", "Memory", "Subgoals w/o model", "CPU ms", "## Does it beat the one before it", "## Diversity, reuse and novelty", "## Difficulty", "## Spend by site"]) {
      assert.ok(text.includes(heading), heading);
    }
    assert.match(text, /\| M10 \| 2\/3 \| 1 \|/);
    assert.match(text, /M10 against M1: beats: M10 solves 2 against 1/);
  });

  it("builds the memory on one part and measures it on another when the bench is split", async () => {
    const seen: RunOptions[] = [];
    const build = [{ id: "b1", path: "Other.lean" }] as unknown as ProblemEntry[];
    const result = await runAblation({
      template,
      config: base,
      problems,
      buildProblems: build,
      arms: cumulativeArms(["M0"]),
      dir: tempDir("mh-ablate-run-"),
      run: fakeRun({ M0: specs.M0 as ScriptedSpec, "M0:on-memory": specs.M0 as ScriptedSpec }, seen),
    });
    assert.deepEqual(seen.map((o) => [o.problems.map((p) => p.id), o.memoryFrom === undefined ? null : "build"]), [[["b1"], null], [["p1", "p2", "p3"], "build"]]);
    assert.ok(result.arms[0]?.build);
    assert.deepEqual(result.buildProblems, ["b1"]);
    assert.match(renderAblation(result), /## Memory built on one part and measured on another/);
  });

  it("refuses to start when the configuration would not be an ablation", async () => {
    await assert.rejects(runAblation({ template, config: { ...base, consortium: consortium({ usd: 1 }) }, problems, arms: cumulativeArms(["M0"]), dir: tempDir("mh-ablate-run-"), run: fakeRun(specs) }), /cannot go with an ablation/);
  });
});

describe("an ablation that is cut off", () => {
  const problems = ["p1", "p2"].map((id) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry);
  const spec: ScriptedSpec = { problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] };
  const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions;

  it("keeps the arms that finished, sets the cut one aside and runs only what is left, spending nothing twice", async () => {
    const dir = tempDir("mh-ablate-resume-");
    const arms = cumulativeArms(["M0", "M1", "M10", "M2"]);
    const first: string[] = [];
    const killAtThird = async (o: RunOptions): Promise<RunResult> => {
      first.push(o.config.lines?.join("+") ?? "M0");
      if (first.length === 3) {
        scriptedRun(spec, o.dir); // a half-written journal of the third arm, then the process dies
        throw new Error("killed");
      }
      return fakeRun({ "*": spec })(o);
    };
    await assert.rejects(runAblation({ template, config: base, problems, arms, dir, run: killAtThird }), /killed/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "ablation.partial.json"), "utf8")).done.map((d: { arm: string }) => d.arm), ["M0", "M1"]);
    const second: string[] = [];
    const result = await runAblation({
      template,
      config: base,
      problems,
      arms,
      dir,
      run: async (o) => {
        second.push(o.config.lines?.join("+") ?? "M0");
        return fakeRun({ "*": spec })(o);
      },
    });
    assert.deepEqual(second, ["M1+M10", "M1+M10+M2"], "only the third and fourth arms run");
    assert.deepEqual(result.arms.map((a) => a.arm.name), ["M0", "M1", "M10", "M2"]);
    assert.ok(existsSync(join(dir, "arms", "M10.partial-1")), "the cut arm is set aside, not deleted");
    assert.ok(result.arms.every((a) => a.measures.solved === 1));
  });

  it("refuses a directory whose finished arms were made with other problems", async () => {
    const dir = tempDir("mh-ablate-resume-");
    const arms = cumulativeArms(["M0"]);
    await runAblation({ template, config: base, problems, arms, dir, run: fakeRun({ "*": spec }) });
    await assert.rejects(runAblation({ template, config: base, problems: problems.slice(0, 1), arms, dir, run: fakeRun({ "*": spec }) }), /another configuration, other problems or another bench/);
  });
});

describe("compareArms", () => {
  const m = (...problems: Array<[string, "proved" | "unsolved", number]>) =>
    measureRun(scriptedRun({ problems: problems.map(([id, outcome, usd]) => ({ id, outcome, attempts: [{ outcome: outcome === "proved" ? ("valid" as const) : ("invalid" as const), usd }] })) }).events);

  it("calls an arm that solves as many for less a winner, and one that costs more not", () => {
    assert.equal(compareArms("b", m(["p1", "proved", 0.1]), { name: "a", measures: m(["p1", "proved", 0.2]) }).verdict, "beats");
    assert.equal(compareArms("b", m(["p1", "proved", 0.3]), { name: "a", measures: m(["p1", "proved", 0.2]) }).verdict, "does not beat");
  });

  it("gives no verdict between arms that did not finish the same problems, and compares on the ones both finished", () => {
    const whole = m(["p1", "proved", 0.1], ["p2", "unsolved", 0.1], ["p3", "unsolved", 0.1]);
    const cut = m(["p1", "proved", 0.1]);
    const c = compareArms("cut", cut, { name: "whole", measures: whole });
    assert.equal(c.verdict, "not comparable");
    assert.equal(c.common, 1);
    assert.match(c.reason, /finished 1 problems and whole 3 \(1 in common\)/);
  });

  it("reports the pairs and says a difference of one problem is indicative only", () => {
    const base = m(["p1", "unsolved", 0.1], ["p2", "unsolved", 0.1], ["p3", "unsolved", 0.1]);
    const one = compareArms("x", m(["p1", "proved", 0.1], ["p2", "unsolved", 0.1], ["p3", "unsolved", 0.1]), { name: "base", measures: base });
    assert.deepEqual([one.verdict, one.onlyThis, one.onlyThat, one.common], ["beats", ["p1"], [], 3]);
    assert.match(one.reason, /indicative only/);
    const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const strong = compareArms("x", m(...ids.map((id): [string, "proved", number] => [id, "proved", 0.1])), { name: "base", measures: m(...ids.map((id): [string, "unsolved", number] => [id, "unsolved", 0.1])) });
    assert.equal(strong.verdict, "beats");
    assert.doesNotMatch(strong.reason, /indicative/);
    assert.ok(strong.pSolves < 0.01);
  });
});

describe("runAblation on the simulated stack", () => {
  it("runs M0 and M1 on a small simulated bench with the faux model and the simulated Lean", async () => {
    const bench = demoBench();
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("bad"), check("exact trivial_proof"), check("exact trivial_proof")]);
    const lean = new DemoLean();
    const dir = tempDir("mh-ablate-sim-");
    const result = await runAblation({
      template: { index: bench.index, checkout: bench.checkout, models, registry: demoRegistry(lean) },
      config: demoConfig(name),
      problems: bench.index.problems.slice(0, 1),
      arms: cumulativeArms(["M0", "M1"]),
      dir,
    });
    assert.equal(result.arms.length, 2);
    assert.equal(result.arms[0]?.measures.solved, 1);
    assert.equal(result.arms[1]?.measures.solved, 1);
    assert.match(renderAblation(result), /\| M0 \| 1\/1 \|/);
  });
});
