import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyChain } from "@seshat/core";
import { LINE_ORDER, SUSPENDED_LINES } from "@seshat/lines";
import { type Arm, cumulativeArms, cumulativeNames, runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { allLines } from "../src/experiments.ts";
import { measureRun } from "../src/measures.ts";
import { buildReport, renderRunReport } from "../src/index.ts";
import { leanEnvPins, registryForPins } from "./lean-env-pins.ts";
import { check, config as demoConfig, DemoLean, demoBench, demoRun, fauxModels, ofType, tempDir } from "./m0-helpers.ts";

/**
 * Task 14, deliverable 4: the end-to-end run with every line on, the faux model and the simulated Lean. Lines M7 and M9 are
 * suspended (Ruling 20) and are not part of it. Nothing here ran against a real Lean, model or program.
 */
const EVERY = LINE_ORDER.filter((id) => !SUSPENDED_LINES.has(id));
const answers = (n: number) => Array.from({ length: n }, () => check("exact trivial_proof"));

describe("every line in one run", () => {
  it("composes the lines in plan order, settles the problem, and leaves a journal, a report and the measures", async () => {
    const pins = await leanEnvPins();
    const lean = new DemoLean();
    const { events, result } = await demoRun({ lean, registry: (l) => registryForPins(pins, l), config: { lines: allLines(), sessions: 2 }, responses: answers(150) });
    assert.deepEqual(allLines(), EVERY);
    const started = ofType(events, "run.started")[0]?.data.config as { lines?: Array<{ id: string }>; leanEnv?: { name: string } };
    assert.deepEqual(started.lines?.map((l) => l.id), EVERY, "every line, in plan section 7's order");
    assert.equal(started.leanEnv?.name, "extended", "M17 puts the run in the extended environment");
    assert.equal(result.stopped, undefined);
    assert.ok(["candidate", "proved"].includes(result.problems[0]?.outcome as string));
    assert.deepEqual(verifyChain(events), { ok: true });
    const report = buildReport(events);
    assert.match(renderRunReport(report), /Run/);
    const m = measureRun(events, { report });
    assert.equal(m.solved, 1);
    assert.equal(m.problems, 1);
    assert.ok(m.usd >= 0);
  });

  it("gives every line the same problem and leaves no line's hook unrun: no ledger task is left running", async () => {
    const pins = await leanEnvPins();
    const { events } = await demoRun({ registry: (l) => registryForPins(pins, l), config: { lines: allLines(), sessions: 2 }, responses: answers(150) });
    const created = new Set(ofType(events, "task.created").map((e) => e.data.taskId));
    const ended = new Set(ofType(events, "task.status_changed").filter((e) => ["done", "failed", "cancelled", "blocked"].includes(e.data.to)).map((e) => e.data.taskId));
    for (const id of created) assert.ok(ended.has(id), `task ${id} ended`);
  });
});

describe("the whole cumulative list through harness ablate", () => {
  it("runs M0 and every line added in turn on the same problem at the same budget, and writes the table", async () => {
    const pins = await leanEnvPins();
    const bench = demoBench();
    const { models, faux, name } = fauxModels();
    faux.setResponses(answers(18 * 150));
    const lean = new DemoLean();
    const arms: Arm[] = cumulativeArms();
    const result = await runAblation({
      template: { index: bench.index, checkout: bench.checkout, models, registry: registryForPins(pins, lean) },
      config: demoConfig(name, { sessions: 2 }),
      problems: bench.index.problems.slice(0, 1),
      arms,
      dir: tempDir("mh-ablate-all-"),
    });
    assert.deepEqual(result.arms.map((a) => a.arm.name), cumulativeNames());
    assert.equal(result.arms.length, 18);
    assert.ok(result.arms.every((a) => a.stopped === undefined), "no arm stopped early");
    assert.ok(result.arms.every((a) => a.measures.solved === 1));
    const table = renderAblation(result);
    for (const arm of arms) assert.match(table, new RegExp(`\\| ${arm.name} \\| 1/1 \\|`));
    assert.equal(table.includes("M7"), false);
    assert.equal(table.includes("M9 "), false);
  });
});
