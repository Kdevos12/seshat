import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { acquireLock, beat, campaignOver, openForAnswers, recordHint, RunSetupError, runCampaign, runShape, shapeProblems, watchCampaign } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { check, ofType, say, tempDir } from "./m0-helpers.ts";
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

describe("the lock", () => {
  it("refuses a second supervisor while the lock's process is alive, and takes over a stale lock", async () => {
    const dir = join(tempDir("mh-lock-"), "run");
    mkdirSync(join(dir, "campaign"), { recursive: true });
    writeFileSync(join(dir, "campaign", "lock"), `${JSON.stringify({ pid: 4242, startedAt: "2026-11-01T00:00:00.000Z" })}\n`);
    await assert.rejects(runCampaign({ dir, next: async () => assert.fail("no turn"), pid: 7, isAlive: (pid) => pid === 4242 }), (e: unknown) => e instanceof RunSetupError && /another supervisor works this run: process 4242/.test(e.message));
    // The refused supervisor left the live lock alone.
    assert.equal(JSON.parse(readFileSync(join(dir, "campaign", "lock"), "utf8")).pid, 4242);
    // A lock whose process is gone is taken over (and released at the end).
    const run = await simulatedCampaign({
      dir,
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.05 }),
      responses: () => failing(),
      extra: { pid: 7, isAlive: () => false },
    });
    assert.equal(run.end.reason, "allowance");
    assert.equal(existsSync(join(dir, "campaign", "lock")), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "campaign", "heartbeat"), "utf8")).pid, 7);
  });
});

describe("pacing", () => {
  it("ends a turn at the day's cap and starts the next on the next UTC day", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const slept: number[] = [];
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.3, over: { campaign: { usdPerDay: 0.05, spiralTurns: 1000 } } }),
      responses: () => failing(),
      wallClock: () => now,
      extra: { clock: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } },
    });
    assert.equal(run.end.reason, "allowance");
    const days = new Map<string, number>();
    for (const e of ofType(run.events, "turn.started")) {
      const end = ofType(run.events, "turn.ended").find((x) => x.data.turn === e.data.turn);
      const day = (e.data.at as string).slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + (end?.data.spent.turn.usd ?? 0));
    }
    assert.ok(days.size >= 2, `the campaign spans days: ${[...days.keys()].join(", ")}`);
    for (const [day, usd] of days) assert.ok(usd <= 0.05 + 0.012, `${day} spent ${usd}`);
    const waits = ofType(run.events, "campaign.waiting");
    assert.ok(waits.length >= 1 && waits.every((w) => w.data.reason === "daily_cap"));
    assert.ok(slept.every((ms) => ms > 0 && ms <= 86_400_000));
    // The turn after a wait began on a later day than the one that spent the cap.
    assert.ok(Date.parse(waits[0]?.data.until as string) > Date.parse(waits[0]?.data.from as string));
    assert.match(readFileSync(join(run.dir, "campaign", "digest.md"), "utf8"), /daily cap/);
  });

  it("stops at --until", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 5, over: { campaign: { usdPerDay: 0.05, until: "2026-11-02T12:00:00Z", spiralTurns: 1000 } } }),
      responses: () => failing(),
      wallClock: () => now,
      extra: { clock: () => now, sleep: async (ms) => { now += ms; } },
    });
    assert.equal(run.end.reason, "until");
    assert.ok(now >= Date.parse("2026-11-02T12:00:00Z"));
  });
});

describe("a provider's usage limit", () => {
  it("is waited out with a backoff of 1, 2, 4 minutes, and the supervisor goes on", async () => {
    const slept: number[] = [];
    let failures = 0;
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.1 }),
      responses: () => failing(),
      before: () => {
        if (failures++ < 3) throw new Error("429 usage limit reached, try again later");
      },
      extra: { sleep: async (ms) => { slept.push(ms); } },
    });
    assert.deepEqual(slept.slice(0, 3), [60_000, 120_000, 240_000]);
    const waits = ofType(run.events, "campaign.waiting");
    assert.equal(waits.length, 3);
    assert.ok(waits.every((w) => w.data.reason === "usage_limit"));
    assert.equal(run.end.reason, "allowance");
  });

  it("ends a turn from inside a session, without counting against the prover", async () => {
    const limit = fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 usage limit reached" });
    const slept: number[] = [];
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.1 }),
      responses: (n) => (n === 2 ? Array.from({ length: 12 }, () => limit) : failing()),
      extra: { sleep: async (ms) => { slept.push(ms); } },
    });
    const ended = ofType(run.events, "turn.ended");
    assert.ok(ended.some((e) => e.data.reason === "usage_limit"), ended.map((e) => e.data.reason).join(","));
    assert.ok(slept.some((ms) => Math.abs(ms - 60_000) <= 5));
    assert.equal(run.end.reason, "allowance");
  });
});

describe("the watchdog", () => {
  it("restarts a dead supervisor after a backoff, and stops when the campaign is over", async () => {
    const dir = join(tempDir("mh-watch-"), "run");
    let now = Date.parse("2026-11-01T10:00:00Z");
    const slept: number[] = [];
    let starts = 0;
    const result = await watchCampaign({
      dir,
      clock: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
      run: async () => {
        starts += 1;
        // The first two supervisors die at once; the third works the campaign to its end.
        if (starts < 3) return 1;
        const run = await simulatedCampaign({ dir, config: campaignConfig({ turnUsd: 0.03, allowance: 0.05 }), responses: () => failing(), wallClock: () => now });
        assert.equal(run.end.reason, "allowance");
        return 0;
      },
    });
    assert.equal(result.restarts, 3);
    assert.deepEqual(slept, [60_000, 120_000]);
    assert.equal(campaignOver(dir), true);
  });

  it("leaves a live supervisor alone and restarts one whose heartbeat is old", async () => {
    const dir = join(tempDir("mh-watch-"), "run");
    let now = Date.parse("2026-11-01T10:00:00Z");
    beat(dir, { pid: 99, now, turn: 0 });
    acquireLock(dir, { pid: 99, now: () => now, isAlive: () => false });
    let polls = 0;
    let started = false;
    await watchCampaign({
      dir,
      clock: () => now,
      isAlive: () => true,
      sleep: async (ms) => { polls += 1; now += ms; },
      run: async () => { started = true; return 0; },
    });
    // The heartbeat aged past the bound while the watchdog polled; only then did it restart the supervisor.
    assert.ok(polls >= 15 && started);
  });
});

describe("the command line", () => {
  const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
  const harness = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    try {
      const r = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HARNESS_HOST: "" } });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, out: e.stdout, err: e.stderr };
    }
  };

  it("documents harness campaign, and refuses what it cannot do", async () => {
    assert.match((await harness(["--help"])).out, /harness campaign STATEMENT\|FILE \[--max-usd X\] \[--usd-per-day X\] \[--until ISO_TIME\]/);
    assert.match((await harness(["campaign"])).err, /campaign needs a statement/);
    assert.match((await harness(["campaign", "(n : ℕ) : n + 0 = n", "--until", "tomorrow"])).err, /--until must be an ISO time/);
    assert.match((await harness(["campaign", "(n : ℕ) : n + 0 = n", "--usd-per-day", "0"])).err, /--usd-per-day must be positive/);
    assert.match((await harness(["campaign", "--resume", "/nonexistent-run", "--model", "x/y"])).err, /cannot be given with it/);
  });
});
