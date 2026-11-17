import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Line } from "@seshat/lines";
import { armConfig } from "../src/ablation.ts";
import { experimentArms } from "../src/experiments.ts";
import { LINES } from "../src/lines.ts";
import { DEFAULT_CONFIG } from "../src/run.ts";
import { DEFAULTS_SETS } from "../src/student.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";
import { certifier } from "./resume-helpers.ts";

/** Two solved problems of one domain, so that what the first teaches is in scope for the second. */
const FILE = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Doubling is adding. -/
@[category research solved, AMS 11]
theorem two_mul' (n : ℕ) : 2 * n = n + n := by
  sorry

end Demo
`;

type Step = Parameters<typeof demoRun>[0]["responses"][number];
type Context = Parameters<Extract<Step, (...args: never[]) => unknown>>[0];

function opening(context: Context): string {
  const message = context.messages.find((m) => m.role === "user");
  const content = message?.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

const arms = experimentArms("solve-defaults", { host: { capabilities: { "compute.sage": {}, "lean.search": {}, "lean.lsp": {} } } });

describe("lessons in solve (PA12)", () => {
  async function twoProblems(lines: string[]) {
    const prompts: string[] = [];
    const sessions = 6;
    const registry = { M1: LINES.M1 as Line, M5: LINES.M5 as Line };
    const { events } = await demoRun({
      lines: registry,
      file: FILE,
      problems: 2,
      certifier: certifier().certifier,
      config: { lines, sessions, seed: "lessons-solve", ...(lines.includes("M5") ? { lineOptions: { M5: { fromFailures: false } } } : {}) },
      responses: [check("exact trivial_proof"), ...Array.from({ length: sessions }, () => [(context: Context) => (prompts.push(opening(context)), check("rw [bad_lemma]")), say("my private notes")]).flat()],
    });
    return { events, prompts };
  }

  it("carries a lesson written on problem 1 to problem 2's briefing when the line list holds M5", { timeout: 60000 }, async () => {
    const { events, prompts } = await twoProblems(["M1", "M5"]);
    const lessons = ofType(events, "node.recorded").filter((e) => e.data.kind === "lesson");
    assert.equal(lessons.length, 1);
    const id = lessons[0]?.data.nodeId as string;
    const drawn = ofType(events, "attempt.started").filter((e) => [...(e.data.included ?? []), ...(e.data.withheld ?? [])].includes(id));
    assert.equal(drawn.length, 6, "the lesson is drawn in every session of problem 2");
    const shown = drawn.filter((e) => e.data.included?.includes(id)).length;
    assert.ok(shown >= 1);
    assert.equal(prompts.filter((p) => /\n# Lessons\n/.test(p)).length, shown);
  });

  it("changes nothing without M5: no lesson, no section, no draw", { timeout: 60000 }, async () => {
    const { events, prompts } = await twoProblems(["M1"]);
    assert.equal(ofType(events, "node.recorded").filter((e) => e.data.kind === "lesson").length, 0);
    assert.ok(prompts.every((p) => !/# Lessons/.test(p)));
    assert.ok(ofType(events, "attempt.started").every((e) => e.data.included === undefined && e.data.withheld === undefined));
  });
});

describe("the arm solve-v2-lessons", () => {
  const base = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } } as never;
  it("is solve-v2 plus line M5, set against solve-v2", () => {
    const arm = arms.find((a) => a.name === "solve-v2-lessons");
    const v2 = arms.find((a) => a.name === "solve-v2");
    assert.equal(arm?.versus, "solve-v2");
    assert.deepEqual(arm?.lines, [...(v2?.lines ?? []), "M5"]);
    assert.ok(arm?.lines.includes("M1"), "M5 requires M1");
    const { lines: _a, ...armRest } = armConfig(base, arm as never) as unknown as Record<string, unknown>;
    const { lines: _b, ...v2Rest } = armConfig(base, v2 as never) as unknown as Record<string, unknown>;
    assert.deepEqual(armRest, v2Rest);
  });

  it("leaves the sets v1 and v2 as they were", () => {
    for (const set of [DEFAULTS_SETS.v1, DEFAULTS_SETS.v2]) assert.ok(!((set as { lines?: string[] }).lines ?? []).includes("M5"));
  });
});
