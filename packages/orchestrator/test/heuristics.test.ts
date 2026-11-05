import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { BUILTIN_CARDS } from "@seshat/heuristics";
import { heuristicsCommand } from "../src/heuristics-command.ts";
import { buildReport, renderRunReport } from "../src/report.ts";
import { check, demoRun, ofType, tempDir } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];
const opening = (context: TranscriptContext): string => {
  const content = (context.messages.find((m) => m.role === "user") as Message).content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
};

describe("the bank of heuristic cards in a run", () => {
  it("briefs a session with its card, records the draw on the attempt, and reports it against the control", async () => {
    const prompts: string[] = [];
    const { events, dir } = await demoRun({
      config: { lines: ["M1", "fleet"], lineOptions: { fleet: { seed: 3, epsilon: 0, heuristics: true, noCardShare: 0 } } as never, sessions: 1 },
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    const settings = ofType(events, "attempt.started")[0]?.data.settings ?? {};
    const card = BUILTIN_CARDS.find((c) => c.id === settings.heuristic);
    assert.ok(card !== undefined, JSON.stringify(settings));
    assert.equal(settings.heuristicRule, "thompson");
    assert.equal(settings.heuristicFamily, card.family);
    assert.match(prompts[0] ?? "", /# Heuristic for this session\n/);
    assert.ok((prompts[0] ?? "").includes(card.ask));

    const report = buildReport(events);
    assert.equal(report.heuristics?.sessions, 1);
    assert.match(renderRunReport(report), /Heuristic cards: 1 finished session\(s\) with a draw; the control \(no card\) 0 of 0 valid\./);

    const lines: string[] = [];
    assert.equal(heuristicsCommand("stats", dir, { packsDir: tempDir(), out: (l) => lines.push(l) }), 0);
    assert.match(lines.join("\n"), new RegExp(`By card:\\n  ${card.id.replace(".", "\\.")}: `));
  });

  it("lists the bank, and says so when a run had it off", async () => {
    const listed: string[] = [];
    heuristicsCommand("list", undefined, { packsDir: tempDir(), out: (l) => listed.push(l) });
    assert.equal(listed.length, BUILTIN_CARDS.length + 1, "one line per card, then the total; the built-in bank has no overlap");
    assert.match(listed[0] ?? "", /^small_cases {2}\[specialize, strategy, builtin\] {2}Work out small cases first/);
    const { dir } = await demoRun({ config: { lines: ["M1", "fleet"], lineOptions: { fleet: { seed: 3, epsilon: 0 } } as never, sessions: 1 }, responses: [check("exact trivial_proof")] });
    const lines: string[] = [];
    heuristicsCommand("stats", dir, { packsDir: tempDir(), out: (l) => lines.push(l) });
    assert.deepEqual(lines, ["No session of this run had a draw of the bank: the option heuristics was off."]);
    assert.throws(() => heuristicsCommand("stats", tempDir(), { packsDir: tempDir(), out: () => {} }), /not a run directory/);
  });
});
