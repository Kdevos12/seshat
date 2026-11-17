import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, type HarnessEvent, sha256Hex } from "@seshat/core";
import { audit, auditCommand } from "../src/audit.ts";
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
    assert.match(text, /^## `hard` \(unsolved\)/m);
    assert.match(text, /lean_search x2, lean_check x1/);
    assert.match(text, /lemma aux_one/);
    assert.match(text, /planner rounds: 1; repairs: 1/);
    assert.match(text, /plausible no_counterexample/);
    assert.match(text, /\*\*Formal-cost triage\*\*: short \(computed from the journal now\): no informal proof was accepted/);
    assert.doesNotMatch(text, /`easy`/);
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
});
