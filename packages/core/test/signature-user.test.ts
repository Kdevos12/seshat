import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVENT_TYPES, Journal, readEvents, verifyChain } from "../src/index.ts";

const signed = (over: Record<string, unknown> = {}) => ({
  source: "prose" as const,
  prose: "Adding zero changes nothing.",
  statement: "(n : ℕ) : n + 0 = n",
  statementId: "stmt_abc",
  problemId: "Problem.lean#solve_target",
  model: "faux/prover",
  formalization: { requestHash: "a".repeat(64), responseHash: "b".repeat(64), usd: 0.01, inputTokens: 100, outputTokens: 20 },
  ...over,
});

describe("statement.signed", () => {
  it("is a known event that a person writes and that touches no claim", () => {
    assert.ok(EVENT_TYPES.includes("statement.signed"));
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-sign-")), "sign");
    try {
      journal.emit("statement.signed", signed(), "human:ada");
      assert.deepEqual(journal.projection.claimsWhere(), []);
    } finally {
      journal.close();
    }
  });

  it("is refused from anything but a person, and when it names no statement", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-sign-")), "sign");
    try {
      assert.throws(() => journal.emit("statement.signed", signed(), "orchestrator"), /a person's signature, written by human:NAME/);
      assert.throws(() => journal.emit("statement.signed", signed(), "line:M8"), /a person's signature/);
      assert.throws(() => journal.emit("statement.signed", signed({ statement: "" }), "human:ada"), /names the statement/);
      assert.throws(() => journal.emit("statement.signed", signed({ prose: undefined }), "human:ada"), /prose statement/);
      assert.throws(() => journal.emit("statement.signed", signed({ source: "oracle" }), "human:ada"), /source/);
    } finally {
      journal.close();
    }
  });
});

describe("the optional user of an event", () => {
  it("is stamped on every event of a journal opened for a person, and the chain still verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-user-"));
    const journal = Journal.open(dir, "user", { user: "ada" });
    journal.emit("pack.removed", { name: "adder", version: "1", hash: "ab".repeat(32) }, "orchestrator");
    journal.emit("statement.signed", signed(), "human:ada", { user: "grace" });
    journal.close();
    const events = readEvents(join(dir, "journal.jsonl"));
    assert.deepEqual(events.map((e) => e.user), ["ada", "grace"], "an event may name another user than the journal's");
    assert.deepEqual(verifyChain(events), { ok: true });
  });

  it("is absent when nobody is named, so that a journal without it is byte for byte what it always was", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-user-"));
    const journal = Journal.open(dir, "user");
    journal.emit("pack.removed", { name: "adder", version: "1", hash: "ab".repeat(32) }, "orchestrator");
    journal.close();
    const [event] = readEvents(join(dir, "journal.jsonl"));
    assert.ok(event !== undefined && !("user" in event));
  });

  it("is a non-empty text of letters, digits and . _ - only", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-user-"));
    assert.throws(() => Journal.open(dir, "user", { user: "" }), /user/);
    assert.throws(() => Journal.open(dir, "user", { user: "a b\nc" }), /user/);
  });
});
