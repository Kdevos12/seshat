import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ablationProblems, armConfig, compareArms } from "../src/ablation.ts";
import { allLines, DECIDE_SITES, EXPERIMENTS, experimentArms, experimentNames } from "../src/experiments.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult, RunSetupError } from "../src/index.ts";
import { type ProblemEntry } from "@seshat/bench";
import { runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { COMPUTE_TOOL, INTAKE_ALLOWANCE_SHARE, studentConfig } from "../src/student.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
void compareArms;

describe("the experiments", () => {
  it("name every amendment's experiment", () => {
    assert.deepEqual(experimentNames(), ["ladder", "packet-mode", "renderings", "queries", "seeds", "lessons", "cegis", "lsp", "decide", "gate", "heuristics", "solve-defaults", "m17"]);
    assert.ok(EXPERIMENTS.every((e) => e.notRun.length > 0 && e.amendment.length > 0));
  });

  it("build arms that a run accepts, with distinct names and a baseline each arm is set against", () => {
    for (const e of EXPERIMENTS) {
      const arms = experimentArms(e.name, { models: ["faux/a", "faux/b"] });
      assert.ok(arms.length >= 2, e.name);
      assert.deepEqual(ablationProblems(base, arms), [], e.name);
      const names = arms.map((a) => a.name);
      for (const a of arms) if (a.versus !== undefined) assert.ok(names.includes(a.versus), `${e.name}: ${a.name} versus ${a.versus}`);
    }
  });

  it("set the ladder against all rungs and rung 0 alone", () => {
    const [ladder, all, zero] = experimentArms("ladder");
    assert.equal(ladder?.lineOptions?.M12?.ladder, true);
    assert.equal(all?.lineOptions?.M12?.ladder, false);
    assert.equal(zero?.lines.some((id) => ["M18", "M15", "M16"].includes(id)), false);
    assert.ok(allLines().includes("M18"));
  });

  it("run the three packet modes and the naive packet, and the renderings per model", () => {
    assert.deepEqual(experimentArms("packet-mode").map((a) => a.packetMode ?? "naive"), ["prefix_tail", "append_only", "recompiled", "naive"]);
    const r = experimentArms("renderings", { models: ["faux/a", "faux/b"] });
    assert.equal(r.length, 6);
    assert.equal(r[4]?.versus, "list (faux/b)");
  });

  it("ask Jev one site at a time, for every site of J3", () => {
    const arms = experimentArms("decide");
    assert.equal(arms.length, DECIDE_SITES.length + 1);
    assert.deepEqual(DECIDE_SITES.sort(), ["conjecture.relevance", "fleet.cold_start", "prove.search.order"]);
  });

  it("measure the budget gate in four arms that differ by the gate and by who answers its cold starts and ties", () => {
    const arms = experimentArms("gate");
    assert.deepEqual(arms.map((a) => a.name), ["no-gate", "rule", "rule+llm", "rule+jev"]);
    assert.deepEqual(arms.map((a) => a.versus), [undefined, "no-gate", "rule", "rule+llm"]);
    assert.equal(arms[0]?.gate, false);
    assert.deepEqual(arms[1]?.decide?.sites, { "budget.wave": "off", "budget.line": "off" });
    assert.equal(arms[3]?.decide?.sites?.["budget.wave"], "jev");
    assert.deepEqual(arms[2]?.lines, arms[0]?.lines);
    // The J3 experiment does not list the gate's sites.
    assert.ok(!DECIDE_SITES.some((s) => s.startsWith("budget.")));
    const table = { gate: { floor: 0.2 } } as never;
    assert.equal(armConfig(table, arms[0] as never).gate, undefined, "false takes the table's gate away");
    assert.deepEqual(armConfig({} as never, arms[1] as never).gate, {});
    assert.deepEqual(armConfig(table, { name: "x", description: "", lines: [] }).gate, { floor: 0.2 }, "an arm with no gate setting keeps the table's");
  });

  it("isolate the counterexample set: the two arms differ by one option of M8 and nothing else", () => {
    const [off, on] = experimentArms("cegis");
    assert.deepEqual(off?.lines, on?.lines);
    assert.equal(off?.lineOptions?.M8?.counterexampleSet, false);
    assert.equal(on?.lineOptions?.M8?.counterexampleSet, true);
  });

  it("compare the fleet alone, with the directives and with the bank, by the fleet's option only", () => {
    const arms = experimentArms("heuristics");
    assert.deepEqual(arms.map((a) => [a.name, a.versus]), [["fleet", undefined], ["directives", "fleet"], ["cards", "directives"]]);
    assert.deepEqual(arms.map((a) => a.lineOptions?.fleet), [undefined, { directives: true }, { heuristics: true }]);
    assert.deepEqual(arms[2]?.lines, arms[0]?.lines);
  });

  it("refuse a name that is not an experiment", () => {
    assert.throws(() => experimentArms("nothing"), RunSetupError);
  });
});

/** What differs between an arm and what `solve` builds, by design: the arm takes the table's selection, budget, consortium and model; the person's yes is the bench's. */
const TABLE_OR_PERSON_FIELDS = ["selection", "budget", "consortium", "model"] as const;
const withoutTableFields = (c: RunConfig): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...c };
  for (const k of TABLE_OR_PERSON_FIELDS) delete copy[k];
  if (copy.intake !== undefined) {
    const { consent: _consent, ...intake } = copy.intake as Record<string, unknown>;
    copy.intake = intake;
  }
  return copy;
};
const tableBase: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } };
const offersAll = { capabilities: { "compute.sage": {}, "lean.search": {}, "lean.lsp": {} } };

describe("the solve-defaults experiment", () => {
  const arms = experimentArms("solve-defaults", { host: offersAll });
  const arm = (name: string) => arms.find((a) => a.name === name) ?? assert.fail(name);

  it("sets solve-v2 against solve-v1, the baseline", () => {
    assert.deepEqual(arms.map((a) => [a.name, a.versus]), [["solve-v1", undefined], ["solve-v2", "solve-v1"], ["solve-v2-blueprints", "solve-v2"], ["solve-v2-graph", "solve-v2"], ["solve-v2-blueprints-refine", "solve-v2-blueprints"], ["solve-v2-informal", "solve-v2"]]);
  });

  it("makes the blueprints arm solve-v2 plus line M12 with blueprints, and nothing else", () => {
    const { lines: v2Lines, lineOptions: v2Options, ...v2 } = armConfig(base, arm("solve-v2"));
    const { lines, lineOptions, ...blueprints } = armConfig(base, arm("solve-v2-blueprints"));
    assert.deepEqual(blueprints, v2);
    assert.deepEqual(lines, [...(v2Lines ?? []), "M12"]);
    assert.deepEqual(lineOptions, { ...v2Options, M12: { blueprints: true } });
  });

  it("makes the refine arm the blueprints arm plus refine and repair, and nothing else", () => {
    const { lines: bpLines, lineOptions: bpOptions, ...blueprints } = armConfig(base, arm("solve-v2-blueprints"));
    const { lines, lineOptions, informalFirst, ...refine } = armConfig(base, arm("solve-v2-blueprints-refine"));
    assert.deepEqual(refine, blueprints);
    assert.deepEqual(informalFirst, {}, "its planner gets the informal proof too, with the defaults");
    assert.deepEqual(lines, bpLines);
    assert.deepEqual(lineOptions, { ...bpOptions, M12: { blueprints: true, refine: true, repair: true } });
  });

  it("makes the informal arm solve-v2 plus informalFirst with its defaults, and nothing else", () => {
    const v2 = armConfig(base, arm("solve-v2"));
    const { informalFirst, ...informal } = armConfig(base, arm("solve-v2-informal"));
    assert.deepEqual(informal, v2);
    assert.deepEqual(informalFirst, {});
    assert.equal(arm("solve-v2-informal").versus, "solve-v2");
    assert.equal(v2.informalFirst, undefined, "solve-v2 has none");
  });

  it("makes the graph arm solve-v2 plus lines M2 and M4 with their default options, and nothing else", () => {
    const { lines: v2Lines, lineOptions: v2Options, ...v2 } = armConfig(base, arm("solve-v2"));
    const { lines, lineOptions, ...graph } = armConfig(base, arm("solve-v2-graph"));
    assert.deepEqual(graph, v2);
    assert.deepEqual(lines, [...(v2Lines ?? []), "M2", "M4"]);
    assert.deepEqual(lineOptions, v2Options);
    assert.ok(lines?.includes("M1") && lines.includes("M10") && lines.includes("M6"), "the lines v2 has stay");
  });

  for (const defaults of ["v1", "v2"] as const) {
    it(`gives the ${defaults} arm what solve builds, but for the table's fields and the person's yes`, () => {
      const additions: Partial<RunConfig> =
        defaults === "v2"
          ? { autoTool: "compute.sage", leanSearch: true, tools: ["lean.lsp"], optionalTools: ["lean.lsp"], intake: { hygiene: true, literature: true, consent: { allowed: true, via: "asked" }, capShare: INTAKE_ALLOWANCE_SHARE } }
          : {};
      assert.equal(COMPUTE_TOOL, "compute.sage");
      const solved = studentConfig({ selection: { all: true }, model: "faux/prover", maxUsd: 1, defaults, base: additions });
      const fromArm = armConfig(tableBase, arm(`solve-${defaults}`));
      assert.deepEqual(withoutTableFields(fromArm), withoutTableFields(solved));
    });
  }

  it("leaves the additions out of solve-v1", () => {
    const v1 = armConfig(tableBase, arm("solve-v1"));
    assert.equal(v1.intake, undefined);
    assert.equal(v1.autoTool, undefined);
    assert.equal(v1.leanSearch, undefined);
    assert.deepEqual(withoutTableFields(v1), withoutTableFields(studentConfig({ selection: { all: true }, model: "faux/prover", maxUsd: 1, defaults: "v1", base: {} })));
  });

  it("gives solve-v2 the intake but not a capability the host does not offer", () => {
    const bare = experimentArms("solve-defaults", { host: { capabilities: {} } }).find((a) => a.name === "solve-v2");
    const config = armConfig(base, bare ?? assert.fail("solve-v2"));
    assert.equal(config.autoTool, undefined);
    assert.equal(config.leanSearch, undefined);
    assert.equal(config.intake?.consent?.allowed, true);
    assert.equal(armConfig(base, arm("solve-v2")).autoTool, "compute.sage");
    assert.equal(armConfig(base, arm("solve-v2")).leanSearch, true);
    assert.equal(config.tools, base.tools, "no lean.lsp where the host lacks it");
    assert.deepEqual(armConfig(base, arm("solve-v2")).tools, ["lean.lsp"]);
    assert.deepEqual(armConfig(base, arm("solve-v1")).tools, base.tools, "v1 adds no tool");
  });

  const problems = ["p1", "p2"].map((id) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry);
  const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions;
  const run = (seen: RunOptions[]) => async (o: RunOptions): Promise<RunResult> => {
    seen.push(o);
    const scripted = scriptedRun({ problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] }, o.dir);
    const report = buildReport(scripted.events);
    return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
  };

  it("renders the paired protocol with solve-v1 as the baseline", async () => {
    const result = await runAblation({ template, config: base, problems, arms, dir: tempDir("mh-solve-defaults-"), run: run([]) });
    assert.equal(result.protocol?.baseline, "solve-v1");
    const table = renderAblation(result);
    assert.match(table, /## Paired protocol/);
    assert.match(table, /the baseline is solve-v1/);
  });

  it("keeps private in every arm's configuration", async () => {
    const seen: RunOptions[] = [];
    await runAblation({ template, config: { ...base, private: true }, problems, arms, dir: tempDir("mh-solve-defaults-"), run: run(seen) });
    assert.equal(seen.length, arms.length);
    assert.ok(seen.every((o) => o.config.private === true));
  });
});
