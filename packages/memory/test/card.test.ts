import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, type AttemptOutcome, Journal, newId } from "@seshat/core";
import { acceptedLemmas, MemoryStore, recordAcceptedLemmas, stateCard } from "../src/index.ts";

function open(): { memory: MemoryStore; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "mh-card-"));
  const journal = Journal.open(dir, "run_1");
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }), journal };
}

function attempt(journal: Journal, claimId: string, t: { strategy?: string; outcome: AttemptOutcome; failureClass?: string; failureDetail?: string }): string {
  const attemptId = newId("att");
  journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: 1, model: "test/model" }, "prover:p1");
  journal.emit(
    "attempt.finished",
    {
      attemptId, outcome: t.outcome, usd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, turns: 1,
      ...(t.failureClass !== undefined ? { failureClass: t.failureClass } : {}),
      ...(t.strategy !== undefined ? { strategy: t.strategy } : {}),
      ...(t.failureDetail !== undefined ? { failureDetail: t.failureDetail } : {}),
    },
    "prover:p1",
  );
  return attemptId;
}

const FAIL = { strategy: "induction", outcome: "invalid", failureClass: "unsolved_goals", failureDetail: "unsolved goals at case succ" } as const;

describe("the state card", () => {
  it("lists the goal, the holes, the accepted lemmas, the failures with counts and the timeouts, in that order", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const hole = await memory.ensureClaim({ statement: "(m : ℕ) : 0 + m = m", origin: "test" });
    memory.addEdge({ kind: "decomposes_into", from: claimId, to: [hole.claimId] });
    attempt(journal, claimId, FAIL);
    attempt(journal, claimId, FAIL);
    attempt(journal, claimId, { strategy: "automation", outcome: "invalid", failureClass: "tactic_failed", failureDetail: "omega failed" });
    attempt(journal, claimId, { strategy: "automation", outcome: "invalid", failureClass: "timeout", failureDetail: "Lean time limit" });
    attempt(journal, claimId, { strategy: "automation", outcome: "invalid", failureClass: "timeout", failureDetail: "Lean time limit" });
    attempt(journal, claimId, { outcome: "aborted" });
    const id = attempt(journal, claimId, { outcome: "no_submission" });
    recordAcceptedLemmas(memory, claimId, id, {
      leanStatus: "lean_error",
      checked: "theorem aux_a : True := trivial\n\ntheorem aux_b : False := by\n  sorry\n\ntheorem main : True := by\n  trivial",
      messages: [{ severity: "warning", text: "declaration uses 'sorry'", pos: { line: 3, column: 0 } }] as never,
      sorries: [],
    });
    const card = stateCard(memory, claimId) as string;
    const lines = card.split("\n");
    assert.match(lines[1] as string, /^Goal: statement st0_\w+, status open\.$/);
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/^Holes \(1\)/) > 1 && at(/^- \(m : ℕ\) : 0 \+ m = m \[open\]$/) === at(/^Holes/) + 1);
    assert.ok(at(/^Lemmas Lean accepted: aux_a, main?/) < 0, "only aux_ lemmas, and only the accepted ones");
    assert.ok(at(/^Lemmas Lean accepted: aux_a\.$/) > at(/^Holes/));
    assert.ok(at(/^- 2 x induction \/ unsolved_goals \/ unsolved goals at case succ$/) > at(/^Lemmas/));
    assert.ok(at(/^- 1 x automation \/ tactic_failed \/ omega failed$/) > at(/^- 2 x induction/));
    assert.equal(lines.at(-1), "Timeouts: 2.");
    assert.equal(card, stateCard(memory, claimId), "the same journal gives the same card");
  });

  it("cuts the least frequent approaches first within its bound, and says how many", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    for (let k = 0; k < 40; k++) for (let j = 0; j <= k % 5; j++) attempt(journal, claimId, { ...FAIL, failureDetail: `unknown identifier Nat.thing${k}` , failureClass: "unknown_identifier" });
    const card = stateCard(memory, claimId, { maxChars: 1000 }) as string;
    assert.ok(card.length <= 1000);
    assert.match(card, /- \d+ less frequent failed approaches not shown/);
    const shown = card.split("\n").filter((l) => /^- \d+ x /.test(l));
    const counts = shown.map((l) => Number(/^- (\d+)/.exec(l)?.[1]));
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    assert.ok(stateCard(memory, claimId, { maxChars: 200 })!.length <= 200);
  });

  it("is a card for a claim nothing was tried on, and nothing for an unknown claim", async () => {
    const { memory } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    assert.match(stateCard(memory, claimId) as string, /No session has checked a file on it yet\./);
    assert.equal(stateCard(memory, "clm_unknown"), undefined);
  });

  it("reads the accepted lemmas from a check's report", () => {
    const base = { checked: "theorem aux_a : True := trivial\ntheorem aux_b : False := by\n  exact bad\ntheorem t : True := trivial", sorries: [] as never };
    const error = { severity: "error", text: "boom", pos: { line: 3, column: 2 } } as never;
    assert.deepEqual(acceptedLemmas({ ...base, leanStatus: "lean_error", messages: [error] }), ["aux_a"]);
    assert.deepEqual(acceptedLemmas({ ...base, leanStatus: "timeout", messages: [] }), []);
    assert.deepEqual(acceptedLemmas({ ...base, leanStatus: undefined as never, messages: [] }), []);
  });
});
