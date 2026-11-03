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

  it("makes the lines that can act on a plain problem act, and says why the others stay quiet", async () => {
    const pins = await leanEnvPins();
    const { events, result } = await demoRun({ registry: (l) => registryForPins(pins, l), config: { lines: allLines(), sessions: 2 }, responses: answers(150) });
    const actors = new Set(events.map((e) => e.actor));
    // Each of these wrote at least one event of its own.
    for (const line of ["M10", "M2", "M11", "M8", "M13", "M4", "fleet", "M6", "M5"]) assert.ok(actors.has(`line:${line}`), `line ${line} acted`);
    const kinds = new Set(ofType(events, "node.recorded").map((e) => e.data.kind));
    for (const kind of ["battery_run", "fingerprint", "context_packet", "datatable", "watch", "lesson", "allocation"]) assert.ok(kinds.has(kind), `a ${kind} node`);
    // The others have nothing to do on a problem the battery settles and the first session proves:
    // M18, M15 and M16 are on rungs above 0 and the ladder never escalated (no stall in Lean progress);
    assert.equal(ofType(events, "ladder.escalated").length, 0);
    for (const line of ["M18", "M15", "M16"]) assert.equal(actors.has(`line:${line}`), false, `line ${line} waits for the ladder`);
    // M12 works named holes of a sketch and the demo proof has none; M3 promotes auxiliary lemmas and the proof has none;
    // M14 repairs refuted conjectures and none was refuted; M1 acts as the identity of every claim (their `st` ids), not with events of its own.
    assert.equal(ofType(events, "edge.added").some((e) => e.data.kind === "decomposes_into"), false);
    assert.equal(kinds.has("library_lemma"), false);
    assert.ok(ofType(events, "claim.created").every((e) => e.data.statementId.length > 0));
    assert.ok(result.problems[0] !== undefined);
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
