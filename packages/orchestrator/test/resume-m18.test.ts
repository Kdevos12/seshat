import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import type { Line } from "@seshat/lines";
import { createM12Line, createM18Line } from "@seshat/scheduler";
import { DemoLean, demoResume, demoRun, killedAt, ofType } from "./m0-helpers.ts";
import { m18Answer, responder } from "./m18-helpers.ts";
import { assertSound, certifier } from "./resume-helpers.ts";

const BUDGET = 0.05;
const config = { lines: ["M12", "M18"], provers: 1, sessions: 3, budget: { problemUsd: BUDGET }, lineOptions: { M12: { fractions: [0.1] } } as never };
const costOf = (result: { problems: Array<{ usd: number }> }): number => result.problems.reduce((total, p) => total + p.usd, 0);

/** What a run of M18 leaves that a cut must not change: the variants, their edges and tasks, and what the line recorded. */
function made(events: readonly HarnessEvent[]): unknown {
  // Ids are drawn fresh in every process: they are compared by the order in which they first appear.
  const names = new Map<string, string>();
  const name = (id: unknown): string => (typeof id === "string" ? (names.get(id) ?? (names.set(id, `#${names.size}`), names.get(id)!)) : String(id));
  const recorded = (kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).length;
  return {
    claims: ofType(events, "claim.created").filter((e) => e.actor === "line:M18").map((e) => [name(e.data.claimId), e.data.statement]),
    edges: ofType(events, "edge.added").map((e) => [e.data.kind, name(e.data.from), (e.data.to as string[]).map(name)]),
    tasks: ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M18").map((e) => [e.data.kind, name(e.data.claimId)]),
    nodes: [recorded("m18_generation"), recorded("m18_variant"), recorded("m18_session")],
    statuses: ofType(events, "claim.status_changed").map((e) => `${name(e.data.claimId)} ${e.data.to}`).sort(),
  };
}

describe("line M18 in a resumed run", () => {
  it("resumes a run cut at every event to the claims, tasks and cost of the run that was not cut", { timeout: 240000 }, async () => {
    const whole = await demoRun({ lines: { M12: createM12Line(), M18: createM18Line() }, config, lean: new DemoLean(m18Answer), certifier: certifier().certifier, responses: responder() });
    assert.equal(ofType(whole.events, "task.created").filter((e) => e.data.proposedBy === "line:M18").length, 2);
    // A cut between the move up and the next session resumes with the variants' tasks worked before that session and not after it: the same work, in another order.
    const moved = whole.events.findIndex((e) => e.type === "ladder.escalated");
    const second = whole.events.findIndex((e, k) => e.type === "attempt.started" && k > moved);
    let exact = 0;
    const kinds = new Set<string>();
    for (let cut = 1; cut < whole.events.length; cut += 1) {
      const prefix = whole.events.slice(0, cut);
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        responses: responder(),
        lines: { M12: createM12Line(), M18: createM18Line() },
        lean: new DemoLean(m18Answer),
        certifier: certifier().certifier,
      });
      kinds.add(whole.events[cut - 1]?.type ?? "");
      assert.equal(resumed.events.at(-1)?.type, "run.finished", where);
      assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
      assertSound(resumed.events);
      // The variants are made once and each has one task, wherever the cut fell.
      const variantsMade = ofType(resumed.events, "claim.created").filter((e) => e.actor === "line:M18" && !(e.data.gloss ?? "").startsWith("link lemma"));
      assert.ok(variantsMade.length === 0 || variantsMade.length === 2, `${where}: ${variantsMade.length} variants`);
      assert.ok(ofType(resumed.events, "task.created").filter((e) => e.data.proposedBy === "line:M18").length <= 2, where);
      assert.ok(ofType(resumed.events, "node.recorded").filter((e) => e.data.kind === "m18_generation").length <= 1, where);
      // No session was in flight: the process that ended had nothing to lose, and the resumed run is the run that was not cut.
      const reordered = cut > moved && cut <= second;
      if (ofType(prefix, "attempt.started").length === ofType(prefix, "attempt.finished").length && !reordered) {
        exact += 1;
        assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), whole.result.problems.map((p) => [p.outcome, p.attempts]), where);
        assert.ok(Math.abs(costOf(resumed.result) - costOf(whole.result)) < 1e-9, `${where}: the same cost (${costOf(resumed.result)} against ${costOf(whole.result)})`);
        assert.deepEqual(made(resumed.events), made(whole.events), where);
      }
    }
    assert.ok(exact >= 20, `${exact} cuts between sessions`);
    for (const type of ["ladder.escalated", "model_call.finished", "claim.created", "task.created", "edge.added", "claim.status_changed"]) assert.ok(kinds.has(type), `a cut fell after a ${type}`);
  });

  it("does nothing twice when its beforeProvers is called twice", { timeout: 30000 }, async () => {
    const inner = createM18Line();
    const twice: Line = {
      ...inner,
      hooks: {
        ...inner.hooks,
        beforeProvers: async (problem) => {
          await inner.hooks.beforeProvers?.(problem);
          await inner.hooks.beforeProvers?.(problem);
          await inner.hooks.resumeProblem?.(problem, { begun: true, attempts: [], endedProvers: [], modelCalls: {}, workedClaims: [] });
        },
      },
    };
    const { events } = await demoRun({ lines: { M12: createM12Line(), M18: twice }, config, lean: new DemoLean(m18Answer), responses: responder() });
    assert.equal(ofType(events, "model_call.finished").filter((m) => m.data.site === "curriculum.variants").length, 1);
    assert.equal(ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M18").length, 2);
    assert.equal(ofType(events, "node.recorded").filter((e) => e.data.kind === "m18_variant").length, 2);
  });
});
