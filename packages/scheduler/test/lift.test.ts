import assert from "node:assert/strict";
import { test } from "node:test";
import type { Submission, ValidationReport } from "@seshat/core";
import { extractGoalMessages } from "../../core/test/fake-lean.ts";
import { haveSteps, liftHaves, readSketch, restatedStep, sorrySteps } from "../src/index.ts";

/** A check of the simulated Lean: it prints what `extract_goal` prints, and calls an `apply ... <;> assumption` an error when `applyFails` is set. */
function checker(options: { applyFails?: boolean; probeError?: string; hide?: boolean; timeoutTogether?: boolean } = {}) {
  const calls: Submission[] = [];
  const check = async (sub: Submission): Promise<ValidationReport> => {
    calls.push(sub);
    const code = `theorem target (n : ℕ) : n + 0 = n := by\n${sub.proof}`;
    const probing = sub.proof.includes("extract_goal");
    const messages: ValidationReport["messages"] = probing && options.hide !== true ? extractGoalMessages(code) : [];
    // Real problems: several extractions in one declaration run out of its heartbeats, and Lean prints no statement at all.
    if (options.timeoutTogether === true && (sub.proof.match(/extract_goal/g) ?? []).length > 1) {
      messages.length = 0;
      messages.push({ severity: "error", pos: { line: 1, column: 8 }, text: "(deterministic) timeout at `isDefEq`, maximum number of heartbeats (200000) has been reached" });
    }
    if (probing && options.probeError !== undefined) messages.push({ severity: "error", pos: { line: 2, column: 0 }, text: options.probeError });
    if (!probing && options.applyFails === true && sub.proof.includes("<;> assumption")) messages.push({ severity: "error", pos: { line: 2, column: 0 }, text: "apply failed" });
    return { verdict: "invalid", method: "repl", reasons: [], axioms: [], messages, sorries: [], checked: code, submissionHash: "h", editsOutsideRegions: false, holes: true, leanStatus: "sorry" };
  };
  return { check, calls };
}

const FOUR = `-- step 1: add zero
have h_1 : n + 0 = n := by sorry
-- step 2: multiply by one
have h_2 : n * 1 = n := by sorry
-- step 3: zero is a left identity
have h_3 : 0 + n = n := by sorry
-- step 4: commute
have h_4 : n + 0 = 0 + n := by sorry
exact h_1`;

/** The battery of the test: it closes the step named `h_2`. */
const closeH2 = async (sub: Submission): Promise<Submission> => ({ aux: sub.aux, proof: sub.proof.replace("have h_2 : n * 1 = n := by sorry", "have h_2 : n * 1 = n := by simp") });
const report = (await checker().check({ aux: "", proof: FOUR }));

test("haveSteps finds named steps at any depth and sorrySteps the ones whose proof is sorry", () => {
  const proof = "intro k\nhave a : k = k := by\n  sorry\ninduction k with\n| zero =>\n  have b : 0 = 0 := by simp\n  exact b\n| succ m ih => have c : m = m := sorry\nhave : k = k := by sorry\nhave d := rfl";
  assert.deepEqual(haveSteps(proof).map((s) => s.name), ["a", "b", "c"], "a have with no name or no type is not a step");
  assert.deepEqual(sorrySteps(proof).map((s) => s.name), ["a", "c"]);
  assert.equal(sorrySteps("-- have x : T := by sorry\nexact rfl").length, 0, "a comment is not a step");
});

test("a 4-step draft whose battery closes one step gives 3 holes, each with the earlier steps as hypotheses, and no -- uses:", async () => {
  const { check, calls } = checker();
  const lift = await liftHaves({ check, battery: closeH2 }, { aux: "", proof: FOUR, report });
  assert.ok(!("reason" in lift), "reason" in lift ? lift.reason : "");
  assert.equal(lift.closed, 1);
  assert.deepEqual(lift.lifted, ["aux_h_1", "aux_h_3", "aux_h_4"]);
  assert.equal(lift.aux, [
    "-- step 1: add zero\nlemma aux_h_1 (n : ℕ) : n + 0 = n := by\n  sorry",
    "-- step 3: zero is a left identity\nlemma aux_h_3 (n : ℕ) (h_1 : n + 0 = n) (h_2 : n * 1 = n) : 0 + n = n := by\n  sorry",
    "-- step 4: commute\nlemma aux_h_4 (n : ℕ) (h_1 : n + 0 = n) (h_2 : n * 1 = n) (h_3 : 0 + n = n) : n + 0 = 0 + n := by\n  sorry",
  ].join("\n\n"));
  assert.match(lift.proof, /-- step 3: zero is a left identity\nhave h_3 : 0 \+ n = n := by apply aux_h_3 <;> assumption\n/);
  assert.match(lift.proof, /have h_2 : n \* 1 = n := by simp/);
  assert.match(lift.proof, /exact h_1$/);
  assert.equal(calls.length, 2, "one check for the extraction, one for the lifted file");
  const reading = readSketch({ aux: lift.aux, proof: lift.proof }, { blueprint: true, target: "(n : ℕ) : n + 0 = n + 1" });
  assert.equal(reading.problem, undefined);
  assert.deepEqual(reading.holes.map((h) => [h.name, h.uses]), [["aux_h_1", []], ["aux_h_3", []], ["aux_h_4", []]]);
  assert.equal(lift.report?.messages.some((m) => m.severity === "error"), false);
});

test("a step inside a cases branch and one whose type mentions an intro'd variable are lifted", async () => {
  const proof = "intro k\nhave h_k : k + 0 = k := by sorry\ninduction n with\n| zero =>\n  have h_z : 0 + 0 = 0 := by sorry\n  exact h_z\n| succ m ih => have h_s : m + 1 + 0 = m + 1 := by sorry\n  exact h_s";
  const lift = await liftHaves({ check: checker().check }, { aux: "", proof });
  assert.ok(!("reason" in lift), "reason" in lift ? lift.reason : "");
  assert.deepEqual(lift.lifted, ["aux_h_k", "aux_h_z", "aux_h_s"]);
  assert.match(lift.aux, /lemma aux_h_k \(n : ℕ\) \(k : ℕ\) : k \+ 0 = k := by/);
  assert.match(lift.aux, /lemma aux_h_s \(n : ℕ\) \(k : ℕ\) \(h_k : k \+ 0 = k\) \(h_z : 0 \+ 0 = 0\) \(m : ℕ\) \(ih : ℕ\) : m \+ 1 \+ 0 = m \+ 1 := by/);
  assert.match(lift.proof, /\| zero =>\n {2}have h_z : 0 \+ 0 = 0 := by apply aux_h_z <;> assumption\n {2}exact h_z/);
  assert.match(lift.proof, /\| succ m ih => have h_s : m \+ 1 \+ 0 = m \+ 1 := by apply aux_h_s <;> assumption\n {2}exact h_s/);
});

test("a name that is taken gets a suffix, and a file with no step to lift comes back as it was, with no check", async () => {
  const taken = await liftHaves({ check: checker().check }, { aux: "lemma aux_h (n : ℕ) : n = n := by\n  rfl", proof: "have h : n + 0 = n := by sorry\nexact h" });
  assert.ok(!("reason" in taken));
  assert.deepEqual(taken.lifted, ["aux_h_2"]);
  const { check, calls } = checker();
  const none = await liftHaves({ check }, { aux: "", proof: "exact rfl" });
  assert.deepEqual(none, { aux: "", proof: "exact rfl", closed: 0, lifted: [] });
  assert.equal(calls.length, 0);
});

test("the explicit arguments are the fallback when apply fails, and kept only if they check better", async () => {
  const lift = await liftHaves({ check: checker({ applyFails: true }).check }, { aux: "", proof: "have h_1 : n + 0 = n := by sorry\nhave h_2 : 0 + n = n := by sorry\nexact h_1" });
  assert.ok(!("reason" in lift));
  assert.match(lift.proof, /have h_2 : 0 \+ n = n := aux_h_2 n h_1\n/);
  assert.equal(lift.report?.messages.length, 0);
});

test("a probe Lean refuses, or that prints too few statements, gives a reason and no lift", async () => {
  const refused = await liftHaves({ check: checker({ probeError: "unknown tactic extract_goal" }).check }, { aux: "", proof: "have h : n = n := by sorry\nexact h" });
  assert.match("reason" in refused ? refused.reason : "", /Lean refused extract_goal for h: unknown tactic/);
  const few = await liftHaves({ check: checker({ hide: true }).check }, { aux: "", proof: "have h : n = n := by sorry\nexact h" });
  assert.match("reason" in few ? few.reason : "", /printed 0 statement\(s\) for h/);
});

test("when the extractions together time out, each step is probed alone and the lift goes on (LP6's real run)", async () => {
  const { check, calls } = checker({ timeoutTogether: true });
  const lift = await liftHaves({ check }, { aux: "", proof: "have h_1 : n + 0 = n := by sorry\nhave h_2 : 0 + n = n := by sorry\nexact h_1" });
  assert.ok(!("reason" in lift), "reason" in lift ? lift.reason : "");
  assert.deepEqual(lift.lifted, ["aux_h_1", "aux_h_2"]);
  assert.match(lift.aux, /lemma aux_h_2 \(n : ℕ\) \(h_1 : n \+ 0 = n\) : 0 \+ n = n := by\n {2}sorry/);
  // Each probe runs extract_goal under printing options whose output Lean reads back (coercions with their types, no field notation, proofs in full, binders with their types).
  for (const option of ["pp.coercions.types", "pp.numericTypes", "pp.proofs", "pp.funBinderTypes", "pp.piBinderTypes"]) assert.ok(calls[0]?.proof.includes(`set_option ${option} true in`), option);
  assert.ok(calls[0]?.proof.includes("set_option pp.fieldNotation false in"));
  // One probe of both, one of each, then the lifted file.
  assert.equal(calls.filter((c) => c.proof.includes("extract_goal")).length, 3);
  assert.equal(calls.at(-1)?.proof.includes("extract_goal"), false);
  // A step that fails alone stops the lift, with its name.
  const stuck = await liftHaves({ check: checker({ timeoutTogether: true, probeError: "unknown tactic" }).check }, { aux: "", proof: "have h_1 : n + 0 = n := by sorry\nhave h_2 : 0 + n = n := by sorry\nexact h_1" });
  assert.match("reason" in stuck ? stuck.reason : "", /Lean refused extract_goal for h_1: unknown tactic/);
});

test("both forms Lean prints an extracted statement in are read: `:= sorry` (Lean 4.27) and `:= by sorry`", async () => {
  for (const tail of [":= sorry", ":= by\n  sorry"]) {
    const check = async (sub: Submission): Promise<ValidationReport> => {
      const probing = sub.proof.includes("extract_goal");
      const messages: ValidationReport["messages"] = probing ? [{ severity: "info", pos: { line: 2, column: 30 }, text: `theorem _example.extracted_1 (n : ℕ) : n = n ${tail}` }] : [];
      return { verdict: "invalid", method: "repl", reasons: [], axioms: [], messages, sorries: [], checked: "", submissionHash: "h", editsOutsideRegions: false, holes: true, leanStatus: "sorry" };
    };
    const lift = await liftHaves({ check }, { aux: "", proof: "have h : n = n := by sorry\nexact h" });
    assert.ok(!("reason" in lift), "reason" in lift ? lift.reason : "");
    assert.match(lift.aux, /lemma aux_h \(n : ℕ\) : n = n := by\n {2}sorry/);
  }
});

test("restatedStep: a step left to sorry whose type is the target's conclusion, spacing aside (VL1)", () => {
  const target = "(p : Polynomial ℝ) (hp : ∀ x, 0 ≤ p.eval x) : ∃ q r : Polynomial ℝ, p = q ^ 2 + r ^ 2";
  const proof = "have h_1 : p.degree ≥ 0 := by sorry\nhave h_2 : ∃ q r : Polynomial ℝ,\n    p = q ^ 2 + r ^ 2 := by sorry\nexact h_2";
  assert.equal(restatedStep(proof, target), "h_2");
  // A step that proves it (no sorry) is no hole, and a different statement is a step.
  assert.equal(restatedStep("have h_2 : ∃ q r : Polynomial ℝ, p = q ^ 2 + r ^ 2 := by exact foo\nexact h_2", target), undefined);
  assert.equal(restatedStep("have h_1 : p.degree ≥ 0 := by sorry\nexact bar", target), undefined);
});
