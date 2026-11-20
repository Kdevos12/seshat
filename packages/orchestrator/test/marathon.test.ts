import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { readEvents, verifyChain } from "@seshat/core";
import { campaignOver, readCampaign, runCampaign, scoresByTurn, watchCampaign, type RunResult } from "../src/index.ts";
import { check, demoResume, demoRun, ofType, tempDir } from "./m0-helpers.ts";
import { campaignConfig } from "./campaign-helpers.ts";
import { assertSound } from "./resume-helpers.ts";

/**
 * The simulated marathon (plan change LH7.1): a campaign over 30 days of an injected clock, the faux provider and a simulated Lean that accepts
 * an `aux_` lemma now and then, with crashes between and inside turns, reboots and usage limits. The real $10 marathon (LH7.2) has not run.
 */

const DAY = 86_400_000;
const START = Date.parse("2026-11-01T00:00:00Z");
const END = "2026-12-01T00:00:00.000Z";
const CAP = 0.02;

class SimulatedCrash extends Error {}

const textOf = (context: TranscriptContext): string => {
  const first = context.messages[0];
  return first === undefined ? "" : typeof first.content === "string" ? first.content : first.content.map((c) => (c.type === "text" ? c.text : "")).join("");
};

describe("the simulated marathon (LH7.1)", () => {
  it("works 30 simulated days through crashes, reboots and usage limits, and loses nothing", async () => {
    const started = Date.now();
    const dir = join(tempDir("mh-marathon-"), "run");
    let now = START;
    const clock = (): number => now;
    const openings: number[] = [];
    let lemma = 0;
    let turnsRun = 0;
    let crashes = 0;
    let limits = 0;
    const survivors = new Set<string>();

    // A session's responses: each fails its check; one session in three also brings an `aux_` lemma that the simulated Lean accepts.
    const responses = (): FauxResponseStep[] =>
      Array.from({ length: 40 }, (_, i) => (context: TranscriptContext) => {
        if (!context.messages.some((m) => m.role === "assistant")) openings.push(textOf(context).length);
        return check("bad", i % 3 === 0 ? `theorem aux_m${lemma++} : True := trivial` : "");
      });

    let bench: Awaited<ReturnType<typeof demoRun>>["bench"] | undefined;
    const config = campaignConfig({ turnUsd: 0.02, allowance: 20, over: { campaign: { usdPerDay: CAP, until: END, spiralTurns: 1000 } } });
    const pricePerMillion = 3;

    /** What a process killed in the middle of the turn that just ended leaves: the journal cut inside it, maybe a torn line, no projection. */
    const crash = (): never => {
      const path = join(dir, "journal.jsonl");
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
      const events = lines.map((l) => JSON.parse(l) as { type: string });
      const from = events.findLastIndex((e) => e.type === "turn.started");
      const cut = from + 1 + Math.floor((lines.length - from - 1) / 2);
      writeFileSync(path, lines.slice(0, cut).map((l) => `${l}\n`).join(""));
      if (crashes % 2 === 0) appendFileSync(path, (lines[cut] ?? "").slice(0, 20));
      for (const f of ["projection.sqlite", "projection.sqlite-wal", "projection.sqlite-shm"]) rmSync(join(dir, f), { force: true });
      crashes += 1;
      throw new SimulatedCrash("the process died");
    };

    let process = 0;
    const supervise = async (): Promise<number> => {
      process += 1;
      const me = 5000 + process;
      try {
        await runCampaign({
          dir,
          pid: me,
          isAlive: () => false,
          clock,
          sleep: async (ms) => { now += ms; },
          first: async () => {
            const run = await demoRun({ dir, config, responses: responses(), pricePerMillion, wallClock: clock });
            bench = run.bench;
            turnsRun += 1;
            return run.result;
          },
          next: async ({ limit }): Promise<RunResult> => {
            turnsRun += 1;
            // Usage limits: the provider refuses a turn now and then; the supervisor backs off and goes on.
            if (turnsRun % 11 === 0) {
              limits += 1;
              throw new Error("429 usage limit reached, try again later");
            }
            // The clock moves a little in a turn.
            now += 20 * 60_000;
            const run = await demoResume({ dir, bench: bench as NonNullable<typeof bench>, responses: responses(), pricePerMillion, wallClock: clock, ...(limit !== undefined ? { turns: { limit } } : {}) });
            if (turnsRun % 7 === 0) {
              // A crash or a reboot in the middle of this turn: what its finished sessions wrote before the cut survives.
              crash();
            }
            return run.result;
          },
        });
        return 0;
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        // A reboot takes hours.
        if (crashes % 3 === 0) now += 6 * 3_600_000;
        return 1;
      }
    };

    // A crash can come after sessions that finished in the turn being cut: those in the surviving prefix must still be there at the end.
    const before = (): void => {
      const path = join(dir, "journal.jsonl");
      if (!existsSync(path)) return;
      for (const e of ofType(readEvents(path), "attempt.finished")) survivors.add(e.data.attemptId);
    };
    const watched = watchCampaign({
      dir,
      clock,
      sleep: async (ms) => { now += ms; },
      isAlive: () => false,
      run: async () => {
        before();
        return supervise();
      },
    });
    const { restarts } = await watched;

    const path = join(dir, "journal.jsonl");
    const events = readEvents(path);
    assert.equal(campaignOver(dir), true);
    assert.equal(ofType(events, "campaign.stopped").at(-1)?.data.reason, "until");
    assert.ok(now >= Date.parse(END), "the campaign ran to the end of the 30 days");
    assert.ok(restarts > 3 && crashes >= 3 && limits >= 2, `restarts ${restarts}, crashes ${crashes}, usage limits ${limits}`);

    // No work lost: every session that finished before a crash is in the journal once, and the chain holds.
    assert.deepEqual(verifyChain(events), { ok: true });
    const finished = ofType(events, "attempt.finished").map((e) => e.data.attemptId);
    assert.equal(new Set(finished).size, finished.length, "no session is twice in the journal");
    assert.ok(survivors.size > 0);
    for (const id of survivors) assert.ok(finished.includes(id), `${id} survived a crash`);
    assertSound(events);

    // Every turn that began ended, and every crash was resumed.
    const turnsStarted = ofType(events, "turn.started");
    const turnsEnded = ofType(events, "turn.ended");
    for (const t of turnsStarted) assert.ok(turnsEnded.some((e) => e.data.turn === t.data.turn), `turn ${t.data.turn} ended`);
    assert.ok(ofType(events, "run.resumed").length >= crashes);
    assert.ok(turnsStarted.length >= 25, `${turnsStarted.length} turns`);

    // The cap held every day.
    const days = new Map<string, number>();
    for (const s of turnsStarted) {
      const e = turnsEnded.find((x) => x.data.turn === s.data.turn);
      const day = (s.data.at as string).slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + (e?.data.spent.turn.usd ?? 0));
    }
    assert.ok(days.size >= 25, `${days.size} days worked`);
    for (const [day, usd] of days) assert.ok(usd <= CAP + 0.012, `${day} spent ${usd}`);

    // The frontier's score never falls, and the simulated Lean's lemmas grew it.
    const view = readCampaign(dir);
    assert.ok(view !== undefined);
    let scores: number[];
    try {
      scores = scoresByTurn(view.events, view.p, view.frontierOptions).map((s) => s.score);
      const digest = readFileSync(join(dir, "campaign", "digest.md"), "utf8");
      assert.ok(digest.length <= 7000, `digest ${digest.length} characters`);
    } finally {
      view.close();
    }
    for (let i = 1; i < scores.length; i++) assert.ok((scores[i] as number) >= (scores[i - 1] as number), `score fell at turn ${i + 1}`);
    assert.ok((scores.at(-1) as number) > (scores[0] as number), "the frontier grew");

    // The size of a session's first request does not grow with the run's age.
    assert.ok(openings.length >= 30, `${openings.length} sessions`);
    const third = Math.floor(openings.length / 3);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const middle = mean(openings.slice(third, 2 * third));
    const last = mean(openings.slice(2 * third));
    assert.ok(last <= middle * 1.1 + 200, `opening messages: middle ${middle.toFixed(0)}, last ${last.toFixed(0)} characters`);

    // A bound against a run whose cost grows with its age (a replay of the whole journal at each turn would take minutes), not a benchmark: the test
    // takes about 13 s on a cloud machine and 58 s on a workstation with a slow disk (2026-11-20), where a 30 s bound failed on unchanged code.
    assert.ok(Date.now() - started < 120_000, `took ${Date.now() - started} ms`);
  });
});
