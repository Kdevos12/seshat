import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVENT_TYPES, Journal, Projection, readEvents } from "../src/index.ts";

const spent = { usd: 0, inputTokens: 0, outputTokens: 0 };
const started = (turn: number) => ({ runId: "run_1", turn, limit: { tokens: 1000 }, source: "the run's option", startSpend: spent });
const ended = (turn: number, reason = "tokens") => ({
  runId: "run_1",
  turn,
  reason,
  detail: "a limit",
  spent: { turn: spent, run: spent },
  minutes: 0,
  waiting: [],
});

describe("the events of a consortium run's turns", () => {
  it("are known events, and the projection counts the turns that began and ended", () => {
    assert.ok(EVENT_TYPES.includes("turn.started"));
    assert.ok(EVENT_TYPES.includes("turn.ended"));
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-turns-")), "run_1");
    assert.deepEqual(journal.projection.turns(), { started: 0, ended: 0 });
    journal.emit("turn.started", started(1), "orchestrator");
    assert.deepEqual(journal.projection.turns(), { started: 1, ended: 0 });
    journal.emit("turn.ended", ended(1), "orchestrator");
    journal.emit("turn.started", started(2), "orchestrator");
    assert.deepEqual(journal.projection.turns(), { started: 2, ended: 1 });
    journal.close();
  });

  it("are the orchestrator's, in order, one open turn at a time", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-turns-")), "run_1");
    assert.throws(() => journal.emit("turn.started", started(1), "line:M1"), /written by the orchestrator only/);
    assert.throws(() => journal.emit("turn.ended", ended(1), "orchestrator"), /no turn is open/);
    assert.throws(() => journal.emit("turn.started", started(2), "orchestrator"), /this is turn 1 of the run, not 2/);
    journal.emit("turn.started", started(1), "orchestrator");
    assert.throws(() => journal.emit("turn.started", started(2), "orchestrator"), /turn 1 has not ended/);
    assert.throws(() => journal.emit("turn.ended", ended(2), "orchestrator"), /turn 1 is the one that is open, not 2/);
    assert.throws(() => journal.emit("turn.ended", ended(1, ""), "orchestrator"), /ends for a reason/);
    assert.throws(() => journal.emit("turn.ended", ended(1), "human:alice"), /written by the orchestrator only/);
    journal.emit("turn.ended", ended(1), "orchestrator");
    assert.throws(() => journal.emit("turn.ended", ended(1), "orchestrator"), /no turn is open/);
    journal.close();
  });

  it("refuse a limit that is not a positive number", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-turns-")), "run_1");
    for (const limit of [{ tokens: 0 }, { usd: -1 }, { minutes: Number.NaN }]) {
      assert.throws(() => journal.emit("turn.started", { ...started(1), limit }, "orchestrator"), /must be a positive number/);
    }
    journal.emit("turn.started", { ...started(1), limit: {} }, "orchestrator");
    journal.close();
  });

  it("are rebuilt from the journal by a projection that starts again", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-turns-"));
    const journal = Journal.open(dir, "run_1");
    journal.emit("turn.started", started(1), "orchestrator");
    journal.emit("turn.ended", ended(1), "orchestrator");
    journal.emit("turn.started", started(2), "orchestrator");
    journal.close();
    const replay = Projection.inMemory();
    for (const event of readEvents(join(dir, "journal.jsonl"))) replay.apply(event);
    assert.deepEqual(replay.turns(), { started: 2, ended: 1 });
    replay.close();
  });
});

describe("the research team's nodes", () => {
  it("are written by a person only: no line or model can speak in the team's name", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-turns-")), "run_1");
    journal.emit("claim.created", { claimId: "clm_1", statementId: "s", statement: ": P", origin: "test", status: "open" }, "memory");
    for (const kind of ["hint", "steer"]) {
      for (const actor of ["line:M4", "prover:p1", "orchestrator", "memory"]) {
        assert.throws(
          () => journal.emit("node.recorded", { nodeId: `nod_${kind}_${actor}`, kind, claimId: "clm_1", data: { provenance: "human", by: "alice", text: "x" } }, actor),
          /is the research team's, written by human:NAME/,
        );
      }
      journal.emit("node.recorded", { nodeId: `nod_${kind}`, kind, claimId: "clm_1", data: { provenance: "human", by: "alice", text: "x" } }, "human:alice");
    }
    journal.emit("node.recorded", { nodeId: "nod_other", kind: "lemma", claimId: "clm_1", data: {} }, "line:M4");
    journal.close();
  });
});
