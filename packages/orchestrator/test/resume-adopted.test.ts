import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Line } from "@seshat/lines";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType } from "./m0-helpers.ts";
import { m12Answer } from "./m12-helpers.ts";
import { assertSound, certifier } from "./resume-helpers.ts";

/**
 * A line that submits a proof of a claim other than the problem's (so it stays `computed` until the problem ends and the orchestrator
 * certifies it), resumed after the problem's own candidate was found. The candidate is adopted and aborts the problem's signal; the
 * claims the line made must still be taken up again and certified (the run's signal, not the problem's, serves `benches.recover`).
 */
function sideProof(): Line {
  return {
    id: "M1",
    title: "a line that proves another claim",
    requires: [],
    resume: "stateless",
    hooks: {
      beforeProvers: async (problem) => {
        const other = await problem.memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", header: problem.target.sketch.prefix, origin: "test" });
        if (problem.memory.claim(other.claimId)?.status !== "open") return;
        await problem.validate({ claimId: other.claimId, proof: "exact hole_ok" });
      },
    },
  };
}

describe("a resumed problem whose candidate was adopted", () => {
  it("still certifies what its lines submitted for other claims, wherever it was cut", { timeout: 60000 }, async () => {
    const config = { lines: ["M1"], provers: 1, sessions: 2 };
    const script = () => [check("exact trivial_proof")];
    const whole = await demoRun({ lines: { M1: sideProof() }, config, lean: new DemoLean(m12Answer), certifier: certifier().certifier, responses: script() });
    const certified = (events: Parameters<typeof ofType<"validation.finished">>[0]) => ofType(events, "validation.finished").filter((v) => v.data.method === "kernel_replay").map((v) => v.data.claimId);
    assert.equal(whole.result.problems[0]?.outcome, "proved");
    assert.equal(new Set(certified(whole.events)).size, 2, "the problem's claim and the other");
    const found = whole.events.findIndex((e) => e.type === "validation.finished" && e.data.method === "repl" && e.data.claimId === ofType(whole.events, "problem.registered")[0]?.data.claimId);
    const finished = whole.events.findIndex((e) => e.type === "problem.finished");
    assert.ok(found > 0 && finished > found);
    let cuts = 0;
    for (let cut = found + 1; cut < finished; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: [check("exact trivial_proof")], lines: { M1: sideProof() }, lean: new DemoLean(m12Answer), certifier: certifier().certifier });
      cuts += 1;
      assert.equal(resumed.result.problems[0]?.outcome, "proved", where);
      const ids = certified(resumed.events);
      assert.equal(new Set(ids).size, 2, `${where}: both claims certified (${ids.length})`);
      assertSound(resumed.events);
    }
    assert.ok(cuts >= 3, `${cuts} cuts after the candidate`);
  });
});
