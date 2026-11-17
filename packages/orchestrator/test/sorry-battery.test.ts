import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_EXTRA_TACTICS } from "@seshat/classical";
import { type HarnessEvent, type LeanCheckResult, type LeanChecker, type LeanSnippet, type Submission, type ValidationReport } from "@seshat/core";
import { Ledger } from "../src/budget.ts";
import { armConfig } from "../src/ablation.ts";
import { experimentArms } from "../src/experiments.ts";
import { DEFAULT_CONFIG, type RunConfig } from "../src/index.ts";
import type { Workbench } from "../src/problem.ts";
import { runSession } from "../src/session.ts";
import { closeSorries, findSorries, renderSorryBatteryTally, type SorryBatteryRecord, sorryBatteryTally } from "../src/sorry-battery.ts";
import { check, fauxModels, say } from "./m0-helpers.ts";

/** A simulated Lean for files `P:<proof>`: `omega` closes a `sorry` that follows `A`, nothing else does; the file's `sorry` are its holes. */
const render = (s: Submission) => `P:${s.proof}`;
class FakeLean implements LeanChecker {
  readonly implementation = "fake";
  readonly version = "0";
  readonly files: string[] = [];
  private readonly fails: (code: string) => boolean;
  /** `fails`: files that fail whatever they hold (a combined file). */
  constructor(fails: (code: string) => boolean = () => false) {
    this.fails = fails;
  }
  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    return snippets.map((s) => {
      this.files.push(s.code);
      const proof = s.code.slice(2);
      // A line "A <tactic>" is closed by omega or by a combinator that has it; "B sorry" never is.
      const holes = (proof.match(/sorry/g) ?? []).length;
      const bad = this.fails(s.code) || /(^|\n)A (?!omega|\(first|sorry)/.test(proof) || /(^|\n)B (?!sorry)/.test(proof);
      const sorries = Array.from({ length: holes }, (_, i) => ({ pos: { line: i + 1, column: 0 }, goal: "⊢ g" }));
      if (bad) return { id: s.id, status: "lean_error", messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "unsolved goals" }], sorries: [], timeMs: 1 };
      return { id: s.id, status: holes > 0 ? "sorry" : "valid", messages: [], sorries, timeMs: 1 };
    });
  }
}

const report = (n: number, over: Partial<ValidationReport> = {}): ValidationReport => ({
  verdict: "invalid", method: "repl", reasons: [], axioms: [], messages: [], sorries: Array.from({ length: n }, () => ({ pos: { line: 1, column: 0 }, goal: "⊢ g" })),
  checked: "", submissionHash: "h", editsOutsideRegions: false, holes: n > 0, leanStatus: "sorry", ...over,
});
const deps = (lean: LeanChecker, extra: { maxSorries?: number } = {}, record?: (d: SorryBatteryRecord) => void) => ({ checker: lean, render, host: NO_EXTRA_TACTICS, config: extra, ...(record ? { record } : {}) });
const two: Submission = { aux: "", proof: "A sorry\nB sorry" };

describe("the battery on a session's sorry", () => {
  it("finds the sorry outside comments", () => {
    const found = findSorries({ aux: "-- sorry\n", proof: "a\n/- sorry -/ sorry\n  b -- sorry" });
    assert.deepEqual(found.map((f) => [f.region, f.line]), [["proof", 2]]);
  });

  it("closes the sorry omega closes and names it, leaves the other, and says so", async () => {
    const records: SorryBatteryRecord[] = [];
    const out = await closeSorries(deps(new FakeLean(), {}, (r) => records.push(r)), two, report(2));
    assert.deepEqual(out?.submission, { aux: "", proof: "A omega\nB sorry" });
    assert.match(out?.text ?? "", /^The harness closed 1 of 2 `sorry` with the classical battery \(no model call\): PROOF line 1: omega\. The file now reads as below; continue from it\./);
    assert.match(out?.text ?? "", /A omega\nB sorry/);
    assert.deepEqual(records.map((r) => [r.tried, r.closed, r.tactics]), [[2, 1, [{ region: "proof", line: 1, tactic: "omega" }]]]);
  });

  it("says it closed none, with one line", async () => {
    const out = await closeSorries(deps(new FakeLean()), { aux: "", proof: "B sorry" }, report(1));
    assert.equal(out?.text, "The harness tried the classical battery on 1 `sorry` and closed none.");
    assert.equal(out?.submission, undefined);
  });

  it("falls back to the replacements that pass one by one when the combined file fails", async () => {
    const both = { aux: "", proof: "A sorry\nA sorry" };
    const lean = new FakeLean((code) => code === "P:A omega\nA omega");
    const out = await closeSorries(deps(lean), both, report(2));
    assert.deepEqual(out?.submission, { aux: "", proof: "A omega\nA sorry" });
    assert.match(out?.text ?? "", /closed 1 of 2/);
  });

  it("runs nothing for a file without sorry, an erroring file, or an aborted session", async () => {
    const lean = new FakeLean();
    assert.equal(await closeSorries(deps(lean), { aux: "", proof: "A omega" }, report(0)), undefined);
    assert.equal(await closeSorries(deps(lean), two, report(2, { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "boom" }] })), undefined);
    const stop = new AbortController();
    stop.abort();
    assert.equal(await closeSorries(deps(lean), two, report(2), stop.signal), undefined);
    assert.equal(lean.files.length, 0);
  });

  it("tries at most maxSorries", async () => {
    const lean = new FakeLean();
    const out = await closeSorries(deps(lean, { maxSorries: 1 }), { aux: "", proof: "B sorry\nA sorry" }, report(2));
    assert.match(out?.text ?? "", /tried the classical battery on 1 `sorry` and closed none/);
    assert.equal(lean.files.length, 1);
  });
});

describe("in a session", () => {
  const run = async (battery: boolean) => {
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("A sorry\nB sorry"), say("Notes.")]);
    const lean = new FakeLean();
    const workbench = { check: async (s: Submission) => ({ report: report(2, { checked: render(s) }), accepted: false }) } as unknown as Workbench;
    const result = await runSession({
      models, model: faux.getModel(), thinkingLevel: "off", systemPrompt: "s", prompt: "p", workbench, attemptId: "att_x", actor: "prover:p1",
      limits: { turns: 10, contextTokens: 100_000 }, ledger: new Ledger(), signal: new AbortController().signal, wrapUp: false,
      ...(battery ? { sorryBattery: (sub: Submission, rep: ValidationReport, sig?: AbortSignal) => closeSorries(deps(lean), sub, rep, sig) } : {}),
    });
    const answers = result.messages.flatMap((m) => ("role" in m && m.role === "toolResult" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []));
    return { result, answers, calls: lean.files.length };
  };

  it("adds the answer after Lean's own and continues from the new file", async () => {
    const { result, answers } = await run(true);
    assert.match(answers[0] ?? "", /Checked the sketch[\s\S]*The harness closed 1 of 2 `sorry`/);
    assert.deepEqual(result.submission, { aux: "", proof: "A omega\nB sorry" });
  });

  it("with the setting off sends the answer it always did and runs no battery", async () => {
    const { result, answers, calls } = await run(false);
    assert.doesNotMatch(answers[0] ?? "", /harness/);
    assert.equal(calls, 0);
    assert.deepEqual(result.submission, { aux: "A".slice(0, 0), proof: "A sorry\nB sorry" });
  });
});

describe("the arm, the journal and the report", () => {
  it("defines solve-v2-cpu as solve-v2 plus sorryBattery, against solve-v2", () => {
    const arms = experimentArms("solve-defaults", { host: { capabilities: { "compute.sage": {}, "lean.search": {}, "lean.lsp": {} } } });
    const arm = arms.find((a) => a.name === "solve-v2-cpu") ?? assert.fail("no arm");
    const v2 = arms.find((a) => a.name === "solve-v2") ?? assert.fail("no v2");
    assert.equal(arm.versus, "solve-v2");
    const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } };
    const { sorryBattery, ...rest } = armConfig(base, arm);
    assert.deepEqual(sorryBattery, {});
    assert.deepEqual(rest, armConfig(base, v2));
    assert.equal("sorryBattery" in armConfig(base, v2), false);
  });

  it("tallies the attempts' nodes and prints the report line only when the setting was on or a node exists", () => {
    const started = (config: object) => ({ type: "run.started", data: { config } }) as unknown as HarnessEvent;
    const node = (tried: number, closed: number) => ({ type: "node.recorded", data: { nodeId: "n", kind: "sorry_battery", data: { tried, closed } } }) as unknown as HarnessEvent;
    assert.equal(sorryBatteryTally([started({})]), undefined);
    const tally = sorryBatteryTally([started({ sorryBattery: {} }), node(2, 1), node(3, 0)]);
    assert.deepEqual(tally, { attempts: 2, tried: 5, closed: 1 });
    assert.match(renderSorryBatteryTally(tally as never), /^sorry closed by the harness: 1 of 5/);
  });
});
