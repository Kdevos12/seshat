import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { FrozenPacket, Line, PacketRequest } from "@seshat/lines";
import { readEvents, type HarnessEvent } from "@seshat/core";
import { buildReport, checkConfig, DEFAULT_CONFIG, hintCommand, steerCommand } from "../src/index.ts";
import { composePacket, NEW_SINCE_HEADING, packetFault } from "../src/packet.ts";
import { check, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { nth } from "./resume-helpers.ts";
import { consortium } from "./turns-helpers.ts";

type Message = TranscriptContext["messages"][number];

/** The texts of the user message of a request: one for a string packet, two (prefix, tail) for a frozen one. */
function userTexts(context: TranscriptContext): string[] {
  const messages = context.messages.filter((m) => m.role === "user");
  assert.equal(messages.length, 1, "a packet leaves one user message");
  const content = (messages[0] as Message & { role: "user" }).content;
  return typeof content === "string" ? [content] : content.flatMap((c) => (c.type === "text" ? [c.text] : []));
}

const PREMISES = Array.from({ length: 40 }, (_, k) => `premise_${k}: a lemma about n + ${k} = ${k} + n, stated in full so that it takes room`);

/** The last tool result of a transcript, as the line reads it. */
function lastFeedback(request: PacketRequest): string {
  return request.transcript.findLast((e) => e.role === "tool")?.text.split("\n")[0] ?? "no check yet";
}

/** A line that answers a frozen packet whose prefix would differ on every request if the harness let it. */
function frozenLine(extra: (request: PacketRequest) => Partial<FrozenPacket> = () => ({}), seen: Array<string | undefined> = []): Line {
  return {
    id: "M4",
    title: "frozen packet",
    requires: [],
    hooks: {
      contextPacket: async (_session, request) => {
        seen.push(request.prefix);
        return {
          prefix: `Goal: n + 0 = n.\nPremises, compiled for request ${request.request}:\n${PREMISES.join("\n")}`,
          tail: `Request ${request.request}. Last Lean feedback: ${lastFeedback(request)}`,
          ...extra(request),
        };
      },
    },
  };
}

describe("composePacket", () => {
  it("freezes the first prefix and reads every tail", () => {
    const first = composePacket({ prefix: "P1", tail: "T1" }, undefined);
    assert.deepEqual(first.texts, { prefix: "P1", tail: "T1" });
    const second = composePacket({ prefix: "P2", tail: "T2" }, first.state);
    assert.deepEqual(second.texts, { prefix: "P1", tail: "T2" });
  });

  it("lists the facts that the first answer did not have, in order, at most newSince of them", () => {
    const first = composePacket({ prefix: "P", tail: "T1", facts: ["a", "b"], newSince: 2 }, undefined);
    assert.equal(first.texts.tail, "T1", "nothing is new at the start");
    const later = (facts: string[]) => composePacket({ prefix: "ignored", tail: "T", facts, newSince: 2 }, first.state).texts.tail;
    assert.equal(later(["a", "b"]), "T");
    assert.equal(later(["a", "b", "c"]), `T\n\n${NEW_SINCE_HEADING}\n- c`);
    assert.equal(later(["c", "a", "d", "c", "e"]), `T\n\n${NEW_SINCE_HEADING}\n- c\n- d\n- (1 more)`);
    assert.equal(composePacket({ prefix: "", tail: "", facts: ["z"], newSince: 1 }, first.state).texts.tail, `${NEW_SINCE_HEADING}\n- z`);
    assert.equal(composePacket({ prefix: "", tail: "T", facts: ["z"] }, first.state).texts.tail, "T", "no list without the option");
    assert.equal(composePacket({ prefix: "", tail: "T", facts: ["z"], newSince: 0 }, first.state).texts.tail, "T");
  });

  it("tells a bad answer from a good one", () => {
    for (const good of [undefined, "text", { prefix: "", tail: "" }, { prefix: "p", tail: "t", facts: ["f"], newSince: 3 }]) {
      assert.equal(packetFault(good), undefined);
    }
    for (const bad of [3, null, [], {}, { prefix: "p" }, { prefix: 1, tail: "t" }, { prefix: "p", tail: "t", facts: "f" }, { prefix: "p", tail: "t", facts: [1] }, { prefix: "p", tail: "t", newSince: -1 }, { prefix: "p", tail: "t", newSince: 1.5 }]) {
      assert.notEqual(packetFault(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("the frozen packet prefix in a session", () => {
  const run = async (line: Line, responses = 3, config: Parameters<typeof demoRun>[0]["config"] = {}) => {
    const requests: TranscriptContext[] = [];
    const answer = (context: TranscriptContext, proof: string) => {
      requests.push(context);
      return check(proof);
    };
    const steps = Array.from({ length: responses }, (_, k) => (context: TranscriptContext) => answer(context, k === responses - 1 ? "exact trivial_proof" : "bad"));
    const done = await demoRun({ lines: { M4: line }, config: { lines: ["M4"], ...config }, responses: steps });
    return { ...done, requests };
  };

  it("sends the prefix of the first request, byte for byte, on every request, followed by that request's tail", async () => {
    const seen: Array<string | undefined> = [];
    const { result, requests } = await run(frozenLine(() => ({}), seen));
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(requests.length, 3);
    const texts = requests.map(userTexts);
    const first = texts[0]?.[0] ?? "";
    assert.match(first, /^Goal: n \+ 0 = n\.\nPremises, compiled for request 1:\n/);
    for (const [k, [prefix, tail]] of texts.entries()) {
      assert.equal(Buffer.from(prefix ?? "").equals(Buffer.from(first)), true, `request ${k + 1}: the prefix is the first one`);
      assert.match(tail ?? "", new RegExp(`^Request ${k + 1}\\. `));
    }
    // The tail changes with the session: the second request reads what Lean said about the first check.
    assert.equal(new Set(texts.map((t) => t[1])).size, 3);
    assert.match(texts[0]?.[1] ?? "", /Last Lean feedback: no check yet$/);
    assert.match(texts[1]?.[1] ?? "", /Last Lean feedback: (?!no check yet)/);
    // The line is told the frozen prefix from the second request on, and nothing before.
    assert.deepEqual(seen, [undefined, first, first]);
    // The messages before the user's are the system ones, as for any request.
    for (const context of requests) assert.deepEqual(context.messages.map((m) => m.role).filter((role) => role !== "user"), ["system"]);
  });

  it("keeps the prefix for the wrap-up request, and freezes a new one in the next session", async () => {
    const requests: TranscriptContext[] = [];
    const step = (response: ReturnType<typeof check>) => (context: TranscriptContext) => {
      requests.push(context);
      return response;
    };
    // Session 1 ends at its first turn (the limit), is asked for its notes, and session 2 starts afresh.
    const { result } = await demoRun({
      lines: { M4: frozenLine() },
      config: { lines: ["M4"], limits: { turns: 1, contextTokens: 120_000 }, sessions: 2 },
      responses: [step(check("bad")), step(say("My notes.")), step(check("exact trivial_proof"))],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const texts = requests.map(userTexts);
    assert.equal(texts.length, 3);
    assert.match(texts[1]?.[1] ?? "", /^Request 2\. /, "the wrap-up is the session's second request");
    assert.equal(texts[1]?.[0], texts[0]?.[0]);
    assert.match(texts[2]?.[1] ?? "", /^Request 1\. /, "the next session counts its requests from 1");
    assert.match(texts[2]?.[0] ?? "", /compiled for request 1:/);
  });

  it("lists what is new since the session started in the tail, as an option", async () => {
    const facts = (request: PacketRequest) => ["lemma_a", ...(request.request >= 2 ? ["lemma_b"] : []), ...(request.request >= 3 ? ["lemma_c", "lemma_d"] : [])];
    const withOption = await run(frozenLine((request) => ({ facts: facts(request), newSince: 2 })));
    const tails = withOption.requests.map((c) => userTexts(c)[1] ?? "");
    assert.doesNotMatch(tails[0] ?? "", /New since/);
    assert.match(tails[1] ?? "", new RegExp(`\\n\\n${NEW_SINCE_HEADING}\\n- lemma_b$`));
    assert.match(tails[2] ?? "", new RegExp(`${NEW_SINCE_HEADING}\\n- lemma_b\\n- lemma_c\\n- \\(1 more\\)$`));
    // The prefix does not move, and the facts do not appear in it.
    assert.equal(new Set(withOption.requests.map((c) => userTexts(c)[0])).size, 1);

    const without = await run(frozenLine((request) => ({ facts: facts(request) })));
    for (const context of without.requests) assert.doesNotMatch(userTexts(context).join("\n"), /New since/);
  });

  it("ignores a later prefix that differs, and says so once per session in the progress log", async () => {
    const logs: string[] = [];
    const { requests } = await (async () => {
      const requests: TranscriptContext[] = [];
      const steps = [0, 1, 2].map((k) => (context: TranscriptContext) => {
        requests.push(context);
        return check(k === 2 ? "exact trivial_proof" : "bad");
      });
      await demoRun({ lines: { M4: frozenLine() }, config: { lines: ["M4"] }, responses: steps, log: (line) => logs.push(line) });
      return { requests };
    })();
    // The line's prefix names the request it was compiled for; the model only ever sees the first one.
    for (const context of requests) {
      assert.match(userTexts(context)[0] ?? "", /compiled for request 1:/);
      assert.doesNotMatch(userTexts(context)[0] ?? "", /compiled for request [23]:/);
    }
    assert.equal(logs.filter((l) => /differs from the frozen one/.test(l)).length, 1);
    assert.match(logs.find((l) => /differs from the frozen one/.test(l)) ?? "", /line M4 answered a prefix that differs from the frozen one; the session keeps the first/);

    // A line that returns request.prefix is not told off.
    const quiet: string[] = [];
    const careful: Line = {
      id: "M4",
      title: "careful",
      requires: [],
      hooks: { contextPacket: async (_s, r) => ({ prefix: r.prefix ?? "the prefix", tail: `Request ${r.request}.` }) },
    };
    await demoRun({ lines: { M4: careful }, config: { lines: ["M4"] }, responses: [check("bad"), check("exact trivial_proof")], log: (line) => quiet.push(line) });
    assert.equal(quiet.filter((l) => /differs from the frozen one/.test(l)).length, 0);
  });

  it("still takes a string, as before", async () => {
    const { requests } = await run({ id: "M4", title: "string", requires: [], hooks: { contextPacket: async (_s, r) => `PACKET ${r.request}` } });
    assert.deepEqual(requests.map(userTexts), [["PACKET 1"], ["PACKET 2"], ["PACKET 3"]]);
  });

  it("ends the session with an error when the answer is neither a string nor a prefix and a tail", async () => {
    const broken: Line = { id: "M4", title: "broken", requires: [], hooks: { contextPacket: async () => ({ prefix: "p" }) as unknown as FrozenPacket } };
    const { events } = await demoRun({ lines: { M4: broken }, config: { lines: ["M4"] }, responses: [check("exact trivial_proof")] });
    assert.match(ofType(events, "attempt.finished")[0]?.data.error ?? "", /^line M4 failed in contextPacket: a \{ prefix, tail \} answer needs two strings$/);
  });
});

describe("the team's answers and a line's packet (review round 1)", () => {
  const packetLine = (frozen: boolean): Line => ({
    id: "M4",
    title: "packet",
    requires: [],
    resume: "stateless",
    hooks: { contextPacket: async (_s, r) => (frozen ? { prefix: "THE PREFIX", tail: `Request ${r.request}.` } : `PACKET ${r.request}`) },
  });

  for (const frozen of [false, true]) {
    it(`reach the session when a line's ${frozen ? "frozen " : "string "}packet replaces the prompt: in the tail, never in the frozen prefix`, async () => {
      const first = await demoRun({ lines: { M4: packetLine(frozen) }, config: { lines: ["M4"], sessions: 3, consortium: consortium({ tokens: 1 }) }, responses: [check("bad")] });
      const claimId = ofType(first.events, "problem.registered")[0]?.data.claimId as string;
      hintCommand(first.dir, { claimId, text: "Try strong induction on n.", as: "alice", out: () => undefined });
      steerCommand(first.dir, { forbid: "automation", as: "alice", out: () => undefined });
      const requests: TranscriptContext[] = [];
      await demoResume({
        dir: first.dir,
        bench: first.bench,
        lines: { M4: packetLine(frozen) },
        turns: { limit: { tokens: 1e12 } },
        responses: [(context) => (requests.push(context), check("bad")), (context) => (requests.push(context), check("exact trivial_proof"))],
      });
      assert.ok(requests.length >= 2);
      for (const context of requests) {
        const texts = userTexts(context);
        const all = texts.join("\n");
        assert.match(all, /# Hints from the team\n.*suggestions, not facts and not proofs[\s\S]*- alice: Try strong induction on n\./);
        assert.match(all, /# What the team asks\nThe team rules out these strategies for this work: automation\./);
        if (frozen) {
          assert.equal(texts[0], "THE PREFIX", "the frozen prefix is the line's alone, so the cache is not broken");
          assert.match(texts[1] ?? "", /^Request \d+\.\n\n# Hints from the team/);
        } else {
          assert.match(texts[0] ?? "", /^PACKET \d+\n\n# Hints from the team/);
        }
      }
    });
  }
});

describe("the cache in the cost and the report", () => {
  /** A packet whose premises come in another order on every request when `shuffle` is set: what recompiling does to a prefix. */
  const premisesAt = (request: number, shuffle: boolean) => (shuffle ? [...PREMISES.slice(request), ...PREMISES.slice(0, request)] : PREMISES);
  const recompiled: Line = {
    id: "M4",
    title: "recompiled",
    requires: [],
    hooks: {
      contextPacket: async (_s, r) => `Goal: n + 0 = n.\n${premisesAt(r.request, true).join("\n")}\n\nRequest ${r.request}. Last Lean feedback: ${lastFeedback(r)}`,
    },
  };
  const frozenOf: Line = {
    id: "M4",
    title: "frozen",
    requires: [],
    hooks: {
      contextPacket: async (_s, r) => ({
        prefix: `Goal: n + 0 = n.\n${premisesAt(r.request, true).join("\n")}`,
        tail: `Request ${r.request}. Last Lean feedback: ${lastFeedback(r)}`,
      }),
    },
  };
  const frozen: Line = frozenOf;
  const solve = (line: Line, config: Parameters<typeof demoRun>[0]["config"] = {}) =>
    demoRun({ lines: { M4: line }, config: { lines: ["M4"], ...config }, responses: [check("bad"), check("bad"), check("bad"), check("exact trivial_proof")] });

  it("reads cached input tokens into the journal and the report, and the frozen prefix is cheaper than a recompiled one", async () => {
    const a = await solve(frozen);
    const b = await solve(recompiled);
    for (const run of [a, b]) {
      const finished = ofType(run.events, "attempt.finished");
      const charged = ofType(run.events, "attempt.charged");
      assert.equal(run.result.report.cachedInputTokens, finished.reduce((sum, e) => sum + (e.data.cachedInputTokens ?? 0), 0));
      assert.equal(run.result.report.cachedInputTokens, charged.reduce((sum, e) => sum + (e.data.cachedInputTokens ?? 0), 0));
      assert.ok(run.result.report.cachedInputTokens > 0 && run.result.report.cachedInputTokens < run.result.report.inputTokens);
      assert.match(readFileSync(join(run.dir, "report.md"), "utf8"), /Cached input: \d+ of the \d+ \(\d+%\)\./);
      assert.equal(run.result.report.usdPerProof, run.result.report.usd, "one problem with a proof");
    }
    // The faux provider caches the longest common prefix of a session's requests, as automatic prefix caching does.
    // Both read the system prompt from the cache; only the frozen one reads its premises (about 700 tokens, three times).
    assert.ok(a.result.report.cachedInputTokens - b.result.report.cachedInputTokens > 1500, `${a.result.report.cachedInputTokens} against ${b.result.report.cachedInputTokens}`);
    assert.ok(a.result.report.usdPerProof !== undefined && b.result.report.usdPerProof !== undefined && a.result.report.usdPerProof < b.result.report.usdPerProof);
  });

  it("asks the provider for the configured cache retention, and records it", async () => {
    const none = await solve(frozen, { cacheRetention: "none" });
    assert.equal(none.result.report.cachedInputTokens, 0, "the faux provider reads no cache when asked for none");
    assert.doesNotMatch(readFileSync(join(none.dir, "report.md"), "utf8"), /Cached input/);
    assert.equal((ofType(none.events, "run.started")[0]?.data.config as { cacheRetention?: string }).cacheRetention, "none");
    const short = await solve(frozen, { cacheRetention: "short" });
    assert.ok(short.result.report.cachedInputTokens > 0);
    const unset = await solve(frozen);
    assert.equal("cacheRetention" in (ofType(unset.events, "run.started")[0]?.data.config as object), false);
    assert.equal(unset.result.report.cachedInputTokens, short.result.report.cachedInputTokens, "the default is the provider's, which caches");
  });

  it("keeps the cache reads of a session that the harness ended at its charges, in the report", () => {
    let seq = 0;
    const event = <K extends HarnessEvent["type"]>(type: K, data: Extract<HarnessEvent, { type: K }>["data"]): HarnessEvent =>
      ({ v: 1, seq: seq++, id: `e${seq}`, ts: "2026-01-01T00:00:00Z", run: "r", actor: "t", type, data, prev: "", hash: "" }) as unknown as HarnessEvent;
    const charged = (attemptId: string, cached?: number) =>
      event("attempt.charged", { attemptId, usd: 1, inputTokens: 100, outputTokens: 10, ...(cached !== undefined ? { cachedInputTokens: cached } : {}) });
    const events = [
      event("run.started", { runId: "r", benchId: "b", problems: 1, host: "h", config: {} }),
      // A session the harness failed in: two charges, and an attempt.finished written from them (chargedTotals), with no cached field.
      event("attempt.started", { attemptId: "a1", claimId: "c", prover: "p1", iteration: 1, model: "m" }),
      charged("a1", 60),
      charged("a1", 40),
      event("attempt.finished", { attemptId: "a1", outcome: "error", stoppedBy: "error", durationMs: 1, turns: 2, usd: 2, inputTokens: 200, outputTokens: 20 }),
      // A session that finished with its own total, which is the sum of its charges.
      event("attempt.started", { attemptId: "a2", claimId: "c", prover: "p1", iteration: 2, model: "m" }),
      charged("a2", 30),
      charged("a2", 20),
      event("attempt.finished", { attemptId: "a2", outcome: "invalid", stoppedBy: "model", durationMs: 1, turns: 2, usd: 2, inputTokens: 200, outputTokens: 20, cachedInputTokens: 50 }),
      // A session that has not finished: counted at its charges.
      event("attempt.started", { attemptId: "a3", claimId: "c", prover: "p1", iteration: 3, model: "m" }),
      charged("a3", 7),
      // A session with nothing cached.
      event("attempt.started", { attemptId: "a4", claimId: "c", prover: "p1", iteration: 4, model: "m" }),
      charged("a4"),
      event("attempt.finished", { attemptId: "a4", outcome: "invalid", stoppedBy: "model", durationMs: 1, turns: 1, usd: 1, inputTokens: 100, outputTokens: 10 }),
    ];
    const report = buildReport(events);
    assert.equal(report.cachedInputTokens, 100 + 50 + 7);
    assert.equal(report.inputTokens, 200 + 200 + 100 + 100);
  });

  it("keeps the cache reads of a session that a resumption cut, in the report", async () => {
    const stateless: Line = { ...frozenOf, resume: "stateless" };
    const script = () => [check("bad"), check("bad"), check("bad"), check("exact trivial_proof")];
    const whole = await demoRun({ lines: { M4: stateless }, config: { lines: ["M4"], sessions: 2 }, responses: script() });
    // The process ends after the session's third charge: the session is cut, with cache reads charged and no attempt.finished.
    const cut = nth(whole.events, "attempt.charged", 3) + 1;
    const dir = killedAt(whole.dir, cut);
    const before = buildReport(readEvents(join(dir, "journal.jsonl")));
    const cutEvents = readEvents(join(dir, "journal.jsonl"));
    const cutCached = ofType(cutEvents, "attempt.charged").reduce((sum, e) => sum + (e.data.cachedInputTokens ?? 0), 0);
    assert.ok(cutCached > 0 && before.cachedInputTokens === cutCached, "the report of the cut journal counts the charges of the unfinished session");

    const resumed = await demoResume({ dir, bench: whole.bench, lines: { M4: stateless }, responses: script().slice(3) });
    const [interrupted] = ofType(resumed.events, "attempt.finished");
    assert.equal(interrupted?.data.stoppedBy, "interrupted");
    assert.equal(interrupted?.data.cachedInputTokens, undefined, "the resumption writes the attempt's end from the projection, which has no cached sum");
    assert.equal(interrupted?.data.inputTokens, ofType(cutEvents, "attempt.charged").reduce((sum, e) => sum + e.data.inputTokens, 0));
    const after = resumed.result.report;
    assert.ok(after.cachedInputTokens >= before.cachedInputTokens, `${after.cachedInputTokens} after, ${before.cachedInputTokens} before`);
    const everyCharge = ofType(resumed.events, "attempt.charged").reduce((sum, e) => sum + (e.data.cachedInputTokens ?? 0), 0);
    assert.equal(after.cachedInputTokens, everyCharge, "every cache read ever charged is in the report, the cut session's included");
  });

  it("checks the configured retention", () => {
    const config = { ...DEFAULT_CONFIG, selection: { all: true }, model: "p/m" };
    assert.deepEqual(checkConfig({ ...config, cacheRetention: "long" }), []);
    assert.match(checkConfig({ ...config, cacheRetention: "forever" as never })[0] ?? "", /^cacheRetention must be one of none, short, long, got forever$/);
  });

  it("keeps the retention when a run is resumed", async () => {
    const script = () => [check("bad"), say("Notes."), check("exact trivial_proof")];
    const stateless: Line = { ...frozenOf, resume: "stateless" };
    const whole = await demoRun({ lines: { M4: stateless }, config: { lines: ["M4"], sessions: 3, cacheRetention: "none" }, responses: script() });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const resumed = await demoResume({ dir, bench: whole.bench, lines: { M4: stateless }, responses: script().slice(2) });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assert.equal(resumed.result.report.cachedInputTokens, 0, "session 2 asked for none, as the run began");
    assert.equal((ofType(resumed.events, "run.started")[0]?.data.config as { cacheRetention?: string }).cacheRetention, "none");
  });
});
