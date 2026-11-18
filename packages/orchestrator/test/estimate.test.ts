import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEvents } from "@seshat/core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { ceilingEstimate, estimateCeiling, estimateLine, MIN_MEASURED_SESSIONS, measuredSessions, sessionsOf, sessionUsd, solveCommand, tokenPrices } from "../src/index.ts";
import { PriceBook } from "../src/prices.ts";
import { BARE_MACHINE } from "../../ui/test/helpers.ts";
import { check, demoRun, say, tempDir } from "./m0-helpers.ts";

const PRICES = { input: 0.28, cachedInput: 0.028, output: 0.42 };

describe("what the ceiling buys (UX10)", () => {
  it("prices a session at the cache-miss, cache-hit and output prices", () => {
    assert.equal(sessionUsd({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, PRICES), 0.28);
    assert.ok(Math.abs(sessionUsd({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000 }, PRICES) - (0.14 + 0.014 + 0.42)) < 1e-12);
    // A cached count above the input count (an odd provider) is capped: never a negative charge.
    assert.ok(sessionUsd({ inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 }, PRICES) > 0);
  });

  it("takes the host's table first, pi-ai's prices otherwise", () => {
    const model = { provider: "p", id: "m", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } };
    assert.deepEqual(tokenPrices(model), { input: 1, cachedInput: 0.1, output: 2 });
    assert.deepEqual(tokenPrices({ ...model, cost: { ...model.cost, cacheRead: 0 } }).cachedInput, 1, "no cache price: the input price");
    const book = new PriceBook({ "p/m": { pricing: { cacheMiss: 0.5, cacheHit: 0.05, output: 0.7 } } } as never);
    assert.deepEqual(tokenPrices(model, book), { input: 0.5, cachedInput: 0.05, output: 0.7 });
  });

  it("with nothing measured, says only what tokens the ceiling buys, and that a first run teaches it more", () => {
    const e = estimateCeiling(2, "p/m", PRICES);
    assert.equal(e.measured, undefined);
    const line = estimateLine(e);
    assert.match(line, /^Estimate: \$2 buys about 7\.1 million input tokens or 4\.8 million output tokens of p\/m\./);
    assert.match(line, /No session has been measured on this machine yet/);
    const few = { runs: 1, sessions: Array.from({ length: MIN_MEASURED_SESSIONS - 1 }, () => ({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 })), sessionsPerProblem: [4] };
    assert.equal(estimateCeiling(2, "p/m", PRICES, few).measured, undefined, "too few sessions: no number of sessions");
  });

  it("with sessions measured, gives the median session's price and what the ceiling buys of sessions and problems", () => {
    const session = (input: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: 0 });
    // Median input: 100k tokens, $0.028 a session at $0.28 a million: $2 buys 71 sessions, 17 problems at about 4 a problem.
    const measured = { runs: 2, sessions: [50_000, 80_000, 100_000, 120_000, 5_000_000].map(session), sessionsPerProblem: [3, 4, 5] };
    const e = estimateCeiling(2, "p/m", PRICES, measured);
    assert.equal(e.measured?.sessionsBought, 71);
    assert.equal(e.measured?.problemsBought, 17);
    assert.match(estimateLine(e), /^Estimate: \$2 buys about 71 sessions of p\/m, or about 17 problems like the earlier ones \(the median of 5 sessions of 2 runs on this machine, at \$0\.0280 each at this model's price\)\. A hard problem can take more\.$/);
  });

  it("measures the sessions of the runs on this machine from their journals, skipping what is not a run", async () => {
    const run = await demoRun({ config: { sessions: 3 }, responses: [check("bad"), say("I stop here."), check("exact trivial_proof")] });
    const found = sessionsOf(readEvents(join(run.dir, "journal.jsonl")));
    assert.equal(found.sessions.length, 2);
    assert.equal(found.problems, 1);
    assert.ok(found.sessions.every((s) => s.inputTokens > 0));
    const runs = tempDir();
    mkdirSync(join(runs, "_inputs"));
    mkdirSync(join(runs, "empty"));
    mkdirSync(join(runs, "broken"));
    writeFileSync(join(runs, "broken", "journal.jsonl"), "{not json\n");
    for (const name of ["a", "b", "c"]) cpSync(run.dir, join(runs, name), { recursive: true });
    const m = measuredSessions(runs);
    assert.equal(m.runs, 3);
    assert.equal(m.sessions.length, 6);
    assert.deepEqual(m.sessionsPerProblem, [2, 2, 2]);
    assert.equal(measuredSessions(runs, 1).runs, 1, "only the newest runs are read");
    assert.deepEqual(measuredSessions(join(runs, "absent")), { runs: 0, sessions: [], sessionsPerProblem: [] });
    const e = estimateCeiling(2, "p/m", PRICES, m);
    assert.ok((e.measured?.sessionsBought ?? 0) > 0);
    assert.equal(e.measured?.problemsBought, Math.floor((e.measured?.sessionsBought ?? 0) / 2));
  });

  it("is the line solve prints before it spends, and what the start form asks, for the model solve would choose", async () => {
    const model = { provider: "acme", id: "mid", name: "mid", api: "openai-completions", baseUrl: "http://x", input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 8000, cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
    const models = { getAvailable: async () => [model], getModel: (p: string, id: string) => (p === "acme" && id === "mid" ? model : undefined) } as unknown as Models;
    const answer = await ceilingEstimate({ models, maxUsd: 2, host: "local", measured: { runs: 0, sessions: [], sessionsPerProblem: [] } });
    assert.equal(answer.model, "acme/mid");
    assert.equal(answer.rule, "cheapest capable model");
    assert.match(answer.line ?? "", /^Estimate: \$2 buys about 20 million input tokens or 4\.0 million output tokens of acme\/mid\./);
    assert.deepEqual(await ceilingEstimate({ models: { getAvailable: async () => [] } as unknown as Models, maxUsd: 2, host: "local", measured: { runs: 0, sessions: [], sessionsPerProblem: [] } }), {}, "nothing to choose: nothing said");
    const out: string[] = [];
    // The run after the start output fails on the stub; the banner is what this test reads.
    await solveCommand("(n : ℕ) : n + 0 = n", { out: join(tempDir(), "run"), noCheck: true, max: 2, host: "local", yes: true }, { out: (l) => out.push(l), err: () => {}, models, system: BARE_MACHINE }).catch(() => 0);
    assert.ok(out.some((l) => /^Estimate: \$2 buys about 20 million input tokens/.test(l)), out.join("\n"));
  });
});
