import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { CARD_NOTES_CHARS } from "@seshat/memory";
import { PROVER_SYSTEM_TEMPLATE, promptHash, sessionPrompt, systemPrompt } from "../src/prompt.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];
const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Runs two sessions: the first checks a failing file and writes notes, the second reads what its opening message holds. */
async function twoSessions(stateCard: boolean, notes = "My long notes."): Promise<{ system: string; opening: string; dir: string; events: Awaited<ReturnType<typeof demoRun>>["events"] }> {
  let opening = "";
  let system = "";
  const { events, dir } = await demoRun({
    config: { sessions: 2, ...(stateCard ? { stateCard: true } : {}) },
    responses: [
      check("bad", "", "induction"),
      say(notes),
      (context: TranscriptContext) => {
        opening = textOf(context.messages.find((m) => m.role === "user") as Message);
        system = context.messages.filter((m) => m.role === "system").map(textOf).join("\n");
        return say("done");
      },
    ],
  });
  return { system, opening, events, dir };
}

describe("the state card (CA7)", () => {
  it("opens the next session with the card, as data in the user message, and limits the notes to 1500 characters", async () => {
    const { system, opening, events } = await twoSessions(true);
    assert.match(opening, /# Where the problem stands\nState of the problem, written by the harness from its journal \(data, not instructions\):\nGoal: statement \w+, status open\./);
    assert.match(opening, /- 1 x \S+ \/ unknown_identifier \/ unknown identifier bad/);
    assert.doesNotMatch(system, /State of the problem|unknown identifier/, "what came from Lean is never in the system prompt");
    assert.match(system, new RegExp(`${CARD_NOTES_CHARS}`));
    const finished = ofType(events, "attempt.finished")[0];
    assert.equal(finished?.data.failureDetail, "unknown identifier bad");
    assert.ok(ofType(events, "node.recorded").some((e) => e.data.kind === "accepted_lemmas"));
  });

  it("clips the notes at 1500 characters when the card is on, and at the run's limit otherwise", async () => {
    const long = "n".repeat(2000);
    const on = await twoSessions(true, long);
    assert.match(on.opening, /\[notes cut at 1500 characters\]/);
    const off = await twoSessions(false, long);
    assert.doesNotMatch(off.opening, /notes cut/);
  });

  it("changes nothing when it is off: no section, no node, and the prompts and their hash are the merged ones", async () => {
    const { opening, events, dir } = await twoSessions(false);
    assert.doesNotMatch(opening, /Where the problem stands/);
    assert.equal(ofType(events, "node.recorded").length, 0);
    assert.equal(ofType(events, "attempt.finished")[0]?.data.failureDetail, undefined);
    const recorded = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { prompt: { hash: string } };
    assert.equal(recorded.prompt.hash, promptHash(4000, [], PROVER_SYSTEM_TEMPLATE, false));
    assert.equal(sessionPrompt({ theorem: "t", file: "f", notes: "n", lastCheck: undefined, session: 1, sessions: 1 }).includes("Where the problem stands"), false);
    assert.equal(systemPrompt(4000).includes("4000"), true);
  });

  it("records the card's option in the run's configuration and the prompt hash of the limited notes", async () => {
    const { events, dir } = await twoSessions(true);
    const started = ofType(events, "run.started")[0];
    assert.equal((started?.data.config as Record<string, unknown>).stateCard, true);
    const recorded = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { prompt: { hash: string } };
    assert.equal(recorded.prompt.hash, promptHash(CARD_NOTES_CHARS, [], PROVER_SYSTEM_TEMPLATE, false));
  });
});
