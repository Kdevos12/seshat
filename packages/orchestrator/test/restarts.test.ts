import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { luby, resolveRestarts, restartsConfigProblems, sessionSteps } from "../src/restarts.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];
const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

describe("the restart schedule (LH3)", () => {
  it("gives geometric step limits base, 2 base, 4 base, ... under the run's own limit", () => {
    const r = resolveRestarts({});
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((i) => sessionSteps(r, i, 40)), [6, 12, 24, 40, 40, 40]);
    assert.deepEqual([1, 2, 3].map((i) => sessionSteps(resolveRestarts({ base: 3 }), i, 100)), [3, 6, 12]);
  });

  it("gives Luby's sequence times the base", () => {
    assert.deepEqual(Array.from({ length: 15 }, (_, k) => luby(k + 1)), [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8]);
    const r = resolveRestarts({ schedule: "luby" });
    assert.deepEqual(Array.from({ length: 8 }, (_, k) => sessionSteps(r, k + 1, 100)), [6, 6, 12, 6, 6, 12, 24, 6]);
    assert.equal(sessionSteps(r, 7, 20), 20);
  });

  it("has defaults and refuses what it does not know", () => {
    assert.deepEqual(resolveRestarts({}), { schedule: "geometric", base: 6, stuckChecks: 3 });
    assert.deepEqual(restartsConfigProblems(undefined), []);
    assert.equal(restartsConfigProblems({ schedule: "random", base: 0, extra: 1 }).length, 3);
  });
});

/** Two sessions; the second's opening message is kept. */
async function twoSessions(restarts: Parameters<typeof demoRun>[0]["config"] extends infer C ? C : never, first: Parameters<typeof demoRun>[0]["responses"]) {
  const openings: string[] = [];
  const run = await demoRun({
    pricePerMillion: 100,
    config: { sessions: 2, ...restarts },
    responses: [
      ...first,
      (context: TranscriptContext) => {
        openings.push(textOf(context.messages.find((m) => m.role === "user") as Message));
        return say("done");
      },
    ],
  });
  return { ...run, opening: openings[0] ?? "" };
}

describe("cold restarts in a run (LH3)", () => {
  it("ends a session at the schedule's step limit, and the next one starts without the previous file and notes", async () => {
    const { events, opening } = await twoSessions({ restarts: { base: 2 } }, [check("bad_marker_xyz", "theorem aux_a : True := trivial"), check("bad_marker_xyz"), say("NOTES_MARKER")]);
    const [first] = ofType(events, "attempt.finished");
    assert.equal(first?.data.stoppedBy, "turns");
    assert.deepEqual(first?.data.restart, { reason: "schedule" });
    assert.doesNotMatch(opening, /bad_marker_xyz|NOTES_MARKER|aux_a/);
    assert.match(opening, /session 2 of at most 2/);
    assert.match(opening, /starts cold/);
    assert.match(opening, /sorry/, "the original file");
  });

  it("is the previous behaviour without it: the next session reads the file and the notes, and nothing is recorded", async () => {
    const { events, opening } = await twoSessions({}, [check("bad_marker_xyz"), check("bad_marker_xyz"), say("NOTES_MARKER")]);
    assert.match(opening, /bad_marker_xyz/);
    assert.match(opening, /NOTES_MARKER/);
    assert.equal(ofType(events, "attempt.finished")[0]?.data.restart, undefined);
    assert.equal((ofType(events, "run.started")[0]?.data.config as Record<string, unknown>).restarts, undefined);
  });

  it("ends a session as stuck after three identical failures, with the class", async () => {
    const { events } = await twoSessions({ restarts: { base: 20 } }, [check("bad"), check("bad"), check("bad"), say("notes")]);
    const [first] = ofType(events, "attempt.finished");
    assert.equal(first?.data.stoppedBy, "stuck");
    assert.deepEqual(first?.data.restart, { reason: "stuck", class: "unknown_identifier" });
    assert.equal(first?.data.checks, 3);
  });

  it("does not end a session whose failures differ, or whose class changes", async () => {
    const { events } = await twoSessions({ restarts: { base: 20 } }, [check("bad"), check("sorry"), check("bad"), check("bad"), say("notes")]);
    const [first] = ofType(events, "attempt.finished");
    assert.notEqual(first?.data.stoppedBy, "stuck");
    assert.equal(first?.data.restart, undefined);
  });

  it("asks for more or fewer repeats with stuckChecks", async () => {
    const { events } = await twoSessions({ restarts: { base: 20, stuckChecks: 2 } }, [check("bad"), check("bad"), say("notes")]);
    assert.equal(ofType(events, "attempt.finished")[0]?.data.stoppedBy, "stuck");
  });
});
