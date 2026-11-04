import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRuns, JournalTail, plainStatus, readRun, RunReadError, runDirectory } from "../src/index.ts";
import { scriptedJournal } from "../../orchestrator/test/scripted-journal.ts";
import { tempDir } from "../../orchestrator/test/m0-helpers.ts";

describe("the journal reader", () => {
  it("gives the projection of a recorded journal as JSON: statuses, graph, turns, spend and proof", () => {
    const s = scriptedJournal();
    s.journal.close();
    const view = readRun(s.dir);
    assert.equal(JSON.parse(JSON.stringify(view)).version, 1, "it is plain JSON");
    assert.equal(view.state, "paused");
    assert.equal(view.stop?.reason, "impasse");
    assert.equal(view.journal.chain, "verified");
    const byId = new Map(view.claims.map((c) => [c.id, c]));
    assert.equal(byId.get(s.claims.proved)?.status, "proved");
    assert.equal(byId.get(s.claims.refuted)?.status, "refuted");
    assert.equal(byId.get(s.claims.computed)?.status, "computed");
    assert.equal(byId.get(s.claims.proved)?.parent, s.claims.root);
    assert.deepEqual(view.claimCounts, { open: 3, proved: 1, computed: 1, refuted: 1 });
    assert.ok(view.edges.some((e) => e.id === s.edges.implies || e.id === s.edges.decomposes));
    assert.ok(view.turns.length >= 1);
    assert.equal(view.turns[0]?.end?.reason, "impasse");
    assert.ok(view.turns[0]?.account !== null, "the account of the turn is built");
    assert.ok(view.spend.sites.length > 0, "spend by site");
    assert.equal(view.proof.certified.length, 2);
    assert.deepEqual(view.proof.candidates.map((c) => c.claimId), [s.claims.computed]);
    assert.match(view.resultMd, /Lean proofs certified so far/);
    assert.equal(view.resume.startsWith("pnpm harness resume"), true);
  });

  it("never shows evidence or a candidate as a proof in the plain-language status", () => {
    const s = scriptedJournal();
    s.journal.close();
    const view = readRun(s.dir);
    const levels = Object.fromEntries(view.status.map((x) => [x.target, x.level]));
    assert.equal(levels["odd_prime"], "refuted");
    assert.notEqual(levels["goldbach"], "proved");
    assert.ok(view.evidence.length > 0, "the evidence is listed apart");
    assert.equal(plainStatus({ problemId: "p", target: "t", claimId: "c", claimStatus: "computed", certified: false }, true, "cut").level, "candidate");
    assert.doesNotMatch(plainStatus({ problemId: "p", target: "t", claimId: "c", claimStatus: "open", certified: false }, true, "cut").text, /^Proved/);
    // A claim marked proved without a valid kernel replay of it in the journal is not shown as proved.
    assert.notEqual(plainStatus({ problemId: "p", target: "t", claimId: "c", claimStatus: "proved", certified: false }, false, "cut").level, "proved");
  });

  it("lists run directories, and refuses ids that leave the runs directory", () => {
    const runs = tempDir("ui-runs-");
    assert.deepEqual(listRuns(runs), []);
    const s = scriptedJournal();
    s.journal.close();
    mkdirSync(join(runs, "one"));
    writeFileSync(join(runs, "one", "journal.jsonl"), "");
    mkdirSync(join(runs, "_inputs"));
    mkdirSync(join(runs, "empty"));
    assert.deepEqual(listRuns(runs).map((r) => r.id), ["one"]);
    assert.equal(runDirectory(runs, "one") !== undefined, true);
    for (const bad of ["..", "../x", "a/b", "", ".hidden", "empty", "one/../one", "a\0b"]) assert.equal(runDirectory(runs, bad), undefined, bad);
    assert.throws(() => readRun(join(runs, "empty")), RunReadError);
    assert.throws(() => readRun(join(runs, "one")), RunReadError, "an empty journal is not a started run");
  });

  it("says plainly when the hash chain does not verify", () => {
    const s = scriptedJournal();
    s.journal.close();
    const path = join(s.dir, "journal.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("Part B", "Part X"));
    const view = readRun(s.dir);
    assert.notEqual(view.journal.chain, "verified");
    assert.match(view.journal.chain, /hash|seq/);
  });

  it("follows a journal as it grows and waits for a half-written line", () => {
    const dir = tempDir("ui-tail-");
    const path = join(dir, "journal.jsonl");
    writeFileSync(path, "");
    const tail = new JournalTail(path);
    assert.deepEqual(tail.poll(), []);
    const line = (seq: number, type: string) => JSON.stringify({ seq, type, actor: "orchestrator", ts: "2026-01-01T00:00:00Z", data: { secret: "not announced" } });
    appendFileSync(path, `${line(0, "run.started")}\n${line(1, "turn.started").slice(0, 20)}`);
    assert.deepEqual(tail.poll().map((e) => e.type), ["run.started"]);
    appendFileSync(path, `${line(1, "turn.started").slice(20)}\n`);
    const next = tail.poll();
    assert.deepEqual(next.map((e) => [e.seq, e.type]), [[1, "turn.started"]]);
    assert.equal(JSON.stringify(next).includes("secret"), false, "an announcement never carries the event's data");
    assert.deepEqual(tail.poll(), []);
  });
});
