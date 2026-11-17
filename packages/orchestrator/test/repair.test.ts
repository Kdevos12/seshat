import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END } from "@seshat/core";
import { createM12Line, cutFailures } from "@seshat/scheduler";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { check, DemoLean, demoRun, ofType, proofOf, say } from "./m0-helpers.ts";
import { blueprintAnswer } from "./blueprint-helpers.ts";

const nodes = (events: readonly HarnessEvent[], kind: string) =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => {
    const patches = ofType(events, "node.updated").filter((u) => u.data.nodeId === e.data.nodeId).map((u) => u.data.patch as Record<string, unknown>);
    return { nodeId: e.data.nodeId, claimId: e.data.claimId, ...(e.data.data as Record<string, unknown>), ...Object.assign({}, ...patches) } as Record<string, unknown> & { nodeId: string };
  });
const statusOf = (events: readonly HarnessEvent[], claimId: unknown) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === claimId).map((e) => e.data.to);

/**
 * The simulated Lean of these tests: a line with `bad` in the AUX or PROOF region is an error at the `bad` (a statement's too, when `bad` is
 * before its `:=`); a file with none is what the blueprint tests' Lean says.
 */
function repairAnswer(code: string): FakeLeanAnswer {
  if (proofOf(code) === undefined) return {};
  const lines = code.split("\n");
  const begin = lines.findIndex((l) => l.trim() === AUX_BEGIN.trim());
  const messages: NonNullable<FakeLeanAnswer["messages"]> = [];
  lines.forEach((line, k) => {
    const column = line.indexOf("bad");
    if (k > begin && column >= 0 && !line.includes("AUX") && !line.includes("PROOF")) messages.push({ severity: "error", pos: { line: k + 1, column }, text: "unsolved goals" });
  });
  return messages.length > 0 ? { messages } : blueprintAnswer(code);
}

const OPTIONS = { blueprints: true, repair: true, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0 };

async function run(responses: Parameters<typeof demoRun>[0]["responses"], options: Record<string, unknown> = {}, sessions = 1) {
  return await demoRun({
    lines: { M12: createM12Line() },
    config: { lines: ["M12"], provers: 1, sessions, lineOptions: { M12: { ...OPTIONS, ...options } } },
    lean: new DemoLean(repairAnswer),
    responses,
  });
}

const TWO_FAILING = `lemma aux_one (n : ℕ) : n * 1 = n := by
  bad_tactic

lemma aux_two (n : ℕ) : n + 2 = 2 + n := by
  bad_tactic`;

describe("the repair pass (CA13)", () => {
  it("a file with two failing AUX lemmas becomes a blueprint with two holes, and the battery proves one", { timeout: 60000 }, async () => {
    const { events, faux } = await run([check("exact main_ok aux_one aux_two", TWO_FAILING), say("Done."), say("I cannot do this.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const attempt = ofType(events, "attempt.finished")[0];
    const sketches = nodes(events, "m12_sketch");
    assert.equal(sketches.length, 1, "the prover's file has no hole: only the repair is a sketch");
    const [repair] = sketches;
    assert.equal(repair?.repairOf, attempt?.data.attemptId);
    assert.equal(repair?.healthy, true);
    assert.deepEqual(repair?.names, ["aux_one", "aux_two"]);
    assert.equal(repair?.registered, true);
    // The pre-flight: the battery proves aux_one before any session; aux_two gets its session and it is not proved.
    const [one, two] = repair?.holes as string[];
    assert.deepEqual(statusOf(events, one), ["computed"]);
    assert.deepEqual(statusOf(events, two), []);
    assert.equal(nodes(events, "m12_session").length, 1);
    assert.equal(ofType(events, "model_call.finished").filter((m) => m.actor === "line:M12").length, 1, "only the session on aux_two called a model");
  });

  it("a failing have of the main proof that mentions only the theorem's binders becomes a hole", { timeout: 60000 }, async () => {
    const { events, faux } = await run([check("have h : n + 2 = 2 + n := by\n  bad_tactic\nexact main_ok h", ""), say("Done."), say("I cannot do this.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [repair, ...more] = nodes(events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(repair?.healthy, true);
    assert.deepEqual(repair?.names, ["aux_h"]);
    assert.equal(ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && (e.data.gloss ?? "").startsWith("aux_h,")).length, 1);
  });

  it("an error in a statement gives no repair", { timeout: 60000 }, async () => {
    const { events } = await run([check("exact main_ok aux_s", "lemma aux_s (n : ℕ) : bad n = n := by\n  trivial"), say("Done.")]);
    assert.equal(nodes(events, "m12_sketch").length, 0);
  });

  it("repairs at most maxRepairs times for a problem", { timeout: 60000 }, async () => {
    const second = "lemma aux_three (n : ℕ) : n * 1 = n := by\n  bad_tactic";
    const responses = [check("exact main_ok aux_one aux_two", TWO_FAILING), say("Done."), check("exact main_ok aux_three", second), say("Done.")];
    const capped = await run(responses, { maxRepairs: 1, maxInnerTasks: 0 }, 2);
    assert.equal(nodes(capped.events, "m12_sketch").length, 1);
    const free = await run(
      [check("exact main_ok aux_one aux_two", TWO_FAILING), say("Done."), check("exact main_ok aux_three", second), say("Done.")],
      { maxRepairs: 2, maxInnerTasks: 0 },
      2,
    );
    assert.equal(nodes(free.events, "m12_sketch").length, 2);
  });

  it("changes nothing without the option repair", { timeout: 60000 }, async () => {
    const { events } = await run([check("exact main_ok aux_one aux_two", TWO_FAILING), say("Done.")], { repair: false });
    assert.equal(nodes(events, "m12_sketch").length, 0);
  });
});

describe("cutFailures", () => {
  const file = (aux: string, proof: string) => [`import X`, AUX_BEGIN, aux, AUX_END, "theorem target (n : ℕ) : n + 0 = n := by", PROOF_BEGIN, proof, PROOF_END].join("\n");
  const at = (checked: string, needle: string) => ({ severity: "error" as const, pos: { line: checked.split("\n").findIndex((l) => l.includes(needle)) + 1, column: 2 }, text: "e" });
  const target = "(n : ℕ) : n + 0 = n";

  it("cuts a lemma's proof and keeps its statement", () => {
    const checked = file("lemma aux_a (n : ℕ) : n = n := by\n  bad", "exact main_ok aux_a");
    const cut = cutFailures({ checked, messages: [at(checked, "bad")], target });
    assert.ok(!("reason" in cut));
    assert.equal(cut.aux, "lemma aux_a (n : ℕ) : n = n := by\n  sorry");
    assert.equal(cut.proof, "exact main_ok aux_a");
  });

  it("lifts a have with a term proof, over several lines, and keeps the rest", () => {
    const checked = file("", "have h : n = n :=\n  bad\nexact main_ok h");
    const cut = cutFailures({ checked, messages: [at(checked, "bad")], target });
    assert.ok(!("reason" in cut));
    assert.equal(cut.aux, "lemma aux_h (n : ℕ) : n = n := by\n  sorry");
    assert.equal(cut.proof, "have h : n = n := aux_h n\nexact main_ok h");
  });

  it("refuses a have whose statement mentions what the proof bound before, an error outside a have, and a nested have", () => {
    let checked = file("", "intro k\nhave h : k = k := by\n  bad\nexact main_ok h");
    assert.match(String((cutFailures({ checked, messages: [at(checked, "bad")], target }) as { reason: string }).reason), /mentions k/);
    checked = file("", "have h : n = n := by\n  rfl\nexact bad");
    assert.match(String((cutFailures({ checked, messages: [at(checked, "bad")], target }) as { reason: string }).reason), /outside a top-level have/);
    checked = file("", "induction n with\n| zero => rfl\n| succ k ih =>\n  have h : k = k := by\n    bad\n  exact main_ok h");
    assert.match(String((cutFailures({ checked, messages: [at(checked, "bad")], target }) as { reason: string }).reason), /outside a top-level have/);
  });

  it("refuses an error in the fixed part and a declaration that is not an aux_ lemma", () => {
    const checked = file("lemma helper (n : ℕ) : n = n := by\n  bad", "exact main_ok");
    assert.match(String((cutFailures({ checked, messages: [at(checked, "bad")], target }) as { reason: string }).reason), /not an aux_ lemma/);
    assert.match(String((cutFailures({ checked, messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "e" }], target }) as { reason: string }).reason), /fixed part/);
  });
});
