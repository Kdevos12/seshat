import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { LINE_ORDER } from "@seshat/lines";
import { archiveReport, createM12Line, createM15Line, type HintData, M15_ARCHIVE_KIND, M15_HINT_KIND, M15_PICK_KIND, type PickData } from "@seshat/scheduler";
import { SCHEMA_KIND } from "@seshat/library";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { m12Answer } from "./m12-helpers.ts";
import { buildReport, renderRunReport } from "../src/index.ts";
import { AUX, AUXK, ConfirmingMeta, confirmations, metaRegistry, SKETCH_PROOF, TWO_FILE } from "./m15-helpers.ts";
import { certifier, sessionPromptOf } from "./resume-helpers.ts";

const json = (proof: string) => say(JSON.stringify({ proof }));
const SECTION = "Decompositions that closed before";

/** One problem as the ladder drives it: a session that fails, a session that submits the sketch, and the inner provers closing its holes. */
const problem = (aux: string) => [check("bad"), say("notes"), check(SKETCH_PROOF, aux), say("notes"), json("exact hole_ok"), json("exact hole_ok")];

interface Options {
  seed?: number;
  problems?: number;
  meta?: ConfirmingMeta;
  m15?: Record<string, unknown>;
  file?: string;
}

/** Runs the two-problem file (or the first problem only) with M12 and M15 and records the prompt each session was given. */
async function run(o: Options = {}) {
  const meta = o.meta ?? new ConfirmingMeta();
  const prompts: string[] = [];
  const logs: string[] = [];
  const watch = (step: ReturnType<typeof say>) => (context: Parameters<typeof sessionPromptOf>[0]) => {
    if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
    return step;
  };
  const done = await demoRun({
    lines: { M12: createM12Line(), M15: createM15Line() },
    config: {
      lines: ["M12", "M15"], provers: 1, sessions: 3, budget: { problemUsd: 0.05 }, seed: o.seed ?? 1,
      lineOptions: { M12: { fractions: [0.1], innerSessions: 1, rounds: 1 }, ...(o.m15 !== undefined ? { M15: o.m15 } : {}) } as never,
    },
    lean: new DemoLean(m12Answer),
    registry: metaRegistry(meta),
    certifier: certifier().certifier,
    problems: o.problems ?? 2,
    file: o.file ?? TWO_FILE,
    log: (l) => logs.push(l),
    responses: [...problem(AUX), ...problem(AUXK)].map(watch),
  });
  return { ...done, meta, prompts, logs };
}

const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind);
const hintsOf = (events: readonly HarnessEvent[]) => nodes(events, M15_HINT_KIND).map((e) => e.data.data as unknown as HintData);

describe("line M15", () => {
  it("is registered after M3, as a rung of the ladder that needs M12 and keeps no state outside the journal", async () => {
    const line = createM15Line();
    assert.equal(line.id, "M15");
    assert.deepEqual([line.rung, line.requires, line.resume], [2, ["M12"], "stateless"]);
    assert.ok(line.hooks.beforeSession !== undefined && line.hooks.briefingSections !== undefined && line.hooks.afterProblem !== undefined);
    assert.equal(LINE_ORDER[LINE_ORDER.indexOf("M3") + 1], "M15");
  });

  it("keeps the decompositions of a solved problem, makes a schema of the closed one, and never touches a claim's status", { timeout: 60000 }, async () => {
    const { events, result } = await run({ problems: 1 });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["proved"]);
    const picks = nodes(events, M15_PICK_KIND);
    assert.ok(picks.length >= 1, "a session after the first decomposition was told which cell to extend");
    const [snapshot] = nodes(events, M15_ARCHIVE_KIND);
    assert.equal(nodes(events, M15_ARCHIVE_KIND).length, 1);
    const cells = (snapshot?.data.data as { cells: Array<{ key: string; rho: number; closed: number; leaves: number }> }).cells;
    assert.deepEqual(cells.map((c) => [c.key, c.rho, c.closed, c.leaves]), [["1|rewriting|2p:=", 1, 2, 2]]);
    const [schema] = nodes(events, SCHEMA_KIND);
    assert.equal(nodes(events, SCHEMA_KIND).length, 1);
    assert.match(String((schema?.data.data as { name: string }).name), /^schema_rewriting_\d{6}$/);
    // Picks, hints and schemas are learned from outcomes and carry the run's stamp; the snapshot is a reading of Lean's verdicts.
    for (const e of [...picks, ...(schema !== undefined ? [schema] : [])]) assert.ok(e.data.provenance !== undefined, `${e.data.kind} is stamped`);
    assert.equal(snapshot?.data.provenance, undefined);
    // The pick was settled: the session's sketch closed more than the elite, or not.
    assert.ok(picks.every((e) => ["improved", "not_improved", "void", undefined].includes((e.data.data as unknown as PickData).outcome)));
    const mine = events.filter((e) => e.actor === "line:M15");
    assert.ok(mine.length > 0);
    for (const e of mine) assert.ok(["node.recorded", "node.updated", "tool_run.started", "tool_run.finished"].includes(e.type), `line:M15 emitted ${e.type}`);
  });

  it("offers the schema of the first problem to the second: shown or withheld by the draw, as recorded, instantiated and confirmed by lean.meta", { timeout: 120000 }, async () => {
    const seen = new Set<boolean>();
    for (let seed = 1; seed <= 12 && seen.size < 2; seed += 1) {
      const meta = new ConfirmingMeta();
      const { events, prompts, result, logs } = await run({ seed, meta });
      assert.deepEqual(result.problems.map((p) => p.outcome), ["proved", "proved"], `seed ${seed}`);
      const started = ofType(events, "attempt.started");
      // A hint is written before the session starts; a session that never starts (the budget ended) leaves one that nobody read.
      const hints = hintsOf(events).filter((h) => started.some((e) => e.data.attemptId === h.attemptId));
      assert.ok(hints.length >= 1, `seed ${seed}: the second problem was offered the schema`);
      assert.ok(hints.every((h) => h.arm === "match" && h.problemId.endsWith("add_zero2'")), "only the second problem is offered one: the first has no schema but its own");
      for (const hint of hints) {
        const attempt = started.find((e) => e.data.attemptId === hint.attemptId);
        assert.equal(hint.shown, attempt?.data.included?.includes(hint.schemaId) === true, "the hint records what the draw did");
        assert.equal(!hint.shown, attempt?.data.withheld?.includes(hint.schemaId) === true);
        assert.deepEqual(hint.instance?.parts, [{ name: "aux_left", statement: "(k : ℕ) : 0 + k = k" }, { name: "aux_right", statement: "(k : ℕ) : k + 0 = 0 + k" }]);
        seen.add(hint.shown);
      }
      const shown = hints.filter((h) => h.shown).length;
      assert.equal(prompts.filter((p) => p.includes(SECTION)).length, shown, `seed ${seed}: exactly the sessions that were shown a schema read it`);
      if (shown > 0) assert.ok(prompts.some((p) => p.includes("lemma aux_left (k : ℕ) : 0 + k = k")), "the schema is written for the goal");
      const confirms = confirmations(meta);
      assert.ok(confirms.length >= 1 && confirms.every((statement) => statement === "(k : ℕ) : k + 0 = k"), "lean.meta was asked whether the goal is an instance");
      assert.ok(logs.some((l) => l.includes("archive: 1 schema made")));
    }
    assert.deepEqual([...seen].sort(), [false, true], "both a shown and a withheld hint were met in the seeds tried");
  });

  it("measures reuse by the shape of the session's sketch, whether the schema was shown or not", { timeout: 60000 }, async () => {
    const { events } = await run({ seed: 1 });
    const memoryHints = ofType(events, "node.updated").filter((e) => (e.data.patch as { reused?: boolean }).reused !== undefined);
    assert.ok(memoryHints.length >= 1);
    assert.ok(memoryHints.some((e) => (e.data.patch as { reused: boolean; matched: number }).reused === true && (e.data.patch as { matched: number }).matched === 2), "the sketch with the two parts of the schema reuses it");
  });

  it("offers no schema that lean.meta does not confirm, and says why", { timeout: 60000 }, async () => {
    for (const mode of ["no", "refuse"] as const) {
      const meta = new ConfirmingMeta();
      meta.mode = mode;
      const { events, logs, result } = await run({ meta });
      assert.deepEqual(result.problems.map((p) => p.outcome), ["proved", "proved"], mode);
      assert.equal(hintsOf(events).length, 0, mode);
      assert.ok(logs.some((l) => l.includes("not used")), `${mode}: the reason is logged`);
    }
  });

  it("takes the lexical match when confirm is off, and a random schema in the control arm", { timeout: 60000 }, async () => {
    const meta = new ConfirmingMeta();
    meta.mode = "no";
    const lexical = await run({ meta, m15: { confirm: false } });
    assert.ok(hintsOf(lexical.events).length >= 1);
    assert.equal(confirmations(meta).length, 0);
    const random = await run({ m15: { retrieval: "random" } });
    const hints = hintsOf(random.events);
    assert.ok(hints.length >= 1 && hints.every((h) => h.arm === "random" && h.instance === undefined));
  });

  it("can be told not to steer, not to hint, and not to extract", { timeout: 60000 }, async () => {
    const off = await run({ m15: { cells: false, hints: 0, extract: false } });
    assert.equal(nodes(off.events, M15_PICK_KIND).length, 0);
    assert.equal(nodes(off.events, M15_HINT_KIND).length, 0);
    assert.equal(nodes(off.events, SCHEMA_KIND).length, 0);
    assert.equal(nodes(off.events, M15_ARCHIVE_KIND).length, 2, "the archive is still read and recorded");
  });
});

describe("the report of line M15", () => {
  it("counts the cells, the mechanisms, the picks, the schemas and the hints of a run, and reads them from the journal alone", { timeout: 60000 }, async () => {
    const { events } = await run({ seed: 1 });
    const report = buildReport(events).archive;
    assert.ok(report !== undefined);
    assert.deepEqual([report.problems, report.cells, report.meanBestRho, report.families, report.entropy], [2, 2, 1, { rewriting: 2 }, 0]);
    assert.deepEqual(report.schemas, { made: 1, active: 1, superseded: 0, inactive: 0 }, "the second problem's decomposition has the shape of the first's: one more support, not a second schema");
    const [arm] = report.hints;
    assert.equal(arm?.arm, "match");
    assert.equal((arm?.shown.hints ?? 0) + (arm?.withheld.hints ?? 0), hintsOf(events).filter((h) => ofType(events, "attempt.started").some((e) => e.data.attemptId === h.attemptId)).length);
    const text = renderRunReport(buildReport(events));
    assert.match(text, /Archive \(line M15\): 2 problem\(s\)/);
    assert.match(text, /Schema hints, match retrieval/);
  });

  it("is absent from the report of a run without the line", () => {
    assert.equal(archiveReport([]), undefined);
  });
});
