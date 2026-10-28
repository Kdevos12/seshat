import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { AUX, m12Answer, SKETCH_PROOF } from "./m12-helpers.ts";
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
    statuses: ofType(events, "claim.status_changed").map((e) => [name(e.data.claimId), e.data.to]),
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
});
