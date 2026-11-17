import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { buildAccount, buildResult, renderAccount, renderResult, writeReport } from "../src/index.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";
import { blobsOf, consortium } from "./turns-helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Message = TranscriptContext["messages"][number];
const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

const LEMMA = "theorem aux_a : True := trivial";

/** Two sessions: the first checks a file whose `aux_` lemma Lean accepts and whose proof fails; the second reads its opening message. */
async function twoSessions(extra: Parameters<typeof demoRun>[0]["config"] = {}) {
  const openings: string[] = [];
  const run = await demoRun({
    pricePerMillion: 100,
    config: { sessions: 2, stateCard: true, ...extra },
    responses: [
      check("bad", LEMMA, "induction"),
      say("My notes."),
      (context: TranscriptContext) => {
        openings.push(textOf(context.messages.find((m) => m.role === "user") as Message));
        return say("done");
      },
    ],
  });
  return { ...run, opening: openings[0] ?? "" };
}

describe("the verified frontier in a run (LH1, LH8)", () => {
  it("ends the opening message with the budget line, and the card with the frontier, when it is on", async () => {
    const { opening, events } = await twoSessions({ frontier: { show: true } });
    assert.match(opening, /# Where the problem stands\n[\s\S]*Established so far \(1 entries, score 3; an evidence entry is evidence, not proof\):\n- subclaim: aux_a\n/);
    const last = opening.trimEnd().split("\n").at(-1) as string;
    assert.match(last, /^Budget: \$\d+\.\d\d left for this session, \$\d+\.\d\d for the problem; established so far: 1 entries \(score 3\), last: aux_a\.$/);
    // The numbers are the ledgers': the problem's allowance less what the first session cost.
    const started = ofType(events, "run.started")[0];
    const problemUsd = (started?.data.config as { budget: { problemUsd: number } }).budget.problemUsd;
    const spent = ofType(events, "attempt.finished")[0]?.data.usd ?? 0;
    assert.ok(spent > 0);
    assert.equal(last.match(/for this session, \$(\d+\.\d\d) for the problem/)?.[1], (problemUsd - spent).toFixed(2));
    assert.equal(last.match(/Budget: \$(\d+\.\d\d)/)?.[1], (problemUsd - spent).toFixed(2));
  });

  it("changes nothing when it is off: the opening message is byte-identical, with `show: false` as with no setting", async () => {
    const plain = await twoSessions();
    const off = await twoSessions({ frontier: { show: false } });
    assert.equal(off.opening, plain.opening);
    assert.doesNotMatch(plain.opening, /Budget:|Established so far/);
    assert.equal((ofType(off.events, "run.started")[0]?.data.config as Record<string, unknown>).frontier, undefined);
  });

  it("the system prompt does not change", async () => {
    const systems: string[] = [];
    for (const frontier of [undefined, { show: true }]) {
      await demoRun({
        config: { sessions: 1, ...(frontier !== undefined ? { frontier } : {}) },
        responses: [(context: TranscriptContext) => { systems.push(context.messages.filter((m) => m.role === "system").map(textOf).join("\n")); return say("done"); }],
      });
    }
    assert.equal(systems[0], systems[1]);
    assert.ok((systems[0] ?? "").length > 0);
  });

  it("puts the section in RESULT.md and report.md when on, and in neither when off", async () => {
    const on = await twoSessions({ frontier: { show: true } });
    const result = buildResult(on.events, { blob: (h) => blobsOf(on.dir).get(h) });
    const text = renderResult(result);
    assert.match(text, /## Established so far\n\n### \S+#Demo\S+\n\n1 entries, score 3\./);
    assert.match(text, /- subclaim: aux_a - an aux_ lemma Lean accepted/);
    writeReport(on.dir);
    assert.match(readFileSync(join(on.dir, "report.md"), "utf8"), /## Established so far/);
    const off = await twoSessions();
    assert.equal(buildResult(off.events).frontier, undefined);
    assert.doesNotMatch(renderResult(buildResult(off.events)), /Established so far/);
  });

  it("puts the section in the turn's account", async () => {
    const run = await demoRun({
      config: { sessions: 4, consortium: consortium({ tokens: 1 }), frontier: { show: true } },
      responses: [check("bad", LEMMA, "induction"), ...Array.from({ length: 6 }, () => check("bad"))],
    });
    const account = buildAccount(run.events, 1);
    assert.equal(account.frontier?.[0]?.frontier.entries[0]?.id, "aux_a");
    assert.match(renderAccount(account), /### Established so far\n\n1 entries, score 3\./);
  });
});
