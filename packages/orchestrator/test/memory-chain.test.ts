import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BenchIndex } from "@seshat/bench";
import { BlobStore, environmentId, isProvenance, Journal, loadMemoryChain, readEvents } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import { PROMPT_VERSION, renderRunReport, RunSetupError } from "../src/index.ts";
import { certifier, nth } from "./resume-helpers.ts";
import { check, demoBench, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";

const ENV_A = { rev: "rev-a", lean: "leanprover/lean4:v4.20.0" };
const ENV_B = { rev: "rev-b", lean: "leanprover/lean4:v4.20.0" };

/** The demo bench as a checkout of the revision and toolchain given, so that its environment can be compared. */
function benchIn(source: Partial<BenchIndex["source"]>, shared = demoBench()): { checkout: string; index: BenchIndex } {
  return { checkout: shared.checkout, index: { ...shared.index, source: { ...shared.index.source, ...source } } };
}

/** Every file of a directory with its bytes: what a run that only reads it must leave as it was. */
function snapshot(dir: string): Array<[string, string, number]> {
  return readdirSync(dir, { recursive: true }).map(String).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return [name, stat.isFile() ? readFileSync(join(dir, name), "utf8") : "dir", stat.mtimeMs];
  });
}

/** An earlier run that proved the demo problem, certified. */
async function proved(source = ENV_A, shared = demoBench()) {
  const bench = benchIn(source, shared);
  const run = await demoRun({ bench, certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
  assert.equal(run.result.problems[0]?.outcome, "proved");
  return { ...run, bench };
}

/** A journal that holds only the start of a run, made by a model, a prompt version and a revision. */
function crafted(model: string, promptVersion: string, rev: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mh-chain-craft-")), "run");
  const journal = Journal.open(dir, "run_old");
  journal.emit(
    "run.started",
    { runId: "run_old", benchId: "demo-bench", problems: 1, host: "test", config: { model, prompt: { version: promptVersion }, bench: { source: { rev, lean: ENV_A.lean } } } },
    "orchestrator",
  );
  journal.emit("run.finished", { runId: "run_old", attempted: 0, solved: 0, refuted: 0, candidates: 0, usd: 0 }, "orchestrator");
  journal.close();
  return dir;
}

describe("a run started on an earlier run's memory (--memory-from)", () => {
  it("sees the claims and attempts of the earlier run, shares its claim, and leaves it as it was", async () => {
    const a = await proved();
    const claimId = ofType(a.events, "claim.created")[0]?.data.claimId;
    const before = snapshot(a.dir);
    const said: string[] = [];
    const b = await demoRun({
      bench: a.bench, memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 }, log: (line) => said.push(line),
    });

    const last = a.events.at(-1);
    const started = ofType(b.events, "run.started")[0]?.data;
    assert.deepEqual(started?.memoryFrom, { path: a.dir, runId: a.result.runId, lastHash: last?.hash, events: a.events.length });
    assert.equal(b.events[0]?.seq, 0, "the run's own events are numbered from 0");
    assert.deepEqual(ofType(b.events, "claim.created"), [], "the claim of the earlier run is the problem's claim");
    assert.equal(ofType(b.events, "problem.registered")[0]?.data.claimId, claimId);
    assert.ok(said.some((line) => /^memory from run .*1 claim\(s\), 1 attempt\(s\).*the same Lean environment: verified statuses carry \(1 proved\)/.test(line)), said.join("\n"));
    assert.deepEqual(snapshot(a.dir), before, "nothing writes the earlier run");

    // The earlier run's facts and records are the memory of the new one.
    const journal = Journal.open(b.dir, b.result.runId);
    try {
      const p = journal.projection;
      assert.equal(p.claim(claimId as string)?.status, "proved");
      assert.equal(p.attempts(claimId as string).length, 2, "the earlier run's attempt and this run's");
      assert.equal(journal.chain?.segments.length, 1);
    } finally {
      journal.close();
    }
  });

  it("credits no problem outcome to the earlier run: the problem is proved only by its own certification", async () => {
    const a = await proved();
    const b = await demoRun({ bench: a.bench, memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 } });
    assert.equal(b.result.problems[0]?.outcome, "unsolved", "the claim carried proved and the problem did not");
    const finished = ofType(b.events, "run.finished")[0]?.data;
    assert.deepEqual([finished?.solved, finished?.refuted, finished?.candidates], [0, 0, 0]);
    assert.equal(b.result.report.outcomes.proved, undefined);
    // Its own certification counts.
    const c = await demoRun({ bench: a.bench, memoryFrom: a.dir, certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    assert.equal(c.result.problems[0]?.outcome, "proved");
    assert.equal(ofType(c.events, "run.finished")[0]?.data.solved, 1);
    assert.equal(ofType(c.events, "validation.finished").length, 2, "the proof was validated again in this run");
  });

  it("counts none of the earlier run's cost or attempts in the new run's report, and says what came from the memory", async () => {
    const a = await proved();
    const b = await demoRun({ bench: a.bench, memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 } });
    assert.equal(b.result.report.attempts.total, 1);
    assert.ok(b.result.usd < a.result.usd * 2 && b.result.report.usd === b.result.usd);
    const m = b.result.report.memory;
    assert.equal(m?.sameEnvironment, true);
    assert.equal(m?.journals, 1);
    assert.deepEqual(m?.taken?.carried, { proved: 1 });
    assert.deepEqual([m?.taken?.claims, m?.taken?.attempts, m?.taken?.reset], [1, 1, 0]);
    assert.equal(m?.from.runId, a.result.runId);
    const text = renderRunReport(b.result.report);
    assert.match(text, /Memory from the earlier run run_/);
    assert.match(text, /1 claim\(s\), 1 attempt\(s\)/);
    assert.match(text, /The same Lean environment: 2 validation\(s\) and the statuses of the claims carried \(1 proved\)/);
    assert.match(text, /never from the earlier memory/);
    assert.equal(readFileSync(join(b.dir, "report.json"), "utf8").includes("\"memory\""), true);
    // A run on nothing has no such section.
    assert.equal(a.result.report.memory, undefined);
    assert.doesNotMatch(renderRunReport(a.result.report), /Memory from/);
  });

  it("holds a claim proved earlier as open under another environment, until a stored proof validates again", async () => {
    const shared = demoBench();
    const a = await proved(ENV_A, shared);
    const claimId = ofType(a.events, "claim.created")[0]?.data.claimId as string;
    const bench = benchIn(ENV_B, shared);
    const said: string[] = [];
    const b = await demoRun({ bench, memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 }, log: (line) => said.push(line) });
    assert.ok(said.some((line) => /another Lean environment: 1 earlier status\(es\)/.test(line)), said.join("\n"));
    assert.equal(b.result.problems[0]?.outcome, "unsolved");
    const m = b.result.report.memory;
    assert.equal(m?.sameEnvironment, false);
    assert.deepEqual([m?.taken?.carried, m?.taken?.reset, m?.taken?.validations], [{}, 1, { carried: 0, notCarried: 2 }]);
    assert.match(renderRunReport(b.result.report), /Another Lean environment for 2 validation\(s\): 1 claim status\(es\)/);

    // The earlier proof is stored, readable, and a candidate for validate: nothing more.
    const chain = loadMemoryChain(a.dir, environmentId(bench.index.source));
    const journal = Journal.open(b.dir, b.result.runId);
    try {
      assert.equal(journal.projection.claim(claimId)?.status, "open");
      assert.equal(journal.projection.claim(claimId)?.earlier_status, "proved");
      const memory = new MemoryStore({ journal, blobs: new BlobStore(join(b.dir, "blobs"), chain.blobDirs) });
      assert.equal(memory.claim(claimId)?.earlierStatus, "proved");
      assert.equal(memory.claim(claimId)?.status, "open");
      assert.deepEqual(memory.validations(claimId), []);
      const stored = memory.storedProofs(claimId);
      assert.deepEqual(stored.map((s) => [s.method, s.verdict]), [["repl", "valid"], ["kernel_replay", "valid"]]);
      assert.match(stored[0]?.text ?? "", /exact trivial_proof/);
    } finally {
      journal.close();
    }

    // Submitted again, it passes validate and the certifier here, and the claim is proved by this run.
    const c = await demoRun({ bench, memoryFrom: a.dir, certifier: certifier().certifier, responses: [check("exact trivial_proof")] });
    assert.equal(c.result.problems[0]?.outcome, "proved");
    assert.deepEqual(ofType(c.events, "claim.status_changed").map((e) => [e.data.claimId, e.data.from, e.data.to]), [[claimId, "open", "computed"], [claimId, "computed", "proved"]]);
    assert.equal(ofType(c.events, "run.finished")[0]?.data.solved, 1);
  });

  it("carries nothing when the bench's revision is unknown, since no environment can be compared", async () => {
    const a = await demoRun({ responses: [check("exact trivial_proof")], certifier: certifier().certifier });
    assert.equal(a.result.problems[0]?.outcome, "proved");
    const b = await demoRun({ bench: a.bench, memoryFrom: a.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1 } });
    assert.equal(b.result.report.memory?.sameEnvironment, false);
    assert.equal(b.result.report.memory?.taken?.reset, 1);
  });

  it("refuses an earlier run that is not there, and leaves no directory behind", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mh-chain-none-")), "run");
    await assert.rejects(
      demoRun({ dir, memoryFrom: join(tmpdir(), "mh-chain-no-such-run"), responses: [] }),
      (error: unknown) => error instanceof RunSetupError && /cannot be used: .*holds no earlier run/.test(error.message),
    );
    assert.throws(() => readdirSync(dir), /ENOENT/);
  });

  it("goes on from its own journal when it is resumed, reading the same chain, and refuses a chain that changed", async () => {
    const a = await proved();
    const whole = await demoRun({ bench: a.bench, memoryFrom: a.dir, config: { sessions: 2 }, responses: [check("sorry"), say("notes"), check("sorry"), say("notes")] });
    const cut = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const resumed = await demoResume({ dir: cut, bench: a.bench, responses: [check("sorry"), say("notes")] });
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["unsolved"]);
    assert.equal(resumed.result.report.memory?.from.runId, a.result.runId);
    assert.equal(resumed.result.report.attempts.total, 2, "the earlier run's attempts are not this run's");
    assert.equal(ofType(resumed.events, "run.finished").at(-1)?.data.solved, 0);

    // The earlier run is written to after this one started on it: the journal pins it, and the resume is refused.
    const again = Journal.open(a.dir, a.result.runId);
    again.emit("claim.created", { claimId: "clm_late", statementId: "st0_late", statement: "(n : ℕ) : n = n", origin: "test", status: "open" }, "test");
    again.close();
    const cut2 = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    await assert.rejects(
      demoResume({ dir: cut2, bench: a.bench, responses: [] }),
      (error: unknown) => error instanceof RunSetupError && /not the one this run was started on/.test(error.message),
    );
  });
});

describe("memory across runs and the cached-token report", () => {
  it("counts the cache reads of this run's charges only, and stamps the attempts with the provenance", async () => {
    const script = [check("bad"), say("notes"), check("bad"), say("notes")];
    const a = await demoRun({ responses: script, config: { sessions: 2 }, codeRev: "rev-a" });
    assert.ok(a.result.report.cachedInputTokens > 0, "the faux provider caches the common prefix of a session");
    const b = await demoRun({ bench: a.bench, memoryFrom: a.dir, responses: script, config: { sessions: 2 }, codeRev: "rev-b" });
    const charged = ofType(b.events, "attempt.charged").reduce((n, e) => n + (e.data.cachedInputTokens ?? 0), 0);
    const finished = ofType(b.events, "attempt.finished").reduce((n, e) => n + (e.data.cachedInputTokens ?? 0), 0);
    assert.ok(charged > 0);
    assert.equal(b.result.report.cachedInputTokens, Math.max(charged, finished), "the report's max rule, over this run's events");
    assert.ok(b.result.report.cachedInputTokens < a.result.report.cachedInputTokens + charged, "nothing of the earlier run is added");
    for (const { data } of ofType(b.events, "attempt.started")) {
      assert.ok(isProvenance(data.provenance));
      assert.equal(data.provenance?.harnessVersion, "rev-b");
    }
    assert.equal(b.result.report.attempts.total, 2);
    assert.equal(b.result.report.memory?.taken?.attempts, 2, "the earlier attempts are memory");
  });
});

describe("the epochs a run on earlier memory opens", () => {
  const modelsAt = async (earlier: string) => {
    const shared = benchIn({ rev: "rev-a", lean: ENV_A.lean });
    return await demoRun({ bench: shared, memoryFrom: earlier, responses: [check("sorry"), say("notes")], config: { sessions: 1 }, codeRev: "rev-new" });
  };

  it("opens none when the model family, the prompts' major version and the Mathlib revision are the earlier run's", async () => {
    const run = await modelsAt(crafted("faux/prover", PROMPT_VERSION, "rev-a"));
    assert.deepEqual(ofType(run.events, "memory.epoch_opened"), []);
    assert.equal(ofType(run.events, "attempt.started")[0]?.data.provenance?.harnessVersion, "rev-new", "a new harness version is not a trigger");
  });

  it("opens an epoch on a change of model family, before the run's first attempt, stamped and by the orchestrator", async () => {
    const run = await modelsAt(crafted("prov/model-5", PROMPT_VERSION, "rev-a"));
    const opened = ofType(run.events, "memory.epoch_opened");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.actor, "orchestrator");
    assert.deepEqual(opened[0]?.data.changes, [{ field: "modelFamily", from: "prov/model-5", to: "faux/prover" }]);
    assert.equal(opened[0]?.data.epoch, 1);
    assert.ok(isProvenance(opened[0]?.data.provenance));
    assert.match(opened[0]?.data.reason ?? "", /the prover model family changed from prov\/model-5 to faux\/prover/);
    assert.ok(run.events.indexOf(opened[0] as never) < run.events.findIndex((e) => e.type === "attempt.started"));
    // The attempt is in the new epoch.
    const journal = Journal.open(run.dir, run.result.runId);
    try {
      assert.equal(journal.projection.currentEpoch(), 1);
      assert.equal(journal.projection.attempts(ofType(run.events, "problem.registered")[0]?.data.claimId as string)[0]?.epoch, 1);
    } finally {
      journal.close();
    }
  });

  it("opens an epoch on a change of the prompts' major version, and not on a minor one", async () => {
    const major = await modelsAt(crafted("faux/prover", "m0-1", "rev-a"));
    assert.deepEqual(ofType(major.events, "memory.epoch_opened").map((e) => e.data.changes), [[{ field: "promptMajor", from: "m0-1", to: PROMPT_VERSION }]]);
    const minor = await modelsAt(crafted("faux/prover", `${PROMPT_VERSION}.1`, "rev-a"));
    assert.deepEqual(ofType(minor.events, "memory.epoch_opened"), []);
  });

  it("opens an epoch on a change of the Mathlib revision, and one epoch for several changes together", async () => {
    const rev = await modelsAt(crafted("faux/prover", PROMPT_VERSION, "rev-old"));
    assert.deepEqual(ofType(rev.events, "memory.epoch_opened").map((e) => e.data.changes), [[{ field: "mathlibRev", from: "rev-old", to: "rev-a" }]]);
    const all = await modelsAt(crafted("prov/model-5", "m0-1", "rev-old"));
    const opened = ofType(all.events, "memory.epoch_opened");
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0]?.data.changes.map((c) => c.field), ["modelFamily", "promptMajor", "mathlibRev"]);
  });

  it("opens the next epoch after the ones the chain already opened", async () => {
    const first = await modelsAt(crafted("prov/model-5", PROMPT_VERSION, "rev-a"));
    assert.equal(ofType(first.events, "memory.epoch_opened")[0]?.data.epoch, 1);
    const second = await demoRun({
      bench: benchIn({ rev: "rev-a", lean: ENV_A.lean }), memoryFrom: first.dir, responses: [check("sorry"), say("notes")], config: { sessions: 1, model: "faux/prover" },
    });
    assert.deepEqual(ofType(second.events, "memory.epoch_opened"), [], "the same configuration as the run before goes on in its epoch");
    assert.equal(second.result.report.memory?.journals, 2);
    assert.equal(second.result.report.memory?.taken?.epochs, 1);
  });
});
