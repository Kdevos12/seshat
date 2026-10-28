import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BlobStore,
  environmentId,
  environmentOf,
  Journal,
  loadMemoryChain,
  MemoryChainError,
  type MemoryChain,
  Projection,
  readEvents,
  statementIdV0,
} from "../src/index.ts";

const ENV_A = { rev: "rev-a", lean: "leanprover/lean4:v4.20.0" };
const ENV_B = { rev: "rev-b", lean: "leanprover/lean4:v4.20.0" };
const STATEMENT = "(n : ℕ) : n + 0 = n";

function base(): string {
  return mkdtempSync(join(tmpdir(), "mh-chain-"));
}

type LeanEnv = { name: string; hash: string | null };

function config(source: { rev: string; lean: string }, model = "prov/model-5", leanEnv?: LeanEnv) {
  return { model, prompt: { version: "m0-2" }, bench: { hash: "h", source: { repo: "r", ...source } }, ...(leanEnv !== undefined ? { leanEnv } : {}) };
}

/** Starts a run in `dir` on the chain, if any, the way the orchestrator does. */
function start(dir: string, runId: string, source: typeof ENV_A, chain?: MemoryChain, leanEnv?: LeanEnv): Journal {
  const journal = Journal.open(dir, runId, chain !== undefined ? { memory: chain } : {});
  journal.emit(
    "run.started",
    { runId, benchId: "bench", problems: 1, host: "test", config: config(source, "prov/model-5", leanEnv), ...(chain !== undefined ? { memoryFrom: chain.from } : {}) },
    "orchestrator",
  );
  return journal;
}

function claim(journal: Journal, claimId: string): void {
  journal.emit("claim.created", { claimId, statementId: statementIdV0(STATEMENT), statement: STATEMENT, origin: "test", status: "open" }, "test");
}

function validate(journal: Journal, validationId: string, claimId: string, method: "repl" | "kernel_replay", o: { negation?: boolean; problemId?: string; submissionHash?: string } = {}): void {
  journal.emit(
    "validation.finished",
    {
      validationId, claimId, method, verdict: "valid", reasons: [], axioms: [], submissionHash: o.submissionHash ?? "0".repeat(64),
      ...(o.negation === true ? { negation: true } : {}), ...(o.problemId !== undefined ? { problemId: o.problemId } : {}),
    },
    method === "repl" ? "validator" : "certifier",
  );
}

/** Proves `claimId` the way a run does: a valid fast check, a candidate, a valid certification, proved. */
function prove(journal: Journal, claimId: string, tag: string, problemId?: string): void {
  validate(journal, `val_${tag}_fast`, claimId, "repl", problemId !== undefined ? { problemId } : {});
  journal.emit("claim.status_changed", { claimId, from: "open", to: "computed", reason: "fast check", validationId: `val_${tag}_fast` }, "orchestrator");
  validate(journal, `val_${tag}_cert`, claimId, "kernel_replay", problemId !== undefined ? { problemId } : {});
  journal.emit("claim.status_changed", { claimId, from: "computed", to: "proved", reason: "certified", validationId: `val_${tag}_cert` }, "orchestrator");
}

function attempt(journal: Journal, attemptId: string, claimId: string): void {
  journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: 1, model: "m" }, "prover:p1");
  journal.emit("attempt.finished", { attemptId, outcome: "valid", durationMs: 1, turns: 1, usd: 0.25, inputTokens: 10, outputTokens: 5 }, "prover:p1");
}

/** An earlier run in `dir`: a claim, an attempt with a tool run, a lesson, a node, proved when `proved`. */
function earlier(source: typeof ENV_A, proved = true, leanEnv?: LeanEnv): { dir: string; claimId: string } {
  const dir = join(base(), "run");
  const journal = start(dir, "run_a", source, undefined, leanEnv);
  claim(journal, "clm_a");
  attempt(journal, "att_a", "clm_a");
  journal.emit("tool_run.started", { toolRunId: "tr_a", capability: "lean.check", implementation: "demo", version: "0", inputHash: "i", attemptId: "att_a" }, "prover:p1");
  journal.emit("tool_run.finished", { toolRunId: "tr_a", outcome: "ok", durationMs: 1 }, "prover:p1");
  journal.emit("lesson.recorded", { attemptId: "att_a", claimId: "clm_a", text: "notes" }, "prover:p1");
  journal.emit("node.recorded", { nodeId: "nod_a", kind: "evidence", claimId: "clm_a", data: { note: "x" } }, "test");
  if (proved) prove(journal, "clm_a", "a");
  journal.emit("run.finished", { runId: "run_a", attempted: 1, solved: proved ? 1 : 0, refuted: 0, candidates: 0, usd: 0.25 }, "orchestrator");
  journal.close();
  return { dir, claimId: "clm_a" };
}

const environment = (source: typeof ENV_A, leanEnv?: LeanEnv) => environmentId(source, leanEnv);

describe("the environment of a run", () => {
  it("is the bench's revision and Lean toolchain when a run records no environment", () => {
    assert.equal(environment(ENV_A), "bench:rev-a|lean:leanprover/lean4:v4.20.0");
    assert.notEqual(environment(ENV_A), environment(ENV_B));
    assert.equal(environmentId(ENV_A, { hash: "abc" }), "env:abc");
    assert.equal(environmentOf(config(ENV_A)), environment(ENV_A));
  });

  it("is the Lean environment's hash when a run records one (Task 21), whatever the bench says", () => {
    assert.equal(environment(ENV_A, { name: "base", hash: "h1" }), "env:h1");
    assert.equal(environment(ENV_A, { name: "base", hash: "h1" }), environment(ENV_B, { name: "other", hash: "h1" }), "the hash is the identity, not the bench or the name");
    assert.notEqual(environment(ENV_A, { name: "base", hash: "h1" }), environment(ENV_A, { name: "extended", hash: "h2" }));
    assert.equal(environmentOf(config(ENV_A, "m", { name: "base", hash: "h1" })), "env:h1");
    assert.notEqual(environment(ENV_A, { name: "base", hash: "h1" }), environment(ENV_A), "a hash never equals the bench's id");
  });

  it("is none that can be compared when the recorded environment has no hash, or the revision or the toolchain is unknown", () => {
    assert.equal(environment(ENV_A, { name: "base", hash: null }), undefined, "a record without a hash is not the bench's id");
    assert.equal(environmentOf(config(ENV_A, "m", { name: "base", hash: null })), undefined);
    assert.equal(environmentId({ rev: "unknown", lean: "lean-1" }), undefined);
    assert.equal(environmentId({ rev: "rev-a", lean: "unknown" }), undefined);
    assert.equal(environmentId({}), undefined);
    assert.equal(environmentOf(null), undefined);
  });
});

describe("a run started on an earlier run's memory", () => {
  it("sees its claims, attempts, tool runs, lessons and nodes, and its verified statuses under the same environment", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    assert.equal(chain.segments.length, 1);
    assert.equal(chain.segments[0]?.carried, true);
    const dir = join(base(), "run");
    const journal = start(dir, "run_b", ENV_A, chain);
    const p = journal.projection;
    assert.equal(p.claim("clm_a")?.status, "proved", "a verified fact carries");
    assert.equal(p.claim("clm_a")?.earlier_status, null);
    assert.ok((p.claim("clm_a")?.created_seq ?? 0) < 0, "an inherited row is before the run's own seqs");
    assert.deepEqual(p.attempts("clm_a").map((x) => x.attempt_id), ["att_a"]);
    assert.equal(p.toolRuns("att_a").length, 1);
    assert.equal(p.lessons("clm_a").length, 1);
    assert.equal(p.nodes("evidence", "clm_a").length, 1);
    assert.deepEqual(p.validations("clm_a").map((v) => [v.validation_id, v.carried]), [["val_a_fast", true], ["val_a_cert", true]]);
    // The run's own events are numbered from 0, as in a run without a chain.
    assert.equal(readEvents(join(dir, "journal.jsonl"))[0]?.seq, 0);
    assert.equal(p.lastSeq(), 0);
    assert.deepEqual(p.memorySummary(), {
      claims: 1, carried: { proved: 1 }, reset: 0, attempts: 1, toolRuns: 1, lessons: 1, nodes: 1, edges: 0, edgesReset: 0,
      validations: { carried: 2, notCarried: 0 }, epochs: 0,
    });
    journal.close();
  });

  it("leaves the earlier run unchanged: its journal, its blobs and its directory", () => {
    const a = earlier(ENV_A);
    new BlobStore(join(a.dir, "blobs")).put("a proof");
    const snapshot = () => readdirSync(a.dir, { recursive: true }).sort().map((name) => {
      const path = join(a.dir, String(name));
      const stat = statSync(path);
      return [String(name), stat.isFile() ? readFileSync(path, "utf8") : "dir", stat.mtimeMs];
    });
    const before = snapshot();
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    const dir = join(base(), "run");
    const journal = start(dir, "run_b", ENV_A, chain);
    claim(journal, "clm_b");
    prove(journal, "clm_b", "b");
    journal.close();
    // Reopened: the projection is rebuilt or caught up from both journals, and still reads, never writes.
    Journal.open(dir, "run_b").close();
    assert.deepEqual(snapshot(), before);
  });

  it("pins the earlier journal by its last hash: a journal that ends otherwise is refused", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    const dir = join(base(), "run");
    start(dir, "run_b", ENV_A, chain).close();
    assert.equal(readEvents(join(dir, "journal.jsonl"))[0]?.type, "run.started");
    // Reopening finds the same journal.
    Journal.open(dir, "run_b").close();
    // The earlier run is written to after the new run started on it.
    const again = Journal.open(a.dir, "run_a");
    claim(again, "clm_later");
    again.close();
    assert.throws(() => Journal.open(dir, "run_b"), (error: unknown) => error instanceof MemoryChainError && /not the one this run was started on/.test(error.message));
    // Starting on it now pins the new end instead.
    const fresh = loadMemoryChain(a.dir, environment(ENV_A));
    assert.notEqual(fresh.from.lastHash, chain.from.lastHash);
  });

  it("refuses a journal whose hash chain is broken, one that is not a run, one still being written, and a loop", () => {
    const a = earlier(ENV_A);
    const lines = readFileSync(join(a.dir, "journal.jsonl"), "utf8").split("\n");
    const tampered = join(base(), "run");
    mkdirSync(tampered);
    writeFileSync(join(tampered, "journal.jsonl"), lines.map((line) => line.replace("notes", "other")).join("\n"));
    assert.throws(() => loadMemoryChain(tampered, environment(ENV_A)), /corrupt|cannot be read/);
    assert.throws(() => loadMemoryChain(join(base(), "nowhere"), environment(ENV_A)), /holds no earlier run/);
    const live = earlier(ENV_A);
    writeFileSync(join(live.dir, "journal.jsonl.lock"), String(process.pid));
    assert.throws(() => loadMemoryChain(live.dir, environment(ENV_A)), /still being written/);
    rmSync(join(live.dir, "journal.jsonl.lock"));
    loadMemoryChain(live.dir, environment(ENV_A));
  });

  it("counts for nothing, under another environment, a claim that was proved: it is open until a stored proof validates again", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, environment(ENV_B));
    assert.equal(chain.segments[0]?.carried, false);
    const dir = join(base(), "run");
    const journal = start(dir, "run_b", ENV_B, chain);
    const p = journal.projection;
    const row = p.claim("clm_a");
    assert.equal(row?.status, "open", "the earlier status counts for nothing");
    assert.equal(row?.earlier_status, "proved", "and is remembered");
    assert.equal(p.validation("val_a_cert"), undefined, "the earlier validations are not validations here");
    assert.deepEqual(p.validations("clm_a"), []);
    assert.deepEqual(p.earlierValidations("clm_a").map((v) => v.validation_id), ["val_a_fast", "val_a_cert"]);
    assert.deepEqual(p.attempts("clm_a").map((x) => x.attempt_id), ["att_a"], "the attempts stay readable");
    assert.deepEqual(p.memorySummary().validations, { carried: 0, notCarried: 2 });
    assert.equal(p.memorySummary().reset, 1);

    // No status can cite them.
    const cite = (to: "computed" | "proved", validationId: string) =>
      journal.emit("claim.status_changed", { claimId: "clm_a", from: to === "computed" ? "open" : "computed", to, reason: "earlier run", validationId }, "orchestrator");
    assert.throws(() => cite("computed", "val_a_fast"), /from an earlier run in another Lean environment/);
    assert.equal(p.claim("clm_a")?.status, "open");
    assert.throws(() => journal.emit("claim.status_changed", { claimId: "clm_a", from: "open", to: "proved", reason: "x", validationId: "val_a_cert" }, "orchestrator"), /another Lean environment/);

    // A stored proof that passes validate again in this run does.
    prove(journal, "clm_a", "again");
    assert.equal(p.claim("clm_a")?.status, "proved");
    assert.deepEqual(p.validations("clm_a").map((v) => v.validation_id), ["val_again_fast", "val_again_cert"]);
    journal.close();
  });

  it("does not let an edge of another environment cite an earlier validation, and resets its status", () => {
    const dir = join(base(), "run");
    const a = start(dir, "run_a", ENV_A);
    claim(a, "clm_a");
    claim(a, "clm_lemma");
    prove(a, "clm_lemma", "lemma");
    a.emit("edge.added", {
      edgeId: "edg_1", kind: "special_case_of", from: "clm_a", to: ["clm_lemma"], status: "lean_checked", validationId: "val_lemma_fast",
      link: { name: "link", statement: STATEMENT },
    }, "test");
    a.close();
    for (const [source, status, earlier] of [[ENV_A, "lean_checked", null], [ENV_B, "proposed", "lean_checked"]] as const) {
      const chain = loadMemoryChain(dir, environment(source));
      const journal = start(join(base(), "run"), "run_b", source, chain);
      assert.equal(journal.projection.edge("edg_1")?.status, status);
      assert.equal(journal.projection.edge("edg_1")?.earlier_status, earlier);
      assert.equal(journal.projection.memorySummary().edgesReset, earlier === null ? 0 : 1);
      if (earlier !== null) {
        claim(journal, "clm_new");
        assert.throws(
          () => journal.emit("edge.added", {
            edgeId: "edg_2", kind: "special_case_of", from: "clm_new", to: ["clm_lemma"], status: "lean_checked", validationId: "val_lemma_fast",
            link: { name: "link", statement: STATEMENT },
          }, "test"),
          /another Lean environment/,
        );
      }
      journal.close();
    }
  });

  it("is rebuilt from both journals: the projection can be deleted and is rebuilt, or caught up", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    const dir = join(base(), "run");
    const journal = start(dir, "run_b", ENV_A, chain);
    claim(journal, "clm_b");
    journal.close();
    const read = () => {
      const j = Journal.open(dir, "run_b");
      const rows = [j.projection.claim("clm_a")?.status, j.projection.claim("clm_b")?.status, j.projection.lastSeq(), j.chain?.hash];
      j.close();
      return rows;
    };
    const first = read();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `projection.sqlite${suffix}`), { force: true });
    assert.deepEqual(read(), first);
    assert.deepEqual(first.slice(0, 3), ["proved", "open", 1]);
  });

  it("carries a status only from the journals that are in the run's environment, along a chain of three", () => {
    // A (env A), B (env B, started on A), C (env A, started on B).
    const a = earlier(ENV_A);
    const chainB = loadMemoryChain(a.dir, environment(ENV_B));
    const dirB = join(base(), "run");
    const b = start(dirB, "run_b", ENV_B, chainB);
    claim(b, "clm_b");
    prove(b, "clm_b", "b");
    b.close();
    const chainC = loadMemoryChain(dirB, environment(ENV_A));
    assert.deepEqual(chainC.segments.map((s) => [s.runId, s.carried]), [["run_a", true], ["run_b", false]]);
    assert.equal(chainC.blobDirs.length, 2);
    assert.equal(chainC.blobDirs[0], join(dirB, "blobs"), "the newest run's blobs first");
    const c = start(join(base(), "run"), "run_c", ENV_A, chainC);
    assert.equal(c.projection.claim("clm_a")?.status, "proved", "the journal in the run's environment carries, through one that does not");
    assert.equal(c.projection.claim("clm_b")?.status, "open");
    assert.equal(c.projection.claim("clm_b")?.earlier_status, "proved");
    assert.equal(c.projection.attempts("clm_a").length, 1);
    c.close();
    // Reopened, C reads the same chain from its own run.started.
    const again = Journal.open(c.log.path.replace(/\/journal\.jsonl$/, ""), "run_c");
    assert.equal(again.chain?.segments.length, 2);
    assert.equal(again.projection.claim("clm_a")?.status, "proved");
    again.close();
  });

  it("carries nothing when the environment cannot be compared", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, undefined);
    assert.equal(chain.segments[0]?.carried, false);
    const journal = start(join(base(), "run"), "run_b", ENV_A, chain);
    assert.equal(journal.projection.claim("clm_a")?.status, "open");
    journal.close();
  });

  it("does not credit the earlier memory to a problem: a claim that carried proved counts as solved only with the problem's own certification", () => {
    const a = earlier(ENV_A);
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    const journal = start(join(base(), "run"), "run_b", ENV_A, chain);
    const p = journal.projection;
    journal.emit("problem.registered", { problemId: "P1", claimId: "clm_a", target: "Demo.add_zero'", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
    assert.equal(p.claim("clm_a")?.status, "proved");
    assert.deepEqual([p.runSummary().solved, p.runSummary().attempts], [0, 0], "nothing is credited, nothing is counted from the earlier run");
    validate(journal, "val_own", "clm_a", "kernel_replay", { problemId: "P1" });
    assert.equal(p.runSummary().solved, 1);
    journal.close();
  });

  it("counts none of the earlier run's spend, tasks, problems or open work", () => {
    const dir = join(base(), "run");
    const a = start(dir, "run_a", ENV_A);
    claim(a, "clm_a");
    a.emit("problem.registered", { problemId: "P1", claimId: "clm_a", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
    attempt(a, "att_a", "clm_a");
    a.emit("attempt.started", { attemptId: "att_cut", claimId: "clm_a", prover: "p2", iteration: 1, model: "m" }, "prover:p2");
    a.emit("model_call.finished", { modelCallId: "mc_a", line: "M1", problemId: "P1", model: "m", outcome: "ok", usd: 1, inputTokens: 1, outputTokens: 1, durationMs: 1, requestHash: "r" }, "line:M1");
    a.close();
    const journal = start(join(base(), "run"), "run_b", ENV_A, loadMemoryChain(dir, environment(ENV_A)));
    const p = journal.projection;
    assert.deepEqual(p.problems(), []);
    assert.deepEqual(p.totalSpend(), { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 });
    assert.deepEqual(p.spendBySite(), []);
    assert.deepEqual(p.openAttempts(), [], "an attempt the earlier run left open is not this run's to take up");
    assert.deepEqual(p.claimsWithAttempts(), []);
    assert.equal(p.runSummary().attempts, 0);
    assert.equal(p.attempts("clm_a").length, 2, "but its attempts are memory");
    // The same problem id can be registered again.
    journal.emit("problem.registered", { problemId: "P1", claimId: "clm_a", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
    journal.close();
  });

  it("reads the blobs of the chain after its own, and writes only its own", () => {
    const a = earlier(ENV_A);
    const old = new BlobStore(join(a.dir, "blobs")).put("an old proof");
    const chain = loadMemoryChain(a.dir, environment(ENV_A));
    const dir = join(base(), "run");
    const blobs = new BlobStore(join(dir, "blobs"), chain.blobDirs.slice(1));
    assert.equal(blobs.get(old), undefined, "this run's directory does not hold it");
    const through = new BlobStore(join(dir, "blobs"), [join(a.dir, "blobs")]);
    assert.equal(through.get(old), "an old proof");
    assert.equal(through.has(old), true);
    const mine = through.put("a new proof");
    assert.equal(new BlobStore(join(a.dir, "blobs")).has(mine), false, "the earlier run's blobs are never written");
  });
});

describe("a chain across Lean environments (Task 21's hash)", () => {
  const BASE = { name: "base", hash: "hash-base" };
  const EXTENDED = { name: "extended", hash: "hash-extended" };

  /** What a run in `reading` sees of a proved claim of an earlier run recorded in `recorded`, with the same bench revision and toolchain. */
  function sees(recorded: LeanEnv | undefined, reading: LeanEnv | undefined) {
    const a = earlier(ENV_A, true, recorded);
    const chain = loadMemoryChain(a.dir, environment(ENV_A, reading));
    const journal = start(join(base(), "run"), "run_b", ENV_A, chain, reading);
    try {
      const p = journal.projection;
      return { carried: chain.segments[0]?.carried, status: p.claim("clm_a")?.status, validations: p.validations("clm_a").length, earlier: p.claim("clm_a")?.earlier_status };
    } finally {
      journal.close();
    }
  }

  it("carries the statuses of an earlier run that recorded the same hash", () => {
    assert.deepEqual(sees(BASE, BASE), { carried: true, status: "proved", validations: 2, earlier: null });
  });

  it("carries nothing between two environments with the same bench revision and toolchain and different hashes", () => {
    assert.deepEqual(sees(EXTENDED, BASE), { carried: false, status: "open", validations: 0, earlier: "proved" });
    assert.deepEqual(sees(BASE, EXTENDED), { carried: false, status: "open", validations: 0, earlier: "proved" });
  });

  it("carries nothing when either hash is null, even from an earlier run with the same record", () => {
    const unresolved = { name: "base", hash: null };
    for (const [recorded, reading] of [[unresolved, unresolved], [unresolved, BASE], [BASE, unresolved]] as const) {
      assert.deepEqual(sees(recorded, reading), { carried: false, status: "open", validations: 0, earlier: "proved" });
    }
  });

  it("never equates an earlier run without a recorded environment with a reading run that has a hash, or the reverse", () => {
    assert.deepEqual(sees(undefined, BASE), { carried: false, status: "open", validations: 0, earlier: "proved" });
    assert.deepEqual(sees(BASE, undefined), { carried: false, status: "open", validations: 0, earlier: "proved" });
    assert.equal(sees(undefined, undefined).carried, true, "two journals of the bench's id still compare by it");
  });

  it("reads the reading run's environment from its own journal on reopen, so the same statuses carry", () => {
    const a = earlier(ENV_A, true, BASE);
    const dir = join(base(), "run");
    start(dir, "run_b", ENV_A, loadMemoryChain(a.dir, environment(ENV_A, BASE)), BASE).close();
    const again = Journal.open(dir, "run_b");
    try {
      assert.equal(again.projection.claim("clm_a")?.status, "proved");
      assert.equal(again.chain?.environment, "env:hash-base");
    } finally {
      again.close();
    }
  });
});
