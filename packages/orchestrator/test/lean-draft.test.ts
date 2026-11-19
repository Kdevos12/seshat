import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AUX_BEGIN, AUX_END, dedent, Journal, newId, PROOF_BEGIN, PROOF_END, statementIdV0, type ValidationReport } from "@seshat/core";
import { gateSettings } from "@seshat/scheduler";
import { BudgetGate, Ledger } from "../src/index.ts";
import { cutAtFirstBreak, DEFAULT_DRAFT_RESUMES, DEFAULT_DRAFT_TOKENS, DRAFT_MODE, checkLeanDraft, leanBlock } from "../src/lean-draft.ts";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, proofOf, say } from "./m0-helpers.ts";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";

/** The simulated Lean of these tests: `bad` is an error on its line, `sorry` a hole with a goal, `finish` closes the file, and anything else leaves a goal. */
function answer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  const lines = code.split("\n");
  const begin = lines.findIndex((l) => l.trim() === PROOF_BEGIN.trim());
  const at = (needle: string) => lines.findIndex((l, k) => k > begin && l.includes(needle)) + 1;
  if (proof.includes("bad")) return { messages: [{ severity: "error", pos: { line: at("bad"), column: 2 }, text: "unknown identifier 'bad'" }] };
  if (proof.includes("sorry")) return { axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: at("sorry"), column: 2 }, goal: "n : ℕ\n⊢ n + 0 = n" }] };
  if (proof.includes("finish")) return {};
  return { messages: [{ severity: "error", pos: { line: begin, column: 0 }, text: "unsolved goals\nn : ℕ\n⊢ n + 0 = n" }] };
}

/** A reply of the model: a lean block. */
const lean = (text: string) => say(`\`\`\`lean\n${text}\n\`\`\``);
const GATE = { floor: 0 };
const base = { provers: 1, sessions: 2, seed: "draft", budget: { problemUsd: 1 }, gate: GATE };
const attempts = (events: Parameters<typeof ofType>[0]) => ofType(events, "attempt.started").map((e) => e.data);

describe("leanDraft off: the run is what it was", () => {
  it("starts no draft: the probe's prover is the only attempt, and no event carries the mode", async () => {
    const { events } = await demoRun({ responses: [check("bad"), say("notes")], config: base });
    assert.deepEqual(attempts(events).map((a) => a.prover), ["p1"]);
    assert.ok(attempts(events).every((a) => a.settings === undefined));
    assert.equal(JSON.stringify(events).includes(DRAFT_MODE), false);
  });
});

describe("a draft that checks clean", () => {
  it("is a candidate through validate, as a prover's is, and no session of the probe starts", async () => {
    const { events, result, faux } = await demoRun({ responses: [lean("finish")], lean: new DemoLean(answer), config: { ...base, leanDraft: {} } });
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft, ...others] = attempts(events);
    assert.deepEqual([draft?.prover, others.length], ["draft", 0]);
    assert.equal(draft?.settings?.mode, "lean_draft");
    assert.equal(draft?.settings?.thinking, "off");
    assert.match(String(draft?.settings?.promptVersion), /^cl-/);
    const valid = ofType(events, "validation.finished").filter((e) => e.data.verdict === "valid");
    assert.equal(valid.length, 1);
    assert.equal(valid[0]?.data.attemptId, draft?.attemptId);
    assert.equal(valid[0]?.data.method, "repl");
    assert.deepEqual(ofType(events, "claim.status_changed").map((e) => e.data.to), ["computed"]);
    const [finished] = ofType(events, "attempt.finished");
    assert.deepEqual([finished?.data.outcome, finished?.data.stoppedBy, finished?.data.checks], ["valid", "solved", 1]);
    assert.equal(ofType(events, "attempt.charged").length, 1);
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(result.problems[0]?.attempts, 1);
    // Its checks are tool runs of its attempt.
    assert.ok(ofType(events, "tool_run.started").some((e) => e.data.attemptId === draft?.attemptId));
  });
});

describe("a draft with an error", () => {
  const DRAFT = "have h_1 : n + 0 = n := by simp\nbad\nexact h_1";

  it("is cut at the first error, the goal of the sorry is read, one continuation is asked, and the attempt says lean_draft", async () => {
    const prompts: string[] = [];
    const lean_ = new DemoLean(answer);
    const { events, faux, result } = await demoRun({
      responses: [lean(DRAFT), ((context: { messages: Array<{ role: string; content: unknown }> }) => { prompts.push(JSON.stringify(context.messages)); return lean("finish"); }) as never],
      lean: lean_,
      config: { ...base, leanDraft: {} },
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    const files = lean_.calls.map((c) => proofOf(c.code)).filter((p): p is string => p !== undefined).map(dedent);
    // The draft, the cut file (the steps before the error and a sorry), the continuation joined to the steps.
    assert.deepEqual(files.map((f) => f.trim()), [DRAFT, "have h_1 : n + 0 = n := by simp\nsorry", "have h_1 : n + 0 = n := by simp\nfinish"]);
    // The continuation was asked from the verified prefix and the goal Lean read.
    assert.match(prompts[0] ?? "", /have h_1 : n \+ 0 = n := by simp/);
    assert.match(prompts[0] ?? "", /⊢ n \+ 0 = n/);
    assert.deepEqual(attempts(events).map((a) => a.settings?.mode), ["lean_draft"]);
    const [finished] = ofType(events, "attempt.finished");
    assert.deepEqual([finished?.data.outcome, finished?.data.checks, finished?.data.turns], ["valid", 3, 2]);
    assert.equal(ofType(events, "attempt.charged").length, 2);
    // The cut file is no validation (a file with a hole is not one): the draft's check, which failed, and the whole file that passed are.
    assert.deepEqual(ofType(events, "validation.finished").map((e) => e.data.verdict), ["invalid", "valid"]);
    assert.equal(result.problems[0]?.outcome, "candidate");
  });

  it("asks no continuation when resumes is 0, and the probe runs as it would have", async () => {
    const lean_ = new DemoLean(answer);
    const { events, faux } = await demoRun({ responses: [lean(DRAFT), check("bad"), say("notes")], lean: lean_, config: { ...base, leanDraft: { resumes: 0 } } });
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft, probe] = ofType(events, "attempt.finished");
    assert.deepEqual([draft?.data.outcome, draft?.data.failureClass !== undefined, draft?.data.checks, draft?.data.turns], ["invalid", true, 1, 1]);
    assert.deepEqual(attempts(events).map((a) => a.prover), ["draft", "p1"]);
    assert.equal(probe?.data.outcome, "invalid");
    // With no continuation and no battery, the cut file is not even checked.
    assert.equal(lean_.calls.filter((c) => proofOf(c.code)?.trim() === "sorry").length, 0);
  });

  it("is cut at the first error, whatever comes after it: a draft whose first step breaks keeps none and continues from the theorem's goal", async () => {
    const { events } = await demoRun({ responses: [lean("bad\nexact h_1"), lean("finish")], lean: new DemoLean(answer), config: { ...base, leanDraft: {} } });
    assert.equal(ofType(events, "attempt.finished")[0]?.data.outcome, "valid");
  });

  it("goes on to the probe when the continuation fails too, the attempt failed with what it got", async () => {
    const { events } = await demoRun({ responses: [lean(DRAFT), lean("bad"), check("bad"), say("notes")], lean: new DemoLean(answer), config: { ...base, leanDraft: {} } });
    assert.deepEqual(ofType(events, "attempt.finished").map((e) => e.data.outcome), ["invalid", "invalid"]);
    assert.deepEqual(attempts(events).map((a) => a.prover), ["draft", "p1"]);
  });

  it("runs the sorry battery on the sorry left, when the run has it: no second battery", async () => {
    const { events } = await demoRun({ responses: [lean(DRAFT), lean("bad")], lean: new DemoLean(answer), config: { ...base, sessions: 1, leanDraft: {}, sorryBattery: {} } });
    const batteries = ofType(events, "node.recorded").filter((e) => e.data.kind === "sorry_battery");
    assert.equal(batteries.length, 1);
    assert.equal((batteries[0]?.data.data as { attemptId?: string }).attemptId, attempts(events)[0]?.attemptId);
  });
});

describe("the draft's cost", () => {
  it("is charged to the probe's ledger: the cap of the probe covers the draft and the session", async () => {
    // At this price the draft alone passes the probe's cap (a tenth of $1): the probe's ledger is spent before its session, which never starts.
    const { events } = await demoRun({ responses: [lean("bad")], pricePerMillion: 5000, lean: new DemoLean(answer), config: { ...base, leanDraft: { resumes: 0 } } });
    const [draft] = ofType(events, "attempt.finished");
    assert.ok((draft?.data.usd ?? 0) >= 0.1, `the draft cost ${String(draft?.data.usd)}`);
    assert.deepEqual(attempts(events).map((a) => a.prover), ["draft"]);
  });
});

describe("the draft's cost after an interruption", () => {
  it("stays in the problem's spend: a resumed run seeds its ledger with it and asks no second draft", async () => {
    const whole = await demoRun({ responses: [lean("bad"), check("bad"), say("notes")], pricePerMillion: 60, lean: new DemoLean(answer), config: { ...base, leanDraft: { resumes: 0 } } });
    const draftCost = ofType(whole.events, "attempt.finished")[0]?.data.usd ?? 0;
    assert.ok(draftCost > 0);
    // Cut right after the draft's end: the probe has not started.
    const at = whole.events.findIndex((e) => e.type === "attempt.finished");
    const resumed = await demoResume({ dir: killedAt(whole.dir, at + 1), bench: whole.bench, pricePerMillion: 60, lean: new DemoLean(answer), responses: [check("bad"), say("notes")] });
    assert.deepEqual(attempts(resumed.events).map((a) => a.prover), ["draft", "p1"], "no second draft");
    const spent = ofType(resumed.events, "attempt.finished").reduce((sum, a) => sum + (a.data.usd ?? 0), 0);
    assert.ok(Math.abs((resumed.result.problems[0]?.usd ?? NaN) - spent) < 1e-9, "the problem's spend counts the draft once");
  });
});

describe("the gate and the draft", () => {
  function gate(triage: "long" | "short" | undefined) {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-draft-")), "run_1");
    journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
    journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
    const g = new BudgetGate({
      settings: gateSettings({ floor: 0 }), journal, problemId: "P1", claimId: "clm_1", ledger: new Ledger(5).child(5), seed: "unit", rung: () => 0, attemptIds: () => [],
      ...(triage !== undefined ? { triage: () => ({ class: triage, reasons: ["r"] }) } : {}), log: () => {},
    });
    return { journal, g };
  }

  it("knows a problem the triage called long, which gets no draft", () => {
    for (const [triage, expected] of [["long", true], ["short", false], [undefined, false]] as const) {
      const { journal, g } = gate(triage);
      try {
        assert.equal(g.long, expected);
      } finally {
        journal.close();
      }
    }
  });

  it("counts the draft in what the probe has spent, with the attempts of its task", () => {
    const { journal, g } = gate(undefined);
    try {
      const done = (prover: string, usd: number, taskId?: string) => {
        const attemptId = newId("att");
        journal.emit("attempt.started", { attemptId, claimId: "clm_1", prover, iteration: 1, model: "m", ...(taskId !== undefined ? { taskId } : {}) }, `prover:${prover}`);
        journal.emit("attempt.finished", { attemptId, outcome: "invalid", usd, inputTokens: 0, outputTokens: 0, durationMs: 1, turns: 1 }, `prover:${prover}`);
      };
      journal.emit("task.created", { taskId: "tsk_1", kind: "prove", problemId: "P1", claimId: "clm_1", dependsOn: [], owner: "prover:p1", acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" }, budget: { usd: 1 } }, "orchestrator");
      for (const [from, to] of [["pending", "ready"], ["ready", "running"]]) journal.emit("task.status_changed", { taskId: "tsk_1", from, to, reason: "test" } as never, "orchestrator");
      done("draft", 0.25);
      done("p1", 0.5, "tsk_1");
      assert.equal(g.probeSpentUsd("tsk_1"), 0.75);
      assert.equal(g.probeSpentUsd("tsk_2"), 0.25);
    } finally {
      journal.close();
    }
  });

  it("does not count a draft as a session in the price of one", () => {
    const { journal, g } = gate(undefined);
    try {
      const done = (prover: string, usd: number, settings?: Record<string, string>) => {
        const attemptId = newId("att");
        journal.emit("attempt.started", { attemptId, claimId: "clm_1", prover, iteration: 1, model: "m", ...(settings !== undefined ? { settings } : {}) }, `prover:${prover}`);
        journal.emit("attempt.finished", { attemptId, outcome: "invalid", usd, inputTokens: 0, outputTokens: 0, durationMs: 1, turns: 1 }, `prover:${prover}`);
      };
      done("draft", 0.001, { mode: "lean_draft" });
      done("p1", 0.05);
      assert.equal(g.sessionUsd(), 0.05);
    } finally {
      journal.close();
    }
  });
});

describe("the cut", () => {
  const report = (proof: string, errorLines: number[], sorryLines: number[] = []): ValidationReport => {
    const checked = `${AUX_BEGIN}\n${AUX_END}\ntheorem t : True := by\n  ${PROOF_BEGIN}\n${proof.split("\n").map((l) => `  ${l}`).join("\n")}\n  ${PROOF_END}\n`;
    // Lean's lines are those of the file: the proof starts at line 5.
    return {
      verdict: "invalid", method: "repl", reasons: [], axioms: [], checked, submissionHash: "h", editsOutsideRegions: false, holes: sorryLines.length > 0,
      messages: errorLines.map((line) => ({ severity: "error" as const, pos: { line: line + 4, column: 0 }, text: "e" })),
      sorries: sorryLines.map((line) => ({ pos: { line: line + 4, column: 0 }, goal: "g" })),
    };
  };
  const PROOF = "have h_1 : a := by\n  simp\n-- next\nhave h_2 : b := by\n  simp\n  bad\ncalc x = y := by rfl\n  _ = z := by rfl\nexact h_2";

  it("keeps the complete steps before the step that holds the first error, and replaces the rest by sorry", () => {
    assert.deepEqual(cutAtFirstBreak(report(PROOF, [6])), { steps: "have h_1 : a := by\n  simp", proof: "have h_1 : a := by\n  simp\nsorry" });
    assert.equal(cutAtFirstBreak(report(PROOF, [8]))?.steps.endsWith("  bad"), true);
    // The error in the second line of a calc cuts the whole calc.
    assert.equal(cutAtFirstBreak(report(PROOF, [8]))?.steps.includes("calc"), false);
  });

  it("cuts at a sorry as at an error, and at the first of several breaks", () => {
    assert.equal(cutAtFirstBreak(report(PROOF, [8], [4]))?.steps, "have h_1 : a := by\n  simp");
  });

  it("cuts a draft whose first step breaks down to a lone sorry, and keeps every step when Lean puts the error outside the proof", () => {
    assert.deepEqual(cutAtFirstBreak(report(PROOF, [1])), { steps: "", proof: "sorry" });
    const outside = report(PROOF, []);
    outside.messages.push({ severity: "error", pos: { line: 1, column: 0 }, text: "unsolved goals" });
    assert.equal(cutAtFirstBreak(outside)?.steps, PROOF);
  });

  it("says nothing when Lean named no error and no sorry", () => {
    assert.equal(cutAtFirstBreak(report(PROOF, [])), undefined);
  });
});

describe("the reply", () => {
  it("is the first lean block, an open block read to its end, or the whole reply when it has none", () => {
    assert.equal(leanBlock("Here:\n```lean\nsimp\nlinarith\n```\nDone."), "simp\nlinarith");
    assert.equal(leanBlock("```lean4\nomega"), "omega");
    assert.equal(leanBlock("omega"), "omega");
    assert.equal(leanBlock("```lean\n\n```"), undefined);
  });

  it("has defaults and refuses what is not a count", () => {
    assert.deepEqual([DEFAULT_DRAFT_TOKENS, DEFAULT_DRAFT_RESUMES], [1024, 1]);
    assert.deepEqual(checkLeanDraft({}), []);
    assert.deepEqual(checkLeanDraft({ resumes: 0 }), []);
    assert.equal(checkLeanDraft({ maxOutputTokens: 0 }).length, 1);
    assert.equal(checkLeanDraft({ resumes: 1.5 }).length, 1);
  });
});
