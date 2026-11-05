import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ablationProblems, armConfig, compareArms } from "../src/ablation.ts";
import { allLines, DECIDE_SITES, EXPERIMENTS, experimentArms, experimentNames } from "../src/experiments.ts";
import { DEFAULT_CONFIG, type RunConfig, RunSetupError } from "../src/index.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
void compareArms;

describe("the experiments", () => {
  it("name every amendment's experiment", () => {
    assert.deepEqual(experimentNames(), ["ladder", "packet-mode", "renderings", "queries", "seeds", "lessons", "cegis", "lsp", "decide", "gate", "heuristics", "m17"]);
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
