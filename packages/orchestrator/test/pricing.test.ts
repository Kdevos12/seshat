import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HostProfile, isPeak, nextOffPeak, parseHostProfile, type PricingCalendar, priceUsage } from "@seshat/registry";
import { PriceBook } from "../src/prices.ts";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { buildReport, renderRunReport, RunSetupError } from "../src/index.ts";
import { messageCost } from "../src/budget.ts";
import { check, demoResume, demoRun, killedAt, ofType, pricedRegistry } from "./m0-helpers.ts";

// Made-up numbers: peak 01:00-04:00 and 06:00-10:00 UTC on weekdays, half price otherwise, one holiday.
const CALENDAR: PricingCalendar = {
  peak: [
    { days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" },
    { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" },
  ],
  offPeakMultiplier: 0.5,
  offPeakDates: ["2026-11-04"],
};
const PRICING = { cacheHit: 0.1, cacheMiss: 2, output: 8, calendar: CALENDAR };
// 2026-11-02 is a Monday.
const at = (iso: string) => Date.parse(iso);

describe("the pricing calendar", () => {
  it("tells peak from off-peak, by weekday, window edge and listed date", () => {
    assert.equal(isPeak(CALENDAR, at("2026-11-02T01:00:00Z")), true);
    assert.equal(isPeak(CALENDAR, at("2026-11-02T03:59:59Z")), true);
    assert.equal(isPeak(CALENDAR, at("2026-11-02T04:00:00Z")), false, "the end of a window is off-peak");
    assert.equal(isPeak(CALENDAR, at("2026-11-02T07:30:00Z")), true);
    assert.equal(isPeak(CALENDAR, at("2026-11-07T07:30:00Z")), false, "Saturday");
    assert.equal(isPeak(CALENDAR, at("2026-11-04T07:30:00Z")), false, "a listed date");
  });

  it("finds the next off-peak instant", () => {
    assert.equal(nextOffPeak(CALENDAR, at("2026-11-02T05:00:00Z")), at("2026-11-02T05:00:00Z"));
    assert.equal(nextOffPeak(CALENDAR, at("2026-11-02T02:10:00Z")), at("2026-11-02T04:00:00Z"));
    assert.equal(nextOffPeak(CALENDAR, at("2026-11-02T09:59:00Z")), at("2026-11-02T10:00:00Z"));
    const always: PricingCalendar = { peak: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:59" }], offPeakMultiplier: 0.5 };
    assert.equal(nextOffPeak(always, at("2026-11-02T05:00:00Z")), at("2026-11-02T23:59:00Z"));
  });

  it("is refused when it is badly formed", () => {
    const profile = (calendar: unknown) => ({ host: "t", capabilities: {}, models: { "p/m": { pricing: { cacheHit: 1, cacheMiss: 2, output: 3, calendar } } } });
    assert.throws(() => parseHostProfile(profile({ peak: [{ days: [1], from: "05:00", to: "04:00" }], offPeakMultiplier: 0.5 })), /from must be before to/);
    assert.throws(() => parseHostProfile(profile({ peak: [], offPeakMultiplier: 0 })), /offPeakMultiplier/);
    assert.throws(() => parseHostProfile({ host: "t", capabilities: {}, models: { nomodel: {} } }), /provider\/id/);
    assert.doesNotThrow(() => parseHostProfile(profile(CALENDAR)));
  });
});

describe("prices from the host table", () => {
  const usage = { input: 1000, cacheRead: 9000, cacheWrite: 0, output: 500 };

  it("charges cache hits, misses and output at their own prices, halved off-peak", () => {
    const peak = priceUsage(PRICING, usage, at("2026-11-02T02:00:00Z"));
    assert.ok(Math.abs(peak.usd - (1000 * 2 + 9000 * 0.1 + 500 * 8) / 1e6) < 1e-12);
    assert.ok(Math.abs(peak.savedUsd - (9000 * 1.9) / 1e6) < 1e-12);
    assert.equal(peak.offPeak, false);
    const off = priceUsage(PRICING, usage, at("2026-11-02T12:00:00Z"));
    assert.ok(Math.abs(off.usd - peak.usd / 2) < 1e-12);
    assert.ok(Math.abs(off.savedUsd - peak.savedUsd / 2) < 1e-12);
    assert.equal(off.offPeak, true);
  });

  it("answers what the host says of a model, and nothing of one it does not describe", () => {
    const book = new PriceBook({ "p/m": { pricing: PRICING, ignores: { always: ["penalties"], thinking: ["temperature"] } } });
    assert.equal(book.ignores("p/m", "temperature", "high"), true);
    assert.equal(book.ignores("p/m", "temperature", "off"), false);
    assert.equal(book.ignores("p/m", "penalties", "off"), true);
    assert.equal(book.ignores("q/n", "temperature", "high"), false);
    assert.equal(book.nextOffPeak("p/m", at("2026-11-02T02:00:00Z")), at("2026-11-02T04:00:00Z"));
    assert.equal(book.nextOffPeak("q/n", 0), undefined);
  });

  const models = (pricing: object): NonNullable<HostProfile["models"]> => ({ "faux/prover": { pricing: pricing as never } });
  const run = (when: string, pricing: object | undefined) =>
    demoRun({
      responses: [check("bad"), check("exact trivial_proof")],
      ...(pricing !== undefined ? { registry: pricedRegistry(models(pricing)) } : {}),
      wallClock: () => at(when),
    });

  it("computes attempt.charged dollars from the table at a peak and at an off-peak instant", async () => {
    const peak = await run("2026-11-02T02:00:00Z", PRICING);
    const off = await run("2026-11-02T12:00:00Z", PRICING);
    const charged = (events: Awaited<ReturnType<typeof run>>["events"]) => ofType(events, "attempt.charged").map((e) => e.data);
    assert.ok(charged(peak.events).length >= 2);
    for (const [p, o] of charged(peak.events).map((c, k) => [c, charged(off.events)[k]] as const)) {
      assert.ok(p.usd > 0);
      assert.ok(Math.abs((o?.usd ?? 0) - p.usd / 2) < 1e-12, "off-peak is half of peak for the same usage");
      assert.equal(p.offPeakUsd, undefined);
      assert.equal(o?.offPeakUsd, o?.usd);
    }
    // The second request reads the first from the cache, at the cache-hit price.
    const second = charged(peak.events)[1];
    assert.ok((second?.cachedInputTokens ?? 0) > 0);
    assert.ok((second?.savedUsd ?? 0) > 0);
    const finished = ofType(peak.events, "attempt.finished")[0]?.data;
    assert.ok(Math.abs((finished?.usd ?? 0) - charged(peak.events).reduce((n, c) => n + c.usd, 0)) < 1e-12);
  });

  it("charges pi-ai's numbers when the host has no table", async () => {
    const none = await run("2026-11-02T02:00:00Z", undefined);
    const withTable = await run("2026-11-02T02:00:00Z", PRICING);
    const usd = (r: typeof none) => ofType(r.events, "attempt.finished")[0]?.data.usd ?? 0;
    assert.ok(usd(none) > 0);
    assert.notEqual(usd(none), usd(withTable));
    assert.equal(ofType(none.events, "attempt.charged").every((c) => c.data.offPeakUsd === undefined), true);
  });
});

describe("the fleet and the settings a model family ignores", () => {
  it("sends no temperature to a model the host says ignores it while thinking, and says so on the attempt", async () => {
    const models = { "faux/prover": { ignores: { thinking: ["temperature"] } } };
    const { events } = await demoRun({
      registry: pricedRegistry(models),
      config: { lines: ["M1", "fleet"], sessions: 1, lineOptions: { fleet: { seed: 3, epsilon: 0, temperature: [0.3, 0.9], thinking: ["high"] } } as never },
      responses: [check("exact trivial_proof")],
    });
    const settings = ofType(events, "attempt.started")[0]?.data.settings;
    assert.equal(settings?.thinking, "high");
    assert.equal(settings?.temperature, undefined);
    assert.deepEqual(settings?.ignored, ["temperature"]);
  });

  it("samples the temperature as before when the host says nothing", async () => {
    const { events } = await demoRun({
      config: { lines: ["M1", "fleet"], sessions: 1, lineOptions: { fleet: { seed: 3, epsilon: 0, temperature: [0.3, 0.9], thinking: ["high"] } } as never },
      responses: [check("exact trivial_proof")],
    });
    const settings = ofType(events, "attempt.started")[0]?.data.settings;
    assert.ok(settings?.temperature === 0.3 || settings?.temperature === 0.9);
  });
});

describe("a model that no price covers", () => {
  it("is refused when a dollar cap is given on purpose, since the cap could never fire", async () => {
    await assert.rejects(
      demoRun({ responses: [], pricePerMillion: 0, config: { budget: { problemUsd: 5, runUsd: 10 } } }),
      (error: unknown) => error instanceof RunSetupError && /no price in host test or in pi-ai, so it would be charged \$0/.test(error.message),
    );
  });

  it("is said in the log and in the report when no dollar cap was asked for, and a priced one is not", async () => {
    const lines: string[] = [];
    const free = await demoRun({ responses: [check("exact trivial_proof")], pricePerMillion: 0, log: (line) => lines.push(line) });
    assert.ok(lines.some((line) => /warning: faux\/prover has no price/.test(line)));
    const report = buildReport(free.events);
    assert.ok((report.priceGaps?.unpricedResponses ?? 0) > 0);
    assert.match(renderRunReport(report), /Warning: \d+ model response\(s\) .* were charged \$0/);
    const tabled = await demoRun({ responses: [check("exact trivial_proof")], pricePerMillion: 0, registry: pricedRegistry({ "faux/prover": { pricing: PRICING } }), config: { budget: { problemUsd: 5, runUsd: 10 } } });
    assert.equal(buildReport(tabled.events).priceGaps, undefined, "a table prices it");
  });

  it("charges the table and records what pi-ai reported above it", () => {
    const model = { provider: "p", id: "m", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } as unknown as Model<"openai-completions">;
    const message = { usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } } as unknown as AssistantMessage;
    const cost = messageCost(model, message, new PriceBook({ "p/m": { pricing: { cacheHit: 0, cacheMiss: 1, output: 1 } } }, () => 0));
    assert.ok(Math.abs(cost.usd - 0.002) < 1e-12, "the table is the price");
    assert.ok(Math.abs((cost.unchargedUsd ?? 0) - 0.498) < 1e-12);
  });
});

describe("correcting a price while a run is interrupted", () => {
  it("does not make the run unresumable: the resumption warns and charges the new prices from then on", async () => {
    const withPrice = (cacheMiss: number) => pricedRegistry({ "faux/prover": { pricing: { cacheHit: 0.1, cacheMiss, output: 8 } } });
    const first = await demoRun({ responses: [check("bad"), check("exact trivial_proof")], registry: withPrice(2), config: { sessions: 2 } });
    assert.equal(typeof (first.events[0]?.data as { config: { prices?: unknown } }).config.prices, "string", "the run records its prices' hash");
    const dir = killedAt(first.dir, (event) => event.type === "attempt.charged");
    const lines: string[] = [];
    const resumed = await demoResume({ dir, bench: first.bench, responses: [check("exact trivial_proof")], registry: withPrice(4), log: (line) => lines.push(line) });
    assert.ok(lines.some((line) => /warning: the host's prices are not the ones this run began with \(they were changed\)/.test(line)), lines.join("\n"));
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
  });
});
