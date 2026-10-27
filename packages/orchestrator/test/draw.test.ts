import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Draw } from "@seshat/memory";
import type { Line, LineHooks } from "@seshat/lines";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

/** The responses of `n` sessions that check a file with a hole and end. */
const sessionsOf = (n: number) => Array.from({ length: n }, () => [check("sorry"), say("notes")]).flat();

const ITEMS = ["lesson_a", "lesson_b", "lesson_c", "schema_d", "hint_e", "hint_f"];

/** A line that draws the same unverified items at every session and writes down what it saw in the briefing. */
function drawing(seen: Array<{ draw: Draw; drawn: { included: readonly string[]; withheld: readonly string[] }; inBriefing: readonly string[] }>, extra: Partial<LineHooks> = {}): Line {
  let last: Draw | undefined;
  return {
    id: "M5",
    title: "a test line that draws",
    requires: [],
    version: "test-1",
    hooks: {
      beforeSession: async (s) => {
        const goal = s.claimId;
        last = s.draw([...ITEMS, goal]);
        return undefined;
      },
      briefing: async (s) => {
        seen.push({ draw: last as Draw, drawn: s.drawn, inBriefing: s.drawn.included });
        return { title: "Lessons", text: s.drawn.included.join(", ") };
      },
      ...extra,
    },
  };
}

async function sessions(seed: string | number | undefined, n = 6): Promise<{ events: Awaited<ReturnType<typeof demoRun>>["events"]; seen: Parameters<typeof drawing>[0] }> {
  const seen: Parameters<typeof drawing>[0] = [];
  const run = await demoRun({
    lines: { M5: drawing(seen) },
    config: { lines: ["M5"], sessions: n, ...(seed !== undefined ? { seed } : {}) },
    responses: sessionsOf(n),
  });
  return { events: run.events, seen };
}

describe("a line's draw of unverified items", () => {
  it("is recorded on attempt.started and seen by the briefing, with the goal never drawn", async () => {
    const { events, seen } = await sessions("seed-1");
    const started = ofType(events, "attempt.started");
    assert.equal(started.length, 6);
    const drawn = started.map((e) => e.data);
    for (const [k, data] of drawn.entries()) {
      assert.deepEqual([...(data.included ?? []), ...(data.withheld ?? [])].sort(), [...ITEMS].sort(), "every unverified item is in one list");
      assert.equal((data.included ?? []).concat(data.withheld ?? []).some((id) => id.startsWith("clm_")), false, "the goal is in neither");
      assert.equal(seen[k]?.draw.fixed.length, 1, "the goal comes back fixed");
      assert.deepEqual(seen[k]?.drawn.included, data.included ?? [], "the briefing reads what was recorded");
      assert.deepEqual(seen[k]?.drawn.withheld, data.withheld ?? []);
    }
    const total = drawn.reduce((n, d) => n + (d.included?.length ?? 0), 0);
    assert.ok(total > 0 && total < 36, "a new item is shown about half the time");
  });

  it("repeats from the run's seed, and differs with another", async () => {
    const one = await sessions("seed-1");
    const again = await sessions("seed-1");
    const other = await sessions("seed-2");
    const lists = (r: Awaited<ReturnType<typeof sessions>>) => ofType(r.events, "attempt.started").map((e) => e.data.included);
    assert.deepEqual(lists(one), lists(again));
    assert.notDeepEqual(lists(one), lists(other));
    const config = ofType(one.events, "run.started")[0]?.data.config as { seed?: string };
    assert.equal(config.seed, "seed-1", "the seed is part of the run's recorded configuration");
  });

  it("counts a use for every session that included the item, so that an established item is drawn at p", async () => {
    const seen: Parameters<typeof drawing>[0] = [];
    const run = await demoRun({
      lines: { M5: drawing(seen) },
      config: { lines: ["M5"], sessions: 30, seed: "uses" },
      responses: sessionsOf(30),
    });
    const draws = seen.map((s) => s.draw);
    assert.deepEqual(draws[0]?.chances.lesson_a, 0.5);
    const started = ofType(run.events, "attempt.started");
    for (const id of ITEMS) {
      const uses = draws.map((d) => d.uses[id] as number);
      let included = 0;
      for (const [k, data] of started.entries()) {
        assert.equal(uses[k], included, `${id} at session ${k + 1}`);
        if (data.data.included?.includes(id)) included += 1;
      }
    }
    const established = draws.flatMap((d) => Object.entries(d.uses).filter(([, n]) => n >= 20).map(([id]) => d.chances[id]));
    assert.ok(established.every((p) => p === 0.9));
  });

  it("is refused after the attempt started: the briefing cannot draw", async () => {
    const run = await demoRun({
      lines: { M5: drawing([], { briefing: async (s) => (s.draw(["late"]), undefined) }) },
      config: { lines: ["M5"] },
      responses: [check("sorry")],
    });
    assert.equal(run.result.problems[0]?.outcome, "error");
    assert.match(run.result.problems[0]?.reason ?? "", /draw the unverified items in beforeSession/);
  });

  it("keeps the first outcome of an item drawn twice in a session, and records nothing for a session with no draw", async () => {
    const twice: Line = {
      id: "M5",
      title: "draws twice",
      requires: [],
      version: "test-1",
      hooks: {
        beforeSession: async (s) => {
          const first = s.draw(["x", "y"]);
          const second = s.draw(["x", "y", "z"]);
          assert.deepEqual(second.included.filter((id) => id !== "z"), first.included);
          assert.equal(second.uses.x, undefined, "x was decided once and not drawn again");
          return undefined;
        },
      },
    };
    const run = await demoRun({ lines: { M5: twice }, config: { lines: ["M5"], seed: 3 }, responses: [check("sorry")] });
    const data = ofType(run.events, "attempt.started")[0]?.data;
    assert.deepEqual([...(data?.included ?? []), ...(data?.withheld ?? [])].sort(), ["x", "y", "z"]);
    const plain = await demoRun({ lines: { M5: { id: "M5", title: "nothing", requires: [], version: "t", hooks: {} } }, config: { lines: ["M5"] }, responses: [check("sorry")] });
    const started = ofType(plain.events, "attempt.started")[0]?.data;
    assert.equal(started?.included, undefined);
    assert.equal(started?.withheld, undefined);
  });
});
