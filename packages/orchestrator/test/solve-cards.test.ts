import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { armConfig } from "../src/ablation.ts";
import { solveCards } from "../src/cards.ts";
import { buildReport, renderRunReport } from "../src/index.ts";
import { check, demoRun, ofType } from "./m0-helpers.ts";
import { experimentArms } from "../src/experiments.ts";
import { DEFAULTS_SETS } from "../src/student.ts";
import { DEFAULT_CONFIG } from "../src/run.ts";

const file = (statement: string) => `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- A statement. -/
@[category research solved, AMS 11]
theorem thing ${statement} := by
  sorry

end Demo
`;

/** The first user message of the session of `attemptId`, as the model received it. */
function firstBriefing(dir: string, attemptId: string): string {
  const messages = JSON.parse(readFileSync(join(dir, "transcripts", `${attemptId}.json`), "utf8")) as Array<{ role: string; content: unknown }>;
  return JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
}

describe("heuristic cards in solve (PA7)", () => {
  it("puts a card that matches the statement's features in the first briefing and journals it as the fleet does", async () => {
    const { events, dir } = await demoRun({ responses: [check("exact trivial_proof")], file: file("(n : ℕ) : n + 0 = n"), config: { cards: {} } });
    const [started] = ofType(events, "attempt.started");
    assert.equal(started?.data.settings?.heuristic, "vary.one_parameter");
    assert.equal(started?.data.settings?.heuristicRule, "solve");
    assert.equal(started?.data.settings?.heuristicFamily, "vary");
    assert.equal(started?.data.settings?.heuristicBucket !== undefined, true);
    const briefing = firstBriefing(dir, started?.data.attemptId as string);
    assert.match(briefing, /Heuristic for this session/);
    assert.match(briefing, /The harness drew this heuristic for the session/);
    assert.equal(ofType(events, "attempt.started").length, 1);
  });

  it("gives a statement no card keys on none, and nothing is recorded", async () => {
    const { events, dir } = await demoRun({ responses: [check("exact trivial_proof")], file: file(": 1 + 1 = 2"), config: { cards: {} } });
    const [started] = ofType(events, "attempt.started");
    assert.equal(started?.data.settings?.heuristic, undefined);
    assert.doesNotMatch(firstBriefing(dir, started?.data.attemptId as string), /Heuristic for this session/);
  });

  it("is off without the setting: no card, no setting", async () => {
    const { events, dir } = await demoRun({ responses: [check("exact trivial_proof")], file: file("(n : ℕ) : n + 0 = n") });
    const [started] = ofType(events, "attempt.started");
    assert.equal(started?.data.settings?.heuristic, undefined);
    assert.doesNotMatch(firstBriefing(dir, started?.data.attemptId as string), /Heuristic for this session/);
  });

  it("shows the first session's briefing at most `max` cards, and no later one", async () => {
    const { events, dir } = await demoRun({ responses: [check("bad"), check("bad")], file: file("(n : ℕ) (h : 0 < n) : ∃ k : ℕ, n ∣ k"), config: { cards: { max: 2 }, sessions: 2 } });
    const started = ofType(events, "attempt.started");
    const ids = started[0]?.data.settings?.heuristicCards as string[];
    assert.equal(ids.length, 2);
    assert.equal(started[0]?.data.settings?.heuristic, ids[0]);
    assert.equal((firstBriefing(dir, started[0]?.data.attemptId as string).match(/Heuristic for this session/g) ?? []).length, 2);
    assert.ok(started.length >= 2, "a second session ran");
    assert.doesNotMatch(firstBriefing(dir, started[1]?.data.attemptId as string), /Heuristic for this session/);
    assert.equal(started[1]?.data.settings?.heuristic, undefined);
  });

  it("rejects a max that is not a whole number from 1 to 5", async () => {
    await assert.rejects(demoRun({ responses: [], config: { cards: { max: 0 } } }), /cards\.max/);
  });

  it("counts the cards shown and the problems certified with and without one in the report", async () => {
    const { events } = await demoRun({ responses: [check("exact trivial_proof")], file: file("(n : ℕ) : n + 0 = n"), config: { cards: {} } });
    const report = buildReport(events);
    assert.equal(report.cardsShown?.shown, 1);
    assert.equal(report.cardsShown?.withCard.problems, 1);
    assert.equal(report.cardsShown?.withoutCard.problems, 0);
    assert.match(renderRunReport(report), /Cards in solve: 1 shown; problems with a card: \d of 1 certified; without: 0 of 0\./);
  });

  it("picks from the statement alone: none for a statement without a keyed feature, the best match first otherwise", () => {
    assert.equal(solveCards(undefined, ": 1 + 1 = 2", [], {}), undefined);
    const picked = solveCards(undefined, "(x : ℝ) (h : 0 < x) : x ≤ x ^ 2 + 1", ["msc:26"], { max: 3 });
    assert.equal(picked?.cards.length, 3);
    assert.equal(picked?.cards[0]?.id, "bounds.dominant_term", "two required features match, against one");
    assert.equal(solveCards(undefined, "(n : ℕ) : n + 0 = n", [], {})?.settings.heuristicRule, "solve");
  });
});

describe("the arm solve-v2-cards", () => {
  const arms = experimentArms("solve-defaults", { host: { capabilities: { "compute.sage": {}, "lean.search": {}, "lean.lsp": {} } } });
  const base = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } } as never;
  it("is solve-v2 plus cards, set against solve-v2 itself", () => {
    const arm = arms.find((a) => a.name === "solve-v2-cards");
    assert.equal(arm?.versus, "solve-v2");
    const v2 = arms.find((a) => a.name === "solve-v2") as never;
    const { cards, ...rest } = armConfig(base, arm as never) as { cards?: unknown };
    assert.deepEqual(cards, {});
    assert.deepEqual(rest, armConfig(base, v2));
    assert.equal((armConfig(base, v2) as { cards?: unknown }).cards, undefined, "solve-v2 has none");
  });

  it("leaves the sets v1 and v2 as they were", () => {
    assert.equal((DEFAULTS_SETS.v2 as { cards?: unknown }).cards, undefined);
    assert.equal((DEFAULTS_SETS.v1 as { cards?: unknown }).cards, undefined);
  });
});
