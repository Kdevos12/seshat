import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { type EdgeKind, type EdgeStatus, type EventDataMap, Journal, statementIdV0 } from "../src/index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mh-memory-"));
}

type ClaimExtra = Omit<EventDataMap["claim.created"], "claimId" | "statementId" | "statement" | "origin" | "status">;

function claim(journal: Journal, claimId: string, statement: string, extra: ClaimExtra = {}): void {
  journal.emit("claim.created", { claimId, statementId: statementIdV0(statement), statement, origin: "test", status: "open", ...extra }, "test");
}

function validation(
  journal: Journal,
  validationId: string,
  claimId: string,
  options: { verdict?: "valid" | "invalid"; method?: "repl" | "kernel_replay"; negation?: boolean } = {},
): void {
  journal.emit(
    "validation.finished",
    {
      validationId,
      claimId,
      method: options.method ?? "repl",
      verdict: options.verdict ?? "valid",
      reasons: [],
      axioms: [],
      submissionHash: "h",
      ...(options.negation === undefined ? {} : { negation: options.negation }),
    },
    "validator",
  );
}

/** Every row of every table of a projection file, as JSON lines sorted per table. */
function dump(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path);
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all() as unknown as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.prepare(`select * from "${name}"`).all().map((row) => JSON.stringify(row)).sort()]),
    );
  } finally {
    db.close();
  }
}

const source = { repo: "r", rev: "v", path: "X.lean" };

describe("memory events", () => {
  it("project claims, attempts, edges, nodes and model calls, and rebuild the same tables", () => {
    // Keys in no particular order: the projection stores canonical JSON, so a rebuild, which reads
    // the journal's sorted keys, writes the same text.
    const dir = tempDir();
    const journal = Journal.open(dir, "run_1");
    claim(journal, "clm_a", "(n : ℕ) : n + 0 = n", { gloss: "zero is neutral", domain: ["11"], header: "import Mathlib", kind: "formal" });
    claim(journal, "clm_b", ": True", { parentId: "clm_a" });
    claim(journal, "clm_c", "the sum of two odd numbers is even", { kind: "informal" });
    claim(journal, "clm_link", "(n : ℕ) : n + 0 = n ↔ True");
    journal.emit("problem.registered", { problemId: "prb_a", claimId: "clm_a", target: "t", source, domain: ["11"] }, "orchestrator");
    journal.emit(
      "attempt.started",
      { attemptId: "att_1", claimId: "clm_a", prover: "p0", iteration: 0, model: "PROVIDER/ID", role: "refute", strategy: "induction", subgoal: "succ" },
      "prover:p0",
    );
    journal.emit(
      "attempt.finished",
      {
        attemptId: "att_1",
        outcome: "invalid",
        durationMs: 5,
        turns: 2,
        usd: 0.5,
        inputTokens: 10,
        outputTokens: 20,
        strategy: "simp",
        premises: ["Nat.add_zero"],
        failureDetail: "unsolved goals at succ",
      },
      "prover:p0",
    );
    journal.emit("tool_run.started", { toolRunId: "tr_1", capability: "c", implementation: "i", version: "1", inputHash: "x" }, "c");
    validation(journal, "val_link", "clm_link");
    validation(journal, "val_neg", "clm_a", { verdict: "invalid", negation: true });
    const link = { name: "a_iff_b", statement: "(n : ℕ) : n + 0 = n ↔ True" };
    journal.emit("edge.added", { edgeId: "edg_1", kind: "equiv", from: "clm_a", to: ["clm_b"], status: "proposed", attemptId: "att_1", note: "n", link }, "test");
    journal.emit("edge.status_changed", { edgeId: "edg_1", from: "proposed", to: "lean_checked", reason: "checked", validationId: "val_link" }, "test");
    journal.emit("edge.added", { edgeId: "edg_2", kind: "decomposes_into", from: "clm_a", to: ["clm_b", "clm_c"], status: "proposed" }, "test");
    journal.emit("node.recorded", { nodeId: "nod_1", kind: "lesson", claimId: "clm_a", data: { text: "try induction", tags: ["nat"], by: "p0" } }, "test");
    journal.emit("node.updated", { nodeId: "nod_1", patch: { tags: null, uses: 1 }, reason: "used once" }, "test");
    journal.emit("node.updated", { nodeId: "nod_1", patch: { uses: 2 }, reason: "used twice" }, "test");
    journal.emit("edge.added", { edgeId: "edg_3", kind: "uses", from: "nod_1", to: ["clm_c"], status: "computed", toolRunId: "tr_1" }, "test");
    journal.emit(
      "model_call.finished",
      {
        modelCallId: "mc_1",
        line: "M1",
        problemId: "prb_a",
        attemptId: "att_1",
        model: "PROVIDER/ID",
        outcome: "ok",
        requestHash: "r",
        responseHash: "s",
        durationMs: 3,
        usd: 0.25,
        inputTokens: 5,
        outputTokens: 6,
      },
      "line:M1",
    );

    const p = journal.projection;
    const a = p.claim("clm_a");
    assert.deepEqual([a?.gloss, a?.domain, a?.kind, a?.parent_id, a?.header], ["zero is neutral", ["11"], "formal", null, "import Mathlib"]);
    const b = p.claim("clm_b");
    assert.deepEqual([b?.gloss, b?.domain, b?.kind, b?.parent_id, b?.header], [null, [], "formal", "clm_a", null]);
    assert.equal(p.claim("clm_c")?.kind, "informal");
    const attempt = p.attempt("att_1");
    assert.deepEqual(
      [attempt?.role, attempt?.declared_strategy, attempt?.subgoal, attempt?.strategy, attempt?.premises, attempt?.failure_detail],
      ["refute", "induction", "succ", "simp", ["Nat.add_zero"], "unsolved goals at succ"],
    );
    assert.equal(p.validation("val_neg")?.negation, true);
    assert.equal(p.validation("val_link")?.negation, false);
    const edge = p.edge("edg_1");
    assert.deepEqual(
      [edge?.status, edge?.validation_id, edge?.link_name, edge?.link_statement, edge?.to, edge?.attempt_id, edge?.note],
      ["lean_checked", "val_link", "a_iff_b", link.statement, ["clm_b"], "att_1", "n"],
    );
    assert.deepEqual(p.edges({ to: "clm_c" }).map((e) => e.edge_id), ["edg_2", "edg_3"]);
    assert.deepEqual(p.edges({ from: "clm_a", kinds: ["decomposes_into"] }).map((e) => e.to), [["clm_b", "clm_c"]]);
    assert.deepEqual(p.edges({ statuses: ["lean_checked", "computed"] }).map((e) => e.edge_id), ["edg_1", "edg_3"]);
    assert.deepEqual(p.edges({ kinds: [] }), []);
    assert.equal(p.edges().length, 3);
    assert.deepEqual(p.node("nod_1")?.data, { text: "try induction", by: "p0", uses: 2 });
    assert.deepEqual(p.nodes("lesson", "clm_a").map((n) => n.node_id), ["nod_1"]);
    assert.deepEqual(p.nodes("lesson", "clm_b"), []);
    assert.equal(p.modelCall("mc_1")?.usd, 0.25);
    assert.deepEqual(p.runSummary(), { problems: 1, solved: 0, candidates: 0, attempts: 1, usd: 0.75, inputTokens: 15, outputTokens: 26 });
    journal.close();

    const path = join(dir, "projection.sqlite");
    const before = dump(path);
    assert.equal(before.edge_targets?.length, 4);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    Journal.open(dir, "run_1").close();
    assert.deepEqual(dump(path), before);
  });
});

describe("memory invariants", () => {
  it("refuse malformed edges", () => {
    const journal = Journal.open(tempDir(), "run_1");
    claim(journal, "clm_a", ": A");
    claim(journal, "clm_b", ": B");
    claim(journal, "clm_c", ": C");
    const edge = (data: Partial<EventDataMap["edge.added"]>) =>
      journal.emit("edge.added", { edgeId: "edg_1", kind: "implies", from: "clm_a", to: ["clm_b"], status: "proposed", ...data }, "test");
    assert.throws(() => edge({ kind: "follows" as EdgeKind }), /unknown kind follows/);
    assert.throws(() => edge({ status: "true" as EdgeStatus }), /unknown status true/);
    assert.throws(() => edge({ to: [] }), /has no target/);
    assert.throws(() => edge({ to: ["clm_b", "clm_c"] }), /a implies edge has one target, edge edg_1 has 2/);
    assert.throws(() => edge({ kind: "decomposes_into", to: ["clm_b", "clm_b"] }), /names a target twice/);
    assert.throws(() => edge({ to: ["clm_a"] }), /goes from clm_a to itself/);
    assert.throws(() => edge({ to: ["clm_x"] }), /unknown claim or node clm_x/);
    assert.throws(() => edge({ from: "nod_x" }), /unknown claim or node nod_x/);
    assert.throws(() => edge({ kind: "cites", link: { name: "l", statement: ": A → B" } }), /no lemma checks a cites edge/);
    assert.throws(() => edge({ attemptId: "att_9" }), /unknown attempt att_9/);
    assert.throws(() => edge({ toolRunId: "tr_9" }), /unknown tool run tr_9/);
    assert.throws(() => edge({ validationId: "val_9" }), /unknown validation val_9/);
    edge({ kind: "decomposes_into", to: ["clm_b", "clm_c"] });
    assert.throws(() => edge({}), /edge edg_1 already exists/);
    assert.throws(
      () => journal.emit("edge.status_changed", { edgeId: "edg_9", from: "proposed", to: "computed", reason: "x" }, "test"),
      /unknown edge edg_9/,
    );
    assert.equal(journal.projection.edges().length, 1);
    journal.close();
  });

  it("make an edge lean_checked only with a valid validation of its link lemma", () => {
    const journal = Journal.open(tempDir(), "run_1");
    claim(journal, "clm_a", ": A");
    claim(journal, "clm_b", ": B");
    const link = { name: "a_imp_b", statement: ": A → B" };
    // The same statement up to comments and whitespace: the lemma the link names.
    claim(journal, "clm_link", ":  A   →  B -- the link");
    claim(journal, "clm_other", ": B → A");
    validation(journal, "val_bad", "clm_link", { verdict: "invalid" });
    validation(journal, "val_neg", "clm_link", { negation: true });
    validation(journal, "val_other", "clm_other");
    validation(journal, "val_ok", "clm_link");
    const add = (edgeId: string, data: Partial<EventDataMap["edge.added"]>) =>
      journal.emit("edge.added", { edgeId, kind: "implies", from: "clm_a", to: ["clm_b"], status: "proposed", ...data }, "test");
    assert.throws(() => add("edg_0", { status: "lean_checked", validationId: "val_ok" }), /edge edg_0 has no link lemma/);
    add("edg_1", { link });
    const promote = (validationId?: string) =>
      journal.emit(
        "edge.status_changed",
        { edgeId: "edg_1", from: "proposed", to: "lean_checked", reason: "checked", ...(validationId === undefined ? {} : { validationId }) },
        "test",
      );
    assert.throws(() => promote(), /only with a valid validation of its link lemma/);
    assert.throws(() => promote("val_bad"), /only with a valid validation of its link lemma/);
    assert.throws(() => promote("val_neg"), /only with a valid validation of its link lemma/);
    assert.throws(() => promote("val_other"), /checks claim clm_other, not the link lemma of edge edg_1/);
    assert.equal(journal.projection.edge("edg_1")?.status, "proposed");
    promote("val_ok");
    assert.equal(journal.projection.edge("edg_1")?.status, "lean_checked");
    add("edg_2", { status: "lean_checked", link, validationId: "val_ok" });
    assert.throws(
      () => journal.emit("edge.status_changed", { edgeId: "edg_1", from: "proposed", to: "computed", reason: "x" }, "test"),
      /edge edg_1 is lean_checked, not proposed/,
    );
    assert.throws(
      () => journal.emit("edge.status_changed", { edgeId: "edg_1", from: "lean_checked", to: "lean_checked", reason: "x", validationId: "val_ok" }, "test"),
      /already lean_checked/,
    );
    // Any status can be withdrawn, with a reason.
    journal.emit("edge.status_changed", { edgeId: "edg_1", from: "lean_checked", to: "proposed", reason: "the lemma changed" }, "test");
    assert.deepEqual([journal.projection.edge("edg_1")?.status, journal.projection.edge("edg_1")?.validation_id], ["proposed", null]);
    journal.close();
  });

  it("record nodes, apply their patches in order, and keep node and claim ids apart", () => {
    const journal = Journal.open(tempDir(), "run_1");
    claim(journal, "clm_a", ": A");
    const record = (nodeId: string, kind: string, claimId?: string) =>
      journal.emit("node.recorded", { nodeId, kind, ...(claimId === undefined ? {} : { claimId }), data: { n: 0, keep: true } }, "test");
    assert.throws(() => record("nod_1", "Lesson"), /bad kind "Lesson"/);
    assert.throws(() => record("nod_1", "two words"), /bad kind/);
    assert.throws(() => record("nod_1", "lesson", "clm_x"), /unknown claim clm_x/);
    assert.throws(() => record("clm_a", "lesson"), /clm_a is already a claim/);
    record("nod_1", "lesson", "clm_a");
    assert.throws(() => record("nod_1", "lesson"), /node nod_1 already exists/);
    assert.throws(() => claim(journal, "nod_1", ": B"), /nod_1 is already a node/);
    const update = (nodeId: string, patch: EventDataMap["node.updated"]["patch"]) =>
      journal.emit("node.updated", { nodeId, patch, reason: "test" }, "test");
    assert.throws(() => update("nod_9", { n: 1 }), /unknown node nod_9/);
    update("nod_1", { n: 1, list: [1] });
    update("nod_1", { n: 2, keep: null });
    update("nod_1", { list: [2, 3] });
    assert.deepEqual(journal.projection.node("nod_1")?.data, { n: 2, list: [2, 3] });
    assert.ok((journal.projection.node("nod_1")?.updated_seq ?? 0) > (journal.projection.node("nod_1")?.created_seq ?? 0));
    journal.close();
  });

  it("check a claim's parent and kind", () => {
    const journal = Journal.open(tempDir(), "run_1");
    assert.throws(() => claim(journal, "clm_b", ": B", { parentId: "clm_x" }), /unknown parent claim clm_x/);
    assert.throws(() => claim(journal, "clm_b", ": B", { kind: "vague" as "formal" }), /unknown kind vague/);
    journal.close();
  });

  it("make a claim refuted only through a certified validation of its negation", () => {
    const journal = Journal.open(tempDir(), "run_1");
    claim(journal, "clm_1", ": A");
    claim(journal, "clm_2", ": B");
    validation(journal, "val_proof", "clm_1", { method: "kernel_replay" });
    validation(journal, "val_repl", "clm_1", { negation: true });
    validation(journal, "val_other", "clm_2", { method: "kernel_replay", negation: true });
    validation(journal, "val_refutation", "clm_1", { method: "kernel_replay", negation: true });
    const settle = (to: "proved" | "refuted", validationId: string) =>
      journal.emit("claim.status_changed", { claimId: "clm_1", from: "open", to, reason: "test", validationId }, "orchestrator");
    assert.throws(() => settle("refuted", "val_proof"), /certifies the claim, so claim clm_1 cannot become refuted/);
    assert.throws(() => settle("refuted", "val_repl"), /only with a certified validation/);
    assert.throws(() => settle("refuted", "val_other"), /certifies claim clm_2, not clm_1/);
    assert.throws(() => settle("proved", "val_refutation"), /certifies the negation of the claim, so claim clm_1 cannot become proved/);
    settle("refuted", "val_refutation");
    assert.equal(journal.projection.claim("clm_1")?.status, "refuted");
    journal.close();
  });

  it("record a model call once, for a known problem and attempt", () => {
    const journal = Journal.open(tempDir(), "run_1");
    const call = (modelCallId: string, ids: { problemId?: string; attemptId?: string } = {}) =>
      journal.emit(
        "model_call.finished",
        { modelCallId, line: "M1", model: "PROVIDER/ID", outcome: "error", requestHash: "r", error: "x", durationMs: 1, usd: 0, inputTokens: 0, outputTokens: 0, ...ids },
        "line:M1",
      );
    assert.throws(() => call("mc_1", { problemId: "prb_9" }), /unknown problem prb_9/);
    assert.throws(() => call("mc_1", { attemptId: "att_9" }), /unknown attempt att_9/);
    call("mc_1");
    assert.throws(() => call("mc_1"), /model call mc_1 already exists/);
    assert.equal(journal.projection.modelCall("mc_1")?.outcome, "error");
    journal.close();
  });
});
