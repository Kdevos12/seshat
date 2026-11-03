import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PricingCalendar } from "@seshat/registry";
import { buildReport, renderRunReport, RunSetupError } from "../src/index.ts";
import { check, demoResume, demoRun, killedAt, ofType, pricedRegistry } from "./m0-helpers.ts";
import { consortium } from "./turns-helpers.ts";

// Made-up numbers: peak 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays, half price otherwise. 2026-11-02 is a Monday.
const CALENDAR: PricingCalendar = {
  peak: [
    { days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" },
    { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" },
  ],
  offPeakMultiplier: 0.5,
};
const PRICING = { cacheHit: 0.1, cacheMiss: 2, output: 8 };
const at = (iso: string) => Date.parse(iso);
const priced = pricedRegistry({ "faux/prover": { pricing: { ...PRICING, calendar: CALENDAR } } });

/** A clock that the waits advance, as a real one would. */
function clock(start: string) {
  let now = at(start);
  const slept: number[] = [];
  return {
    wallClock: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    now: () => now,
  };
}

describe("the off-peak option", () => {
  it("is refused when the host gives the model no pricing table, with a message", async () => {
    const c = clock("2026-11-02T02:00:00Z");
    await assert.rejects(
      demoRun({ responses: [], config: { offpeak: {} }, wallClock: c.wallClock, sleep: c.sleep }),
      (error: unknown) => error instanceof RunSetupError && /--offpeak needs the host's pricing calendar for faux\/prover: host test gives it no pricing table/.test(error.message),
    );
    await assert.rejects(
      demoRun({ responses: [], config: { offpeak: {} }, registry: pricedRegistry({ "faux/prover": { pricing: PRICING } }) }),
      /a pricing table without a calendar/,
    );
  });

  it("defers a turn started at a peak instant to the next off-peak window, and the run is charged at the off-peak rate", async () => {
    const c = clock("2026-11-02T02:10:00Z");
    const { events } = await demoRun({
      responses: [check("exact trivial_proof")],
      registry: priced,
      config: { offpeak: {}, consortium: consortium({ usd: 100 }) },
      wallClock: c.wallClock,
      sleep: c.sleep,
    });
    const [deferred] = ofType(events, "turn.deferred").map((e) => e.data);
    assert.equal(deferred?.scope, "turn");
    assert.equal(deferred?.turn, 1);
    assert.equal(deferred?.from, "2026-11-02T02:10:00.000Z");
    assert.equal(deferred?.nextStart, "2026-11-02T04:00:00.000Z");
    assert.equal(deferred?.until, "2026-11-02T04:00:00.000Z");
    assert.equal(deferred?.bounded, false);
    assert.deepEqual(c.slept, [110 * 60_000], "one wait, of the minutes to 04:00");
    // The wait came before the turn began.
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf("turn.deferred") < types.indexOf("turn.started"));
    const charge = ofType(events, "attempt.charged")[0]?.data;
    assert.ok((charge?.usd ?? 0) > 0);
    assert.equal(charge?.offPeakUsd, charge?.usd, "charged at the off-peak rate");
    const report = buildReport(events);
    assert.equal(report.offPeak?.deferred, 1);
    assert.equal(report.offPeak?.ranAnyway, 0);
    assert.equal(report.offPeak?.waitedMinutes, 110);
    assert.ok(Math.abs((report.offPeak?.share ?? 0) - 1) < 1e-9);
    assert.match(renderRunReport(report), /Off-peak: \$[\d.]+ of the run's dollars \(100%\) were charged at the off-peak rate\. The run waited 1 time\(s\) for off-peak hours, 110 minutes in all/);
  });

  it("waits no longer than --offpeak-max-wait, then runs at the peak price", async () => {
    const c = clock("2026-11-02T02:10:00Z");
    const { events } = await demoRun({
      responses: [check("bad"), check("exact trivial_proof")],
      registry: priced,
      config: { offpeak: { maxWaitMinutes: 30 }, sessions: 2 },
      wallClock: c.wallClock,
      sleep: c.sleep,
    });
    const deferred = ofType(events, "turn.deferred").map((e) => e.data);
    assert.equal(deferred.length, 1, "the second session does not wait again for the same peak");
    assert.equal(deferred[0]?.scope, "session");
    assert.equal(deferred[0]?.prover, "p1");
    assert.equal(deferred[0]?.bounded, true);
    assert.equal(deferred[0]?.until, "2026-11-02T02:40:00.000Z");
    assert.equal(deferred[0]?.nextStart, "2026-11-02T04:00:00.000Z");
    assert.deepEqual(c.slept, [30 * 60_000]);
    for (const charge of ofType(events, "attempt.charged")) assert.equal(charge.data.offPeakUsd, undefined, "peak price");
    const report = buildReport(events);
    assert.equal(report.offPeak?.ranAnyway, 1);
    assert.equal(report.offPeak?.usd, 0);
  });

  it("does not wait at an off-peak instant, and a run without the option never does", async () => {
    const off = clock("2026-11-02T12:00:00Z");
    const a = await demoRun({ responses: [check("exact trivial_proof")], registry: priced, config: { offpeak: {} }, wallClock: off.wallClock, sleep: off.sleep });
    assert.equal(ofType(a.events, "turn.deferred").length, 0);
    assert.deepEqual(off.slept, []);
    const peak = clock("2026-11-02T02:10:00Z");
    const b = await demoRun({ responses: [check("exact trivial_proof")], registry: priced, wallClock: peak.wallClock, sleep: peak.sleep });
    assert.equal(ofType(b.events, "turn.deferred").length, 0);
    assert.deepEqual(peak.slept, []);
    assert.equal(b.events.find((e) => e.type === "run.started")?.type, "run.started");
    assert.equal((b.events[0]?.data as { config: Record<string, unknown> }).config.offpeak, undefined, "recorded only when given");
  });

  it("records the option in the run's configuration", async () => {
    const c = clock("2026-11-02T12:00:00Z");
    const { events } = await demoRun({ responses: [check("exact trivial_proof")], registry: priced, config: { offpeak: { maxWaitMinutes: 45 } }, wallClock: c.wallClock, sleep: c.sleep });
    assert.deepEqual((events[0]?.data as { config: Record<string, unknown> }).config.offpeak, { maxWaitMinutes: 45 });
  });

  it("is kept by a resumed run, which waits for the window again", async () => {
    const first = clock("2026-11-02T12:00:00Z");
    const done = await demoRun({ responses: [check("bad"), check("exact trivial_proof")], registry: priced, config: { offpeak: {}, sessions: 2 }, wallClock: first.wallClock, sleep: first.sleep });
    const dir = killedAt(done.dir, (event) => event.type === "attempt.started");
    const second = clock("2026-11-02T02:10:00Z");
    const resumed = await demoResume({ dir, bench: done.bench, responses: [check("exact trivial_proof")], registry: priced, wallClock: second.wallClock, sleep: second.sleep });
    assert.ok(ofType(resumed.events, "turn.deferred").length >= 1);
    assert.equal(second.slept[0], 110 * 60_000);
  });
});
