import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, newId } from "@seshat/core";
import { frontier, frontierCardLines, frontierGrowth, frontierMarkdown, MemoryStore, recordAcceptedLemmas } from "../src/index.ts";

function open(): { memory: MemoryStore; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "mh-frontier-"));
  const journal = Journal.open(dir, "run_1");
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }), journal };
}

let counter = 0;
async function claim(memory: MemoryStore, statement: string): Promise<string> {
  return (await memory.ensureClaim({ statement, origin: "line:T" })).claimId;
}
function validation(journal: Journal, claimId: string, method: "repl" | "kernel_replay", negation = false): string {
  const validationId = `val_${++counter}`;
  journal.emit("validation.finished", { validationId, claimId, method, verdict: "valid", reasons: [], axioms: [], submissionHash: "h", ...(negation ? { negation: true } : {}) }, "validator");
  return validationId;
}
function status(journal: Journal, claimId: string, to: "computed" | "proved" | "refuted"): void {
  const id = validation(journal, claimId, to === "computed" ? "repl" : "kernel_replay", to === "refuted");
  journal.emit("claim.status_changed", { claimId, from: "open", to, reason: "setup", validationId: id }, "orchestrator");
}
function attempt(journal: Journal, claimId: string, usd: number): string {
  const attemptId = newId("att");
  journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: 1, model: "test/model" }, "prover:p1");
  journal.emit("attempt.finished", { attemptId, outcome: "invalid", usd, inputTokens: 0, outputTokens: 0, durationMs: 1000, turns: 1 }, "prover:p1");
  return attemptId;
}
async function checked(memory: MemoryStore, journal: Journal, kind: "implies" | "refuted_by", from: string, to: string, name: string) {
  const statement = `: ${name.length} = ${name.length}`;
  const lemma = await claim(memory, statement);
  return memory.addEdge({ kind, from, to, status: "lean_checked", validationId: validation(journal, lemma, "repl"), link: { name, statement } });
}

async function scripted() {
  const { memory, journal } = open();
  const target = await claim(memory, "(n : ℕ) : n + 0 = n");
  const part = await claim(memory, "(m : ℕ) : 0 + m = m");
  const dead = await claim(memory, "(k : ℕ) : k = k + 1");
  const special = await claim(memory, ": 2 + 0 = 2");
  const variant = await claim(memory, "(n : ℕ) : n + 0 ≤ n");
  const premise = await claim(memory, "(a : ℕ) : a = a");
  const counter = await claim(memory, "(j : ℕ) : j < 0");
  memory.addEdge({ kind: "decomposes_into", from: target, to: [part, dead, counter] });
  const events: Array<() => unknown> = [
    () => status(journal, part, "computed"),
    () => recordAcceptedLemmas(memory, target, attempt(journal, target, 0.5), { leanStatus: "ok", checked: "theorem aux_a : True := trivial", messages: [], sorries: [] } as never),
    () => { memory.addEdge({ kind: "special_case_of", from: special, to: target }); status(journal, special, "proved"); },
    () => { memory.addEdge({ kind: "strengthens", from: variant, to: target }); status(journal, variant, "proved"); },
    () => checked(memory, journal, "implies", premise, target, "imp"),
    () => status(journal, dead, "refuted"),
    () => memory.recordNode({ kind: "hygiene", claimId: target, data: { check: "plausible", result: "no_counterexample", detail: "none in samples" } }),
    () => memory.recordNode({ kind: "search_result", claimId: target, data: { key: "k1", done: { claimId: target, reached: true, note: "", best: { code: "c", score: 7 }, witness: [1], verdict: "valid" } } }),
  ];
  void counter;
  return { memory, journal, target, events, dead };
}

describe("the verified frontier", () => {
  it("shows one entry of each kind a journal can show, with the expected score", async () => {
    const { memory, target, events } = await scripted();
    for (const e of events) await e();
    const f = frontier(memory, target);
    assert.deepEqual(f.counts, { subclaim: 2, case: 1, variant: 1, reduction: 1, dead_end: 1, evidence: 1, best: 1 });
    // 2 subclaims x 3 + case 1 + variant 1 + reduction 3 + dead end 1 + evidence 0.5 + best 1
    assert.equal(f.score, 13.5);
    assert.equal(f.entries.find((e) => e.kind === "subclaim" && e.id === "aux_a")?.usd, 0.5);
    assert.ok(f.entries.every((e) => e.provenance.seqs.length > 0 && e.provenance.seqs.includes(e.seq) || e.kind === "dead_end"));
    assert.equal(frontier(memory, target, { weights: { evidence: 2 } }).score, 15);
  });

  it("labels evidence as evidence and keeps it apart in the section", async () => {
    const { memory, target, events } = await scripted();
    for (const e of events) await e();
    const f = frontier(memory, target);
    const ev = f.entries.find((e) => e.kind === "evidence");
    assert.equal(ev?.evidence, true);
    assert.equal(ev?.status, undefined);
    const md = frontierMarkdown(f);
    assert.match(md, /^## Established so far/);
    assert.match(md, /Evidence, not proof:\n\n- plausible found no counterexample/);
    assert.ok(!md.split("Evidence, not proof:")[0]?.includes("plausible"));
    assert.ok(frontierCardLines(f, 600).some((l) => /evidence, not proof - evidence:/.test(l)));
  });

  it("is deterministic: two builds give the same bytes", async () => {
    const { memory, target, events } = await scripted();
    for (const e of events) await e();
    assert.equal(JSON.stringify(frontier(memory, target)), JSON.stringify(frontier(memory, target)));
    assert.equal(JSON.stringify(frontierGrowth(memory, target)), JSON.stringify(frontierGrowth(memory, target)));
  });

  it("is empty for a journal that shows nothing, and for an unknown claim", async () => {
    const { memory } = open();
    const id = await claim(memory, ": 1 = 1");
    assert.deepEqual(frontier(memory, id), { claimId: id, entries: [], score: 0, counts: { subclaim: 0, case: 0, variant: 0, reduction: 0, dead_end: 0, evidence: 0, best: 0 } });
    assert.equal(frontier(memory, "clm_x").score, 0);
    assert.equal(frontierMarkdown(frontier(memory, id)), "");
  });

  it("only grows: the score never falls as events arrive, and the growth carries the spend", async () => {
    const { memory, journal, target, events } = await scripted();
    let last = -1;
    for (const e of events) {
      await e();
      attempt(journal, target, 0.25);
      const s = frontier(memory, target).score;
      assert.ok(s >= last, `${s} < ${last}`);
      last = s;
    }
    const points = frontierGrowth(memory, target);
    assert.deepEqual(points[0], { usd: 0, score: 0, seq: 0 });
    for (let i = 1; i < points.length; i++) {
      assert.ok((points[i] as { score: number }).score >= (points[i - 1] as { score: number }).score);
      assert.ok((points[i] as { usd: number }).usd >= (points[i - 1] as { usd: number }).usd);
    }
    assert.equal((points.at(-1) as { score: number }).score, last);
  });
});
