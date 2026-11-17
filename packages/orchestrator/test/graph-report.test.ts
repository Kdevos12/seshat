import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Arm, runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { buildReport, graphReport, renderRunReport } from "../src/index.ts";
import { leanEnvPins, registryForPins } from "./lean-env-pins.ts";
import { check, config as demoConfig, DemoLean, demoBench, demoRun, fauxModels, tempDir } from "./m0-helpers.ts";

/** The counts of lines M2 and M4 in the run's report and the ablation's table (plan change KG1): from the journal alone, only when a line ran. */
const answers = (n: number) => Array.from({ length: n }, () => check("exact trivial_proof"));

describe("the graph and context counts of a run", () => {
  it("are in the report when M2 and M4 ran, from the journal", async () => {
    const { events } = await demoRun({ config: { lines: ["M2", "M4"], sessions: 2 }, responses: answers(20) });
    const report = buildReport(events);
    assert.deepEqual(report.graph, graphReport(events, ["M2", "M4"]));
    const context = report.graph?.context;
    assert.ok(context !== undefined && context.packets >= 1 && context.packetTokens > 0);
    assert.equal(context?.expandCalls, 0);
    assert.equal(context?.graphQueryCalls, 0);
    assert.ok(report.graph?.graph !== undefined && report.graph.graph.variants >= 1 && report.graph.graph.edges >= 1);
    assert.match(renderRunReport(report), /Context compiler \(M4\): \d+ packet\(s\) of \d+ token\(s\) in all, \d+ fact\(s\) shown; the provers called expand 0 time\(s\) and graph_query 0 time\(s\)\./);
    assert.match(renderRunReport(report), /Graph \(M2\): \d+ variant\(s\) created, \d+ edge\(s\) added, \d+ of them lean_checked\./);
  });

  it("show only the line that ran, and not at all when neither did", async () => {
    const onlyM4 = await demoRun({ config: { lines: ["M4"], sessions: 2 }, responses: answers(20) });
    const four = buildReport(onlyM4.events).graph;
    assert.ok(four?.context !== undefined);
    assert.equal(four?.graph, undefined);
    const none = await demoRun({ config: { sessions: 2 }, responses: answers(20) });
    const report = buildReport(none.events);
    assert.equal(report.graph, undefined);
    assert.doesNotMatch(renderRunReport(report), /Context compiler|Graph \(M2\)/);
    assert.equal(graphReport(none.events, []), undefined);
    assert.equal(graphReport(none.events, undefined), undefined);
  });

  it("are a section of the ablation's table for the arms that have them, with a dash for a line that did not run", async () => {
    const pins = await leanEnvPins();
    const bench = demoBench();
    const { models, faux, name } = fauxModels();
    faux.setResponses(answers(4 * 150));
    const arms: Arm[] = [
      { name: "plain", description: "no line", lines: [] },
      { name: "graph", description: "M2 and M4", lines: ["M2", "M4"], versus: "plain" },
      { name: "context", description: "M4 alone", lines: ["M4"], versus: "plain" },
    ];
    const result = await runAblation({
      template: { index: bench.index, checkout: bench.checkout, models, registry: registryForPins(pins, new DemoLean()) },
      config: demoConfig(name, { sessions: 2 }),
      problems: bench.index.problems.slice(0, 1),
      arms,
      dir: tempDir("mh-ablate-graph-"),
    });
    assert.equal(result.arms[0]?.measures.graph, undefined);
    const text = renderAblation(result);
    assert.match(text, /## Graph and context counts/);
    assert.match(text, /\| graph \| \d+ \| \d+ \| \d+ \| 0 \| 0 \| \d+ \| \d+ \| \d+ \|/);
    assert.match(text, /\| context \| \d+ \| \d+ \| \d+ \| 0 \| 0 \| - \| - \| - \|/);
    assert.doesNotMatch(text, /\| plain \| \d+ \| \d+ \| \d+ \| 0/);
  });
});
