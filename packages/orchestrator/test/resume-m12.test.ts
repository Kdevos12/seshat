import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import type { Line } from "@seshat/lines";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { AUX, m12Answer, SKETCH_PROOF } from "./m12-helpers.ts";
import { consortium } from "./turns-helpers.ts";
import { assertSound, certifier, consumed } from "./resume-helpers.ts";

const json = (proof: string) => say(JSON.stringify({ proof }));
const costOf = (result: { problems: Array<{ usd: number }> }): number => result.problems.reduce((total, p) => total + p.usd, 0);
const script = (): FauxResponseStep[] => [check(SKETCH_PROOF, AUX), say("Two lemmas are left."), json("exact hole_ok"), json("exact hole_ok")];

/** What a run of M12 leaves that a cut must not change: the claims the line made, the edges it added, and the tasks it proposed. */
function made(events: readonly HarnessEvent[]): unknown {
  // Ids are drawn fresh in every process: they are compared by the order in which they first appear.
  const names = new Map<string, string>();
  const name = (id: unknown): string => (typeof id === "string" ? (names.get(id) ?? (names.set(id, `#${names.size}`), names.get(id)!)) : String(id));
  return {
    claims: ofType(events, "claim.created").filter((e) => e.actor === "line:M12").map((e) => [name(e.data.claimId), e.data.statement]),
    edges: ofType(events, "edge.added").map((e) => [e.data.kind, name(e.data.from), (e.data.to as string[]).map(name)]),
    tasks: ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12").map((e) => [e.data.kind, name(e.data.claimId)]),
    // Sorted: a turn that ends certifies the candidates it holds, which a run that goes on does at the end.
    statuses: ofType(events, "claim.status_changed").map((e) => `${name(e.data.claimId)} ${e.data.to}`).sort(),
  };
}

describe("line M12 in a resumed run", () => {
  it("resumes a run cut at every event to the outcome and cost of the run that was not cut", { timeout: 120000 }, async () => {
    // One outer prover, so that the scheduler's work comes in the same order in every process.
    const config = { lines: ["M12"], provers: 1, sessions: 3 };
    const whole = await demoRun({ lines: { M12: createM12Line() }, config, lean: new DemoLean(m12Answer), certifier: certifier().certifier, responses: script() });
    assert.equal(whole.result.problems[0]?.outcome, "proved");
    const tail: FauxResponseStep[] = Array.from({ length: 8 }, () => json("exact hole_ok"));
    let cuts = 0;
    let exact = 0;
    const kinds = new Set<string>();
    for (let cut = 1; cut < whole.events.length; cut += 1) {
      const prefix = whole.events.slice(0, cut);
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        responses: [...script().slice(consumed(prefix)), ...tail],
        lines: { M12: createM12Line() },
        lean: new DemoLean(m12Answer),
        certifier: certifier().certifier,
      });
      cuts += 1;
      kinds.add(whole.events[cut - 1]?.type ?? "");
      assert.equal(resumed.events.at(-1)?.type, "run.finished", where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
      assertSound(resumed.events);
      // No session was in flight: the process that ended had nothing to lose, and the resumed run is the run that was not cut.
      if (ofType(prefix, "attempt.started").length === ofType(prefix, "attempt.finished").length) {
        exact += 1;
        assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), whole.result.problems.map((p) => [p.outcome, p.attempts]), where);
        assert.ok(Math.abs(costOf(resumed.result) - costOf(whole.result)) < 1e-9, `${where}: the same cost (${costOf(resumed.result)} against ${costOf(whole.result)})`);
        assert.deepEqual(made(resumed.events), made(whole.events), where);
      } else {
        // A cut inside the outer session loses its sketch: the run ends without an error of the harness.
        assert.ok(["proved", "unsolved"].includes(resumed.result.problems[0]?.outcome ?? "none"), `${where}: ${resumed.result.problems[0]?.outcome}`);
      }
    }
    // The sample is every event but the last (nothing is left to sample out), which falls in the scheduler's phase (claims, edges, tasks, calls) as well as between sessions.
    assert.ok(cuts === whole.events.length - 1 && exact >= 20, `${cuts} cuts, ${exact} between sessions`);
    for (const type of ["claim.created", "task.created", "model_call.finished", "edge.added", "claim.status_changed"]) assert.ok(kinds.has(type), `a cut fell after a ${type}`);
  });

  it("draws the same task order from the same seed, and a cut in the scheduler's phase resumes to it", { timeout: 60000 }, async () => {
    const config = { lines: ["M12"], provers: 1, sessions: 3, lineOptions: { M12: { seed: 7 } } as never };
    const run = () => demoRun({ lines: { M12: createM12Line() }, config, lean: new DemoLean(m12Answer), certifier: certifier().certifier, responses: script() });
    const [a, b] = [await run(), await run()];
    const order = (events: readonly HarnessEvent[]) => {
      const mine = new Set(ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12").map((e) => e.data.taskId));
      return ofType(events, "task.status_changed").filter((e) => e.data.to === "running" && mine.has(e.data.taskId)).map((e) => [...mine].indexOf(e.data.taskId));
    };
    assert.equal(order(a.events).length, 2);
    assert.deepEqual(order(a.events), order(b.events));
    assert.deepEqual(made(a.events), made(b.events));
    // Cut after the first task was created: the resumed run works the same two tasks.
    const cut = a.events.findIndex((e) => e.type === "task.created" && e.data.proposedBy === "line:M12") + 1;
    const resumed = await demoResume({
      dir: killedAt(a.dir, cut),
      bench: a.bench,
      responses: [...script().slice(consumed(a.events.slice(0, cut))), json("exact hole_ok"), json("exact hole_ok")],
      lines: { M12: createM12Line() },
      lean: new DemoLean(m12Answer),
      certifier: certifier().certifier,
    });
    assert.equal(resumed.result.problems[0]?.outcome, "proved");
    assert.deepEqual(made(resumed.events), made(a.events));
  });

  /** A line of rung 1 with state of its own: `beforeProvers` records that it started (once), and its briefing fails without that record. */
  function statefulRung(): Line {
    return {
      id: "M14",
      title: "a stateful line of the first rung",
      requires: [],
      rung: 1,
      resume: "stateless",
      hooks: {
        beforeProvers: async (problem) => {
          if (problem.memory.nodes("rung_started", { claimId: problem.claimId }).length === 0) problem.memory.recordNode({ kind: "rung_started", claimId: problem.claimId, data: { problemId: problem.problemId } });
        },
        briefing: async (session) => {
          if (session.memory.nodes("rung_started", { claimId: session.claimId }).length === 0) throw new Error("the rung line was never started");
          return { title: "From the first rung", text: "A rung-1 hint." };
        },
      },
    };
  }

  it("starts a rung line the cut left active and not started, wherever the run is cut across the ladder", { timeout: 120000 }, async () => {
    const config = { lines: ["M12", "M14"], provers: 1, sessions: 4, budget: { problemUsd: 0.02 } };
    const lines = () => ({ M12: createM12Line(), M14: statefulRung() });
    const script = (): FauxResponseStep[] => [check("bad"), say("notes"), check("bad"), say("notes"), check("bad"), say("notes")];
    const whole = await demoRun({ lines: lines(), config, lean: new DemoLean(m12Answer), responses: script() });
    const moved = whole.events.findIndex((e) => e.type === "ladder.escalated");
    assert.ok(moved > 0, "the problem moves up");
    const started = (events: readonly HarnessEvent[]) => ofType(events, "node.recorded").filter((e) => e.data.kind === "rung_started").length;
    assert.equal(started(whole.events), 1);
    let crossed = 0;
    for (let cut = 1; cut < whole.events.length; cut += 1) {
      const prefix = whole.events.slice(0, cut);
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        responses: [...script().slice(consumed(prefix)), ...Array.from({ length: 6 }, () => say("notes"))],
        lines: lines(),
        lean: new DemoLean(m12Answer),
      });
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      assert.notEqual(resumed.result.problems[0]?.outcome, "error", `${where}: ${resumed.result.problems[0]?.reason}`);
      assertSound(resumed.events);
      // A cut at or after the move, until the run ends: the rung line is started, once.
      if (cut >= moved + 1) {
        crossed += 1;
        assert.equal(started(resumed.events), 1, where);
      }
    }
    assert.ok(crossed >= 5, `${crossed} cuts across or after the ladder's move`);
  });

  // Sampled: the limit of the first turn, in tokens, is 1 (the turn ends at the first response), 1500 and 3000 (inside the scheduler's work: a response is
  // about 200 tokens here), every later turn limited to 1 token too until the last. Not sampled: dollar and minute limits, two problems.
  for (const first of [1, 1500, 3000]) {
    it(`reaches the outcome of an uninterrupted run when turn 1 is cut at ${first} tokens and the next turns at 1`, { timeout: 60000 }, async () => {
      const run = (limit: number) => ({ lines: { M12: createM12Line() }, config: { lines: ["M12"], provers: 1, sessions: 3, consortium: consortium({ tokens: limit }) }, lean: new DemoLean(m12Answer), certifier: certifier().certifier });
      const start = await demoRun({ ...run(first), responses: script() });
      let current: { events: HarnessEvent[] } = start;
      let turns = 1;
      while (ofType(current.events, "run.finished").length === 0 && turns < 12) {
        turns += 1;
        current = await demoResume({ dir: start.dir, bench: start.bench, lines: { M12: createM12Line() }, lean: new DemoLean(m12Answer), certifier: certifier().certifier, responses: [...script().slice(consumed(current.events)), ...Array.from({ length: 6 }, () => json("exact hole_ok"))], turns: { limit: { tokens: turns < 4 ? 1 : 1e12 } } });
      }
      assert.deepEqual(ofType(current.events, "problem.finished").map((e) => e.data.outcome), ["proved"], `turns ended by ${ofType(current.events, "turn.ended").map((e) => e.data.reason).join(", ")}`);
      assert.ok(ofType(current.events, "turn.ended").length >= 2);
      assert.deepEqual(made(current.events), made((await demoRun({ ...run(1e12), responses: script() })).events));
      assertSound(current.events);
    });
  }
});
