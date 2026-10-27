import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HealthEntry } from "@seshat/registry";
import { renderHealth } from "../src/health.ts";

const entry = (capability: string, ok: boolean, extra: Partial<HealthEntry> = {}): HealthEntry => ({
  capability,
  implementation: "impl",
  version: "1",
  ok,
  detail: ok ? "fine" : "no answer",
  durationMs: 12,
  ...extra,
});

describe("the report of harness health", () => {
  it("is ok for what answers, and succeeds when everything does", () => {
    const { lines, code } = renderHealth([entry("lean.check", true), entry("compute.sage", true)], "local");
    assert.deepEqual(lines, ["ok   lean.check/impl 1 (12 ms): fine", "ok   compute.sage/impl 1 (12 ms): fine"]);
    assert.equal(code, 0);
  });

  it("is FAIL for a required implementation that does not answer, and fails", () => {
    const { lines, code } = renderHealth([entry("lean.check", false), entry("compute.sage", true)], "local");
    assert.deepEqual(lines, ["FAIL lean.check/impl 1 (12 ms): no answer", "ok   compute.sage/impl 1 (12 ms): fine"]);
    assert.equal(code, 1);
  });

  it("is a warning for an optional implementation that does not answer, and still succeeds", () => {
    const { lines, code } = renderHealth([entry("lean.check", true), entry("oeis.search", false, { optional: true }), entry("lmfdb.query", true, { optional: true })], "local");
    assert.deepEqual(lines, ["ok   lean.check/impl 1 (12 ms): fine", "warn oeis.search/impl 1 (12 ms): no answer", "ok   lmfdb.query/impl 1 (12 ms): fine"]);
    assert.equal(code, 0);
  });

  it("fails when a required implementation is down next to an optional one", () => {
    const { lines, code } = renderHealth([entry("oeis.search", false, { optional: true }), entry("lean.check", false)], "local");
    assert.deepEqual(lines, ["warn oeis.search/impl 1 (12 ms): no answer", "FAIL lean.check/impl 1 (12 ms): no answer"]);
    assert.equal(code, 1);
  });

  it("says so when the host offers nothing", () => {
    assert.deepEqual(renderHealth([], "nowhere"), { lines: ["host nowhere offers no capability"], code: 0 });
  });
});
