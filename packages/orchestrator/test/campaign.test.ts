import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { openForAnswers, recordHint, runShape, shapeProblems } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { check, ofType, say } from "./m0-helpers.ts";
import { campaignConfig, failing, simulatedCampaign } from "./campaign-helpers.ts";
import { consortium } from "./turns-helpers.ts";

const textOf = (context: TranscriptContext): string => JSON.stringify(context.messages);

describe("the axes of a campaign", () => {
  it("lets campaign work with digest and with consortium, and refuses digest without campaign", () => {
    assert.deepEqual(shapeProblems({ horizon: "campaign", human: "digest", consortium: consortium() }), []);
    assert.deepEqual(shapeProblems({ horizon: "campaign", consortium: consortium() }), []);
    assert.deepEqual(runShape({ horizon: "campaign", human: "digest", consortium: consortium() }), { horizon: "campaign", human: "digest" });
    assert.match(shapeProblems({ human: "digest", consortium: consortium() }).join(";"), /digest goes with horizon campaign/);
    assert.match(shapeProblems({ horizon: "campaign", human: "digest" }).join(";"), /needs consortium turns/);
    assert.match(shapeProblems({ horizon: "campaign" }).join(";"), /works in turns/);
  });
});

describe("a campaign", () => {
  it("runs turns without a person, writes the digest after each, and stops at the allowance with the frontier", async () => {
    const digests: string[] = [];
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.2 }),
      responses: () => failing(),
      before: (_n, dir) => {
        digests.push(readFileSync(join(dir, "campaign", "digest.md"), "utf8"));
      },
    });
    assert.equal(run.end.reason, "allowance");
    const ended = ofType(run.events, "turn.ended");
    assert.ok(ended.length >= 3, `at least three turns, got ${ended.length}`);
    assert.ok(ended.slice(0, 2).every((e) => e.data.reason === "usd"), "the first turns end at their limit, with nobody asked");
    // A digest existed before every turn after the first, and it is rebuilt from the journal each time.
    assert.equal(digests.length, ended.length - 1);
    assert.match(digests[0] as string, /# Campaign digest/);
    assert.match(digests[0] as string, /## Frontier/);
    assert.match(digests[0] as string, /## Open questions/);
    assert.match(digests[0] as string, /## Spend/);
    assert.notEqual(digests[0], digests.at(-1));
    const stopped = ofType(run.events, "campaign.stopped");
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]?.data.reason, "allowance");
    assert.ok(stopped[0]?.data.frontier !== undefined, "a stop carries the frontier");
    // The sessions are not capped: a prover worked on after its one configured session.
    assert.ok(ofType(run.events, "attempt.started").length > 1);
    // Nothing set a status: the claim is still open.
    assert.equal(ofType(run.events, "claim.status_changed").length, 0);
    const final = readFileSync(join(run.dir, "campaign", "digest.md"), "utf8");
    assert.match(final, /stopped \(allowance\)/);
    assert.ok(final.length <= 7000);
  });

  it("ends settled when the certifier settles the target", async () => {
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.5, allowance: 2 }),
      responses: (n) => (n === 1 ? [check("exact trivial_proof")] : failing()),
      certifier: certifier().certifier,
    });
    assert.equal(run.end.reason, "settled");
    assert.equal(ofType(run.events, "campaign.stopped")[0]?.data.reason, "settled");
    assert.ok(ofType(run.events, "claim.status_changed").some((e) => e.data.to === "proved"));
  });

  it("reaches the next turn with a hint given between turns", async () => {
    const seen: string[] = [];
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.12 }),
      responses: (n) => (n === 2 ? [(c: TranscriptContext) => { seen.push(textOf(c)); return check("bad"); }, ...failing()] : failing()),
      before: (n, dir) => {
        if (n !== 2) return;
        const journal = openForAnswers(dir);
        try {
          recordHint(journal, { by: "alice", claimId: journal.projection.problems()[0]?.claim_id as string, text: "HINT_MARKER try induction on n" });
        } finally {
          journal.close();
        }
      },
    });
    assert.ok(run.turns.length >= 2);
    assert.ok(seen.length > 0 && /HINT_MARKER/.test(seen[0] as string), "the hint is in the next turn's briefing");
    assert.match(readFileSync(join(run.dir, "campaign", "digest.md"), "utf8"), /hint\(s\) from the team/);
    assert.ok(existsSync(join(run.dir, "campaign", "digest.md")));
  });

  it("changes mode at an impasse and goes on, and the spiral guard ends a campaign that spends and learns nothing", async () => {
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 5, over: { campaign: { spiralTurns: 3 }, consortium: consortium({ usd: 0.03 }, { impasse: { posteriorBelow: 0.5, minAttempts: 2 } }) } }),
      responses: () => failing(80),
    });
    assert.equal(run.end.reason, "spiral");
    assert.match(run.end.detail, /did not grow/);
    const changes = ofType(run.events, "campaign.mode_changed");
    assert.ok(changes.length >= 1);
    assert.equal(changes[0]?.data.mode, "cold_restart");
    assert.ok(say("x") !== undefined);
  });
});
