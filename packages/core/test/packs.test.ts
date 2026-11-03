import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVENT_TYPES, Journal } from "../src/index.ts";

const HASH = "ab".repeat(32);
const installed = (over: Record<string, unknown> = {}) => ({
  name: "adder",
  version: "1.0.0",
  hash: HASH,
  trust: "computed" as const,
  capabilities: ["math.padd"],
  skills: [],
  programs: [],
  source: "/somewhere",
  ...over,
});

describe("the pack events", () => {
  it("are known events that the orchestrator writes and that touch no claim", () => {
    assert.ok(EVENT_TYPES.includes("pack.installed"));
    assert.ok(EVENT_TYPES.includes("pack.removed"));
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-packs-")), "packs");
    try {
      journal.emit("pack.installed", installed(), "orchestrator");
      journal.emit("pack.removed", { name: "adder", version: "1.0.0", hash: HASH }, "orchestrator");
      assert.deepEqual(journal.projection.claimsWhere(), []);
    } finally {
      journal.close();
    }
  });

  it("are refused from any other actor, and when malformed", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-packs-")), "packs");
    try {
      assert.throws(() => journal.emit("pack.installed", installed(), "math.padd"), /written by the orchestrator only/);
      assert.throws(() => journal.emit("pack.installed", installed(), "human:ada"), /written by the orchestrator only/);
      assert.throws(() => journal.emit("pack.installed", installed({ name: "Bad Name" }), "orchestrator"), /bad pack name/);
      assert.throws(() => journal.emit("pack.installed", installed({ version: "" }), "orchestrator"), /needs a version/);
      assert.throws(() => journal.emit("pack.installed", installed({ hash: "abc" }), "orchestrator"), /sha256/);
      assert.throws(() => journal.emit("pack.removed", { name: "adder", version: "1", hash: "x" }, "orchestrator"), /sha256/);
    } finally {
      journal.close();
    }
  });
});
