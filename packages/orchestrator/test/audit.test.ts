import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AUX_BEGIN, AUX_END, BlobStore, type HarnessEvent, PROOF_BEGIN, PROOF_END, sha256Hex } from "@seshat/core";
import { audit, auditCommand } from "../src/audit.ts";
import { lengthBuckets, referenceLength } from "../src/length.ts";
import { scriptedRun, type ScriptedSpec } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const SKETCH = JSON.stringify({ aux: "lemma aux_one : True := by\n  sorry", proof: "exact aux_one" });
const LEAN_ERROR = `unsolved goals ${"x".repeat(400)}`;

function spec(): ScriptedSpec {
  return {
    problems: [
      { id: "easy", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.2 }] },
      { id: "hard", outcome: "unsolved", attempts: [{ usd: 0.5, turns: 7 }, { usd: 0.25, turns: 3 }] },
    ],
    nodes: [
      { kind: "m12_sketch", claimId: "hard", data: { problemId: "hard", attemptId: "a", submission: sha256Hex(SKETCH), names: ["aux_one"], healthy: false, problem: "a hole states the target", dropped: ["aux_two"], planner: true, registered: false, holes: [] } },
      { kind: "m12_sketch", claimId: "hard", data: { problemId: "hard", attemptId: "b", submission: sha256Hex(SKETCH), names: [], healthy: true, repairOf: "a", registered: false, holes: [] } },
      // A hole's local redraft (DP7): not the problem's last sketch.
      { kind: "m12_sketch", claimId: "hard", data: { problemId: "hard", attemptId: "aux_one@00000c:draft", submission: sha256Hex("{}"), names: [], healthy: false, problem: "the draft proof has errors Lean reports", planner: true, fromInformal: true, redraftOf: "c", registered: true, holes: [] } },
      { kind: "m12_session", claimId: "hard", data: { problemId: "hard", taskId: "t", claimId: "c", session: 1, ok: false, usd: 0.1, reasons: [], verdict: "too_hard" } },
      { kind: "informal_proof", claimId: "hard", data: { problemId: "hard", accepted: false, passes: 0, required: 2, rounds: 3, verdicts: ["incorrect", "gap"], models: { planner: "faux/p", verifier: "faux/v" }, stop: "rounds", facts: [], hits: [] } },
      { kind: "hygiene", claimId: "hard", data: { check: "plausible", result: "no_counterexample" } },
    ],
  };
}

/** A scripted run with its blobs and transcripts, and the events the helper cannot write (a gate answer, Lean's errors). */
function build(dir = tempDir("audit-")) {
  const run = scriptedRun(spec(), dir);
  new BlobStore(join(dir, "blobs")).put(SKETCH);
  const attempts = run.events.filter((e) => e.type === "attempt.started").map((e) => (e as { data: { attemptId: string } }).data.attemptId);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name, arguments: {} }] });
  // The proved problem's attempt is the first; the hard one's two follow.
  writeFileSync(join(dir, "transcripts", `${attempts[1]}.json`), JSON.stringify([call("lean_search"), call("lean_search"), call("lean_check")]));
  writeFileSync(join(dir, "transcripts", `${attempts[2]}.json`), JSON.stringify([call("compute")]));
  return { run, dir, attempts };
}

describe("harness audit", () => {
  it("makes a dossier for the problem that was not certified, and none for the certified one", () => {
    const { run, dir, attempts } = build();
    const claim = run.claims.hard as string;
    const extra = [
      { type: "validation.finished", data: { validationId: "v1", claimId: claim, method: "repl", verdict: "invalid", reasons: ["old error"], axioms: [], submissionHash: "h" } },
      { type: "validation.finished", data: { validationId: "v2", claimId: claim, method: "repl", verdict: "invalid", reasons: [LEAN_ERROR], axioms: [], submissionHash: "h" } },
      { type: "budget.gated", data: { problemId: "hard", site: "wave", action: "probe", by: "probe", estimateUsd: 1, remainingUsd: 5, budgetUsd: 5, share: 0.1, rung: 0, exploration: false, reason: "the probe" } },
      { type: "budget.gated", data: { problemId: "hard", site: "wave", action: "skip", by: "progress", estimateUsd: 1, remainingUsd: 4, budgetUsd: 5, share: 0.1, rung: 0, exploration: false, reason: "no Lean progress in the probe" } },
    ] as unknown as HarnessEvent[];
    const blobs = new BlobStore(join(dir, "blobs"));
    const result = audit({
      events: [...run.events, ...extra],
      blob: (h) => blobs.get(h),
      transcript: (id) => {
        try {
          return JSON.parse(readFileSync(join(dir, "transcripts", `${id}.json`), "utf8"));
        } catch {
          return undefined;
        }
      },
    });
    assert.equal(result.problems, 2);
    assert.equal(result.certified, 1);
    assert.deepEqual(result.dossiers.map((d) => d.problemId), ["hard"]);
    assert.equal(result.gateStopsAfterProbe, 1);
    // The two sessions of `hard` are in the dossier; the transcript of the second has no lean_check, the first has one.
    const d = result.dossiers[0]!;
    assert.deepEqual(d.sessions.map((s) => [s.attemptId, s.turns, s.leanChecks, s.tools]), [
      [attempts[1], 7, 1, { lean_search: 2, lean_check: 1 }],
      [attempts[2], 3, 0, { compute: 1 }],
    ]);
    assert.equal(result.sessions, 3);
    assert.equal(result.sessionsWithoutCheck, 2, "the certified problem's session recorded no check either");
    assert.ok(Math.abs(d.spendUsd - 0.75) < 1e-9);
    assert.deepEqual(d.spendBySite, { "prover.session": d.spendBySite["prover.session"] });
    assert.deepEqual(d.gate.map((g) => [g.action, g.by, g.reason]), [["probe", "probe", "the probe"], ["skip", "progress", "no Lean progress in the probe"]]);
    assert.equal(d.leanErrors.length, 2);
    assert.equal(d.leanErrors[1]?.length, 300);
    assert.equal(d.sketch?.text, "lemma aux_one : True := by\n  sorry\nexact aux_one");
    assert.equal(d.sketch?.healthy, true);
    assert.equal(d.sketch?.plannerRounds, 1);
    assert.equal(d.sketch?.repairs, 1);
    assert.deepEqual(d.sketch?.holeVerdicts, { too_hard: 1 });
    assert.deepEqual(d.informal?.verdicts, ["incorrect", "gap"]);
    assert.equal(d.informal?.accepted, false);
  });

  it("writes audit.md next to the journal and nothing into the journal", () => {
    const { dir } = build();
    const before = readFileSync(join(dir, "journal.jsonl"), "utf8");
    const lines: string[] = [];
    const file = auditCommand(dir, { out: (l) => lines.push(l) });
    assert.equal(file, join(dir, "audit.md"));
    const text = readFileSync(file, "utf8");
    assert.match(text, /^# Audit/);
    assert.match(text, /Problems: 2, certified: 1, not certified: 1/);
    assert.match(text, /^## Output tokens by role and kind$/m);
    assert.match(text, /\| Role \| Calls \| Output tokens \| Thinking \| Text \| Tool-call arguments \| Prose share \| Split covers \|/);
    assert.match(text, /^## `hard` \(unsolved\)/m);
    assert.match(text, /lean_search x2, lean_check x1/);
    assert.match(text, /lemma aux_one/);
    assert.match(text, /planner rounds: 1; repairs: 1/);
    assert.match(text, /plausible no_counterexample/);
    assert.match(text, /\*\*Formal-cost triage\*\*: short \(computed from the journal now\): no informal proof was accepted/);
    assert.doesNotMatch(text, /^## `easy`/m, "a certified problem has no dossier, only a row in the length table");
    assert.equal(readFileSync(join(dir, "journal.jsonl"), "utf8"), before);
    assert.ok(lines.some((l) => l.includes("audit.md")));
  });

  it("writes one section per arm of an ablation directory", () => {
    const root = mkdtempSync(join(tempDir("audit-ab-"), "x-"));
    for (const arm of ["solve-v2", "solve-v2-cards"]) {
      const { dir } = build(join(root, "arms", arm, "measure"));
      void dir;
    }
    auditCommand(root, { out: () => undefined });
    const text = readFileSync(join(root, "audit.md"), "utf8");
    assert.match(text, /^# Audit of an ablation/);
    assert.match(text, /^## Arm solve-v2$/m);
    assert.match(text, /^## Arm solve-v2-cards$/m);
    assert.equal((text.match(/^### `hard`/gm) ?? []).length, 2);
  });

  it("shows a reference solution beside the dossier, marked as a person's", () => {
    const { dir } = build();
    const ref = tempDir("audit-ref-");
    writeFileSync(join(ref, "hard.md"), "By induction on `n`.\n```lean\nexact foo\n```\n");
    writeFileSync(join(ref, "easy.md"), "never shown: the problem was certified");
    auditCommand(dir, { reference: ref, out: () => undefined });
    const text = readFileSync(join(dir, "audit.md"), "utf8");
    assert.match(text, /Reference solution\*\* \(supplied by a person; never read by a solving run\)/);
    assert.match(text, /By induction on `n`/);
    assert.doesNotMatch(text, /never shown/);
    auditCommand(dir, { out: () => undefined });
    assert.doesNotMatch(readFileSync(join(dir, "audit.md"), "utf8"), /Reference solution/);
  });

  it("measures the length of every problem, and the success against reference length", () => {
    const { run, dir, attempts } = build();
    const blobs = new BlobStore(join(dir, "blobs"));
    // The certified proof: no markers, so the whole text is counted; 3 of its 6 lines are Lean.
    const proved = "import Mathlib\n-- a comment\n\n/- a block\n   comment -/\ntheorem easy : True := by\n  trivial\n";
    // The last failed file of `hard`: two regions, two aux_ lemmas, 4 Lean lines in all.
    const failed = `${AUX_BEGIN}\nlemma aux_a : True := by\n  trivial\ntheorem aux_b : True := aux_a\n${AUX_END}\ntheorem hard : True := by\n${PROOF_BEGIN}\n  sorry\n${PROOF_END}\n`;
    const input = JSON.stringify({ snippets: [{ id: "x", code: "x".repeat(1000) }] });
    const ids = { proved: blobs.put(proved), failed: blobs.put(failed), input: blobs.put(input) };
    const hardClaim = run.claims.hard as string;
    const extra = [
      { type: "validation.finished", data: { validationId: "v1", claimId: run.claims.easy, method: "kernel_replay", verdict: "valid", reasons: [], axioms: [], submissionHash: ids.proved } },
      { type: "validation.finished", data: { validationId: "v2", claimId: hardClaim, method: "repl", verdict: "invalid", reasons: ["e"], axioms: [], submissionHash: ids.failed } },
      { type: "tool_run.started", data: { toolRunId: "tr_c1", capability: "lean.check", implementation: "x", version: "1", inputHash: ids.input, attemptId: attempts[1] } },
      { type: "tool_run.finished", data: { toolRunId: "tr_c1", outcome: "ok", durationMs: 2500 } },
    ] as unknown as HarnessEvent[];
    const result = audit({
      events: [...run.events, ...extra],
      blob: (h) => blobs.get(h),
      referenceLength: (id) => (id === "easy" ? { lines: 10, theorems: 1, from: "lean" } : id === "hard" ? { lines: 150, theorems: 9, from: "md" } : undefined),
    });
    const [easy, hard] = [result.lengths.find((r) => r.problemId === "easy")!, result.lengths.find((r) => r.problemId === "hard")!];
    assert.equal(easy.status, "certified");
    assert.deepEqual(easy.file, { source: "certified_validation", counted: "file", lines: 3, chars: proved.length, theorems: 1 });
    assert.equal(easy.auxLemmas, 0);
    assert.equal(hard.status, "not certified");
    assert.equal(hard.file?.source, "last_failed_validation");
    assert.equal(hard.file?.counted, "regions");
    assert.equal(hard.file?.lines, 4);
    assert.equal(hard.auxLemmas, 2);
    assert.deepEqual(hard.holes, { count: 0, dropped: 0, healthy: true, verdicts: { too_hard: 1 } });
    assert.equal(hard.leanCheckRuns, 1);
    assert.deepEqual(hard.checkTimes, [{ chars: 1000, ms: 2500 }]);
    assert.deepEqual(hard.stopReasons, { model: 2 });
    assert.equal(easy.leanChecks, undefined, "the helper's attempts record no check count: not recorded, not guessed");
    const rows = Object.fromEntries(lengthBuckets(result.lengths).map((b) => [b.bucket, b]));
    assert.deepEqual(rows["<30"], { bucket: "<30", total: 1, certified: 1, medianCertifiedLines: 3 });
    assert.deepEqual(rows["100-299"], { bucket: "100-299", total: 1, certified: 0 });
    assert.deepEqual(rows["no reference"], { bucket: "no reference", total: 0, certified: 0 });
  });

  it("counts reference lengths from a .lean file and from the Lean blocks of a .md, and writes the table and length.json", () => {
    const { dir } = build();
    const ref = tempDir("audit-reflen-");
    writeFileSync(join(ref, "easy.lean"), "-- header\nimport Mathlib\n\n/-- doc -/\ntheorem a : True := trivial\nlemma b : True := trivial\n");
    writeFileSync(join(ref, "hard.md"), "Prose.\n```lean\ntheorem h1 : True := by\n  trivial\n```\nMore.\n```python\nnot lean\n```\n");
    assert.deepEqual(referenceLength(ref, "easy"), { lines: 3, theorems: 2, from: "lean" });
    assert.deepEqual(referenceLength(ref, "hard"), { lines: 2, theorems: 1, from: "md" });
    assert.equal(referenceLength(ref, "none"), undefined);
    auditCommand(dir, { reference: ref, out: () => undefined });
    const text = readFileSync(join(dir, "audit.md"), "utf8");
    assert.match(text, /^## Length$/m);
    assert.match(text, /\| `easy` \| certified \| not recorded \|/);
    assert.match(text, /\| `hard` \| not certified \|.* \| 2 \(1\) \|$/m);
    assert.match(text, /\| <30 \| 1 \/ 2 \| not recorded \|/);
    assert.match(text, /\| no reference \| 0 \/ 0 \|/);
    const json = JSON.parse(readFileSync(join(dir, "length.json"), "utf8")) as { records: Array<{ arm: string; problemId: string; reference?: { lines: number } }> };
    assert.deepEqual(json.records.map((r) => [r.arm, r.problemId, r.reference?.lines]), [["run", "easy", 3], ["run", "hard", 2]]);
  });

  it("keeps one set of length records per arm of an ablation directory", () => {
    const root = mkdtempSync(join(tempDir("audit-len-ab-"), "x-"));
    for (const arm of ["a", "b"]) build(join(root, "arms", arm, "measure"));
    auditCommand(root, { out: () => undefined });
    const json = JSON.parse(readFileSync(join(root, "length.json"), "utf8")) as { records: Array<{ arm: string }> };
    assert.deepEqual(json.records.map((r) => r.arm), ["a", "a", "b", "b"]);
    assert.equal((readFileSync(join(root, "audit.md"), "utf8").match(/^### Length$/gm) ?? []).length, 2);
  });
});
