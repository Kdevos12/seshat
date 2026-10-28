import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { assertSound } from "./resume-helpers.ts";
import { check, demoResume, demoRun, ofType } from "./m0-helpers.ts";
import { consortium, TWO_PROBLEMS } from "./turns-helpers.ts";

/**
 * A run in three turns reaches the same outcome as one that is not interrupted (documentation/human.md,
 * "Turns"). The faux model and the simulated Lean stand in; the cut matrix is sampled, not exhaustive.
 */
describe("a run in several turns", () => {
  // Problem 1: two failed checks, then a proof. Problem 2: one failed check, then a proof. Five responses in all.
  const script = (): FauxResponseStep[] => [check("bad"), check("bad"), check("exact trivial_proof"), check("bad"), check("exact trivial_proof")];
  const ALL = 1e12;

  /** What a run reached: each problem's outcome and attempts' proofs, and the claims' final statuses. */
  const outcomeOf = (events: readonly HarnessEvent[]) => ({
    problems: ofType(events, "problem.finished").map((e) => [e.data.problemId, e.data.outcome]).sort(),
    claims: Object.fromEntries(
      ofType(events, "claim.created").map((c) => [c.data.statement, ofType(events, "claim.status_changed").filter((s) => s.data.claimId === c.data.claimId).at(-1)?.data.to ?? "open"]),
    ),
    validProofs: ofType(events, "attempt.finished").filter((a) => a.data.outcome === "valid").length,
  });

  /** Runs in turns of these token limits, the last unlimited; returns the final journal and the model calls made in all. */
  async function inTurns(limits: readonly number[]): Promise<{ events: HarnessEvent[]; calls: number; turns: number; reasons: string[] }> {
    const first = await demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      config: { sessions: 8, consortium: consortium({ tokens: limits[0] ?? ALL }) },
      responses: script(),
    });
    let events = first.events;
    let calls = first.faux.state.callCount;
    for (let turn = 2; turn <= limits.length + 1 && ofType(events, "run.finished").length === 0; turn++) {
      const next = await demoResume({
        dir: first.dir,
        bench: first.bench,
        turns: { limit: { tokens: limits[turn - 1] ?? ALL } },
        responses: script().slice(calls),
      });
      events = next.events;
      calls += next.faux.state.callCount;
    }
    return { events, calls, turns: ofType(events, "turn.ended").length, reasons: ofType(events, "turn.ended").map((e) => e.data.reason) };
  }

  it("in three turns reaches the same outcome as an uninterrupted run, with the same model work", async () => {
    const whole = await demoRun({ file: TWO_PROBLEMS, problems: 2, config: { sessions: 8 }, responses: script() });
    assert.deepEqual(ofType(whole.events, "problem.finished").map((e) => e.data.outcome), ["candidate", "candidate"]);

    // A limit of one token ends a turn after the first response: the first turn takes one call, the second one, the third the rest.
    const three = await inTurns([1, 1]);
    assert.equal(three.turns, 3);
    assert.deepEqual(three.reasons, ["tokens", "tokens", "finished"]);
    assert.equal(three.calls, whole.faux.state.callCount, "the same five responses were asked for, once each");
    assert.deepEqual(outcomeOf(three.events), outcomeOf(whole.events));
    assert.equal(ofType(three.events, "run.finished").length, 1, "only the last turn finishes the run");
    assert.equal(ofType(three.events, "turn.started").length, 3);
    assertSound(three.events);
  });

  // The cut matrix, sampled: the limits of the first two turns, in tokens. A response costs about 2,300 tokens
  // here (the prompt is most of it), so 1 cuts after one response, 4000 after two and 8000 after about four. Which
  // limits are crossed where depends on the prompts, and the assertions do not: any cut gives the same outcome.
  // Sampled: 3 x 3 limits for turns 1 and 2, the last turn unlimited. Not sampled: cuts by time, by dollars or by a
  // breakpoint (those are tested one by one in turns.test.ts and consortium.test.ts), three problems, and a
  // run cut in more than three turns.
  const SAMPLED = [1, 4000, 8000];
  const whole = demoRun({ file: TWO_PROBLEMS, problems: 2, config: { sessions: 8 }, responses: script() });
  for (const first of SAMPLED) {
    for (const second of SAMPLED) {
      it(`reaches the same outcome when turn 1 is cut at ${first} tokens and turn 2 at ${second}`, async () => {
        const reference = outcomeOf((await whole).events);
        const run = await inTurns([first, second]);
        assert.deepEqual(outcomeOf(run.events), reference, `turns ended by ${run.reasons.join(", ")}`);
        assert.equal(run.calls, 5, "no response was wasted or asked for twice");
        assert.equal(run.reasons.at(-1), "finished");
        assertSound(run.events);
      });
    }
  }
});
