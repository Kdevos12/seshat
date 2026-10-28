import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CertificationRequest, CertificationResult, HarnessEvent, LeanCertifier } from "@seshat/core";
import { assertSound } from "./resume-helpers.ts";
import { check, demoResume, demoRun, ofType } from "./m0-helpers.ts";
import { consortium, ended, TWO_PROBLEMS } from "./turns-helpers.ts";

/**
 * Certify before exiting (review round 1, R3): a candidate the problem holds when the limit is reached is certified
 * before the run exits. That is Lean, no model call: no session, no `afterProblem`, no request.
 */
function certifier(answers: Array<"certified" | "rejected" | "down"> = []) {
  const requests: CertificationRequest[] = [];
  const made: LeanCertifier = {
    implementation: "fake-certifier",
    version: "0",
    certify: async (request): Promise<CertificationResult> => {
      requests.push(request);
      const answer = answers.shift() ?? "certified";
      if (answer === "down") throw new Error("the kernel replay timed out");
      return { verdict: answer, reasons: answer === "certified" ? [] : ["kernel: rejected"], axioms: ["propext"], timeMs: 1 };
    },
  };
  return { requests, certifier: made };
}

const statusOf = (events: readonly HarnessEvent[], claimId: string | undefined) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === claimId).map((e) => e.data.to);

describe("a candidate held when the limit is reached", () => {
  it("is certified in the same turn, with no model call after the limit, and the account says proved", async () => {
    const c = certifier();
    // The first response is a proof, and it reaches the limit (one token).
    const run = await demoRun({ config: { sessions: 3, consortium: consortium({ tokens: 1 }) }, certifier: c.certifier, responses: [check("exact trivial_proof"), check("exact trivial_proof"), check("exact trivial_proof")] });
    assert.equal(ended(run.events).data.reason, "tokens", "the limit ended the turn");
    assert.equal(run.faux.state.callCount, 1, "no model call after the limit");
    assert.equal(c.requests.length, 1, "the candidate was certified before the run exited");
    const claimId = ofType(run.events, "problem.registered")[0]?.data.claimId;
    assert.deepEqual(statusOf(run.events, claimId), ["computed", "proved"], "through the normal validation: the kernel replay makes it proved");
    assert.equal(ofType(run.events, "problem.finished").length, 0, "the problem has no outcome yet: no afterProblem, no new session");
    assert.deepEqual(ended(run.events).data.waiting.length, 1);
    assert.equal(run.result.turn?.paused, true);
    const account = (await import("../src/index.ts")).buildAccount(run.events, 1);
    assert.equal(account.problems[0]?.state, "proved");
    assert.equal(account.summary.proved, 1);
    assert.match(account.summary.asked.join("\n"), /is settled \(its claim was certified in this turn\)/);
    assertSound(run.events);

    // The next turn closes the problem from the certification the journal holds: no new certification, no model call, and the
    // settled breakpoint does not slip the turn (the team has read it as settled already).
    const again = await demoResume({ dir: run.dir, bench: run.bench, certifier: c.certifier, turns: { limit: { tokens: 1e9 } }, responses: [] });
    assert.equal(again.faux.state.callCount, 0);
    assert.equal(c.requests.length, 1, "certified once");
    assert.deepEqual(ofType(again.events, "problem.finished").map((e) => e.data.outcome), ["proved"]);
    assert.deepEqual(ofType(again.events, "turn.ended").map((e) => e.data.reason), ["tokens", "finished"], "turn 2 ends because the run is over, not at a breakpoint");
    assertSound(again.events);
  });

  it("does not end the next turn at the settled breakpoint again: the team read it as settled when the turn ended", async () => {
    const c = certifier();
    const run = await demoRun({ file: TWO_PROBLEMS, problems: 2, config: { sessions: 3, consortium: consortium({ tokens: 1 }) }, certifier: c.certifier, responses: [check("exact trivial_proof"), check("exact trivial_proof")] });
    assert.equal(ofType(run.events, "problem.finished").length, 0);
    assert.equal(ofType(run.events, "problem.registered").length, 1, "the second problem has not started");
    const again = await demoResume({ dir: run.dir, bench: run.bench, certifier: c.certifier, turns: { limit: { tokens: 1e9 } }, responses: [check("exact trivial_proof")] });
    assert.deepEqual(ofType(again.events, "turn.ended").map((e) => e.data.reason), ["tokens", "finished"], "turn 2 goes on to the second problem instead of stopping at the first");
    assert.deepEqual(ofType(again.events, "problem.finished").map((e) => e.data.outcome), ["proved", "proved"]);
    assert.equal(again.faux.state.callCount, 1);
    assert.equal(c.requests.length, 2, "each proof certified once");
  });

  it("stays a candidate when the certifier cannot answer, is logged, and is certified by the next turn", async () => {
    const c = certifier(["down"]);
    const log: string[] = [];
    const run = await demoRun({ config: { sessions: 3, consortium: consortium({ tokens: 1 }) }, certifier: c.certifier, log: (l) => log.push(l), responses: [check("exact trivial_proof"), check("exact trivial_proof")] });
    assert.equal(run.faux.state.callCount, 1);
    assert.match(log.join("\n"), /the certification at the end of the turn did not finish/);
    const claimId = ofType(run.events, "problem.registered")[0]?.data.claimId;
    assert.deepEqual(statusOf(run.events, claimId), ["computed"]);
    const again = await demoResume({ dir: run.dir, bench: run.bench, certifier: c.certifier, turns: { limit: { tokens: 1e9 } }, responses: [] });
    assert.equal(again.faux.state.callCount, 0);
    assert.deepEqual(ofType(again.events, "problem.finished").map((e) => e.data.outcome), ["proved"]);
    assert.deepEqual(statusOf(again.events, claimId), ["computed", "proved"]);
  });

  it("is a candidate for good, as in an ordinary run, when the host has no certifier", async () => {
    const run = await demoRun({ config: { sessions: 3, consortium: consortium({ tokens: 1 }) }, responses: [check("exact trivial_proof")] });
    assert.equal(run.faux.state.callCount, 1);
    const again = await demoResume({ dir: run.dir, bench: run.bench, turns: { limit: { tokens: 1e9 } }, responses: [] });
    assert.deepEqual(ofType(again.events, "problem.finished").map((e) => e.data.outcome), ["candidate"]);
  });
});

describe("a run in three turns, with a certifier", () => {
  // Problem 1: two failed checks, then a proof; problem 2: one failed check, then a proof. Five responses, two certifications.
  const script = () => [check("bad"), check("bad"), check("exact trivial_proof"), check("bad"), check("exact trivial_proof")];
  const ALL = 1e12;
  const outcomeOf = (events: readonly HarnessEvent[]) => ({
    problems: ofType(events, "problem.finished").map((e) => [e.data.problemId, e.data.outcome]).sort(),
    claims: Object.fromEntries(ofType(events, "claim.created").map((c) => [c.data.statement, ofType(events, "claim.status_changed").filter((s) => s.data.claimId === c.data.claimId).at(-1)?.data.to ?? "open"])),
  });

  async function inTurns(limits: readonly number[]) {
    const c = certifier();
    const first = await demoRun({ file: TWO_PROBLEMS, problems: 2, config: { sessions: 8, consortium: consortium({ tokens: limits[0] ?? ALL }) }, certifier: c.certifier, responses: script() });
    let events = first.events;
    let calls = first.faux.state.callCount;
    // The last limit is unlimited, but a settled problem is a breakpoint that ends a turn too, so there may be more turns than limits.
    for (let turn = 2; turn <= 10 && ofType(events, "run.finished").length === 0; turn++) {
      const next = await demoResume({ dir: first.dir, bench: first.bench, certifier: c.certifier, turns: { limit: { tokens: limits[turn - 1] ?? ALL } }, responses: script().slice(calls) });
      events = next.events;
      calls += next.faux.state.callCount;
    }
    return { events, calls, certifications: c.requests.length, reasons: ofType(events, "turn.ended").map((e) => e.data.reason) };
  }

  // Sampled: the cut matrix of turns-equivalence.test.ts, with a certifier, so that a cut can fall on a candidate: 1, 4,000 and
  // 8,000 tokens for turn 1 and 2 (one, two and about four responses). Not sampled: a certifier that errs or times out (tested singly
  // above), cuts by dollars or minutes.
  const SAMPLED = [1, 4000, 8000];
  const whole = (async () => {
    const c = certifier();
    const run = await demoRun({ file: TWO_PROBLEMS, problems: 2, config: { sessions: 8 }, certifier: c.certifier, responses: script() });
    return { events: run.events, certifications: c.requests.length };
  })();
  for (const first of SAMPLED) {
    for (const second of SAMPLED) {
      it(`reaches the same outcome and certifies each proof once when turn 1 is cut at ${first} tokens and turn 2 at ${second}`, async () => {
        const reference = await whole;
        assert.deepEqual(ofType(reference.events, "problem.finished").map((e) => e.data.outcome), ["proved", "proved"]);
        const run = await inTurns([first, second]);
        assert.deepEqual(outcomeOf(run.events), outcomeOf(reference.events), `turns ended by ${run.reasons.join(", ")}`);
        assert.equal(run.calls, 5, "no response was wasted or asked for twice");
        assert.equal(run.certifications, reference.certifications, "each proof is certified once, in whatever turn");
        assert.equal(run.reasons.at(-1), "finished");
        assertSound(run.events);
      });
    }
  }
});
