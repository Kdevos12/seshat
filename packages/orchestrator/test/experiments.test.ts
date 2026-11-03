import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ablationProblems, compareArms } from "../src/ablation.ts";
import { allLines, DECIDE_SITES, EXPERIMENTS, experimentArms, experimentNames } from "../src/experiments.ts";
import { DEFAULT_CONFIG, type RunConfig, RunSetupError } from "../src/index.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
void compareArms;

describe("the experiments", () => {
  it("name every amendment's experiment", () => {
    assert.deepEqual(experimentNames(), ["ladder", "packet-mode", "renderings", "queries", "seeds", "lessons", "cegis", "lsp", "decide", "m17"]);
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

  it("refuse a name that is not an experiment", () => {
    assert.throws(() => experimentArms("nothing"), RunSetupError);
  });
});
