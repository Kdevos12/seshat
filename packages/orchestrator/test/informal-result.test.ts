import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEvents } from "@seshat/core";
import { buildResult, renderResult, renderRunReport, writeReport } from "../src/index.ts";
import { MAX_INFORMAL_SHOWN, NOT_CHECKED_LINE } from "../src/informal-view.ts";
import { certifier } from "./resume-helpers.ts";
import { certifyingRegistry, check, demoRun, ofType, say } from "./m0-helpers.ts";

/** What `solve`'s RESULT.md and report.md show of the informal proof first (AL3). */
const PROOF = "Proof A. Zero is the identity of addition: induct on n.";
const gen = (proof = PROOF) => say(`${proof}\n\nMathlib facts:\n- Nat.add_zero`);
const verdict = (v: string, findings: string[] = []) => say(JSON.stringify({ verdict: v, findings }));
const accepted = (proof = PROOF) => [gen(proof), verdict("correct"), verdict("correct"), verdict("correct")];
const failing = [check("exact bad"), say("Notes.")];
const resultOf = (dir: string) => readFileSync(join(dir, "RESULT.md"), "utf8");

describe("what the RESULT and the report show of the informal proof (AL3)", () => {
  it("shows an accepted proof, with no certified Lean proof, under Not checked by Lean, with its passes and models, and leaves the claim open", async () => {
    const { dir, events, result } = await demoRun({ config: { sessions: 1, informalFirst: {} }, responses: [...accepted(), ...failing] });
    const text = resultOf(dir);
    assert.match(renderRunReport(result.report), /## Not checked by Lean/, "what `harness solve` prints at the end");
    assert.match(text, /## Not checked by Lean/);
    assert.match(text, /### Informal proof of `Demo\.add_zero'`/);
    assert.match(text, /Accepted after 3 verifier passes in a row \(3 asked, 1 generate-or-revise call\)\. Written by faux\/prover, read by faux\/prover\./);
    assert.match(text, /```text\nProof A\. Zero is the identity of addition: induct on n\.\n```/);
    assert.ok(text.includes(NOT_CHECKED_LINE));
    assert.match(text, /\*\*Not solved yet\.\*\* `Demo\.add_zero'` is `open`/, "the headline is the one it was: the claim's status did not change");
    assert.doesNotMatch(text, /\*\*Proved\.\*\*|No solution found/);
    assert.equal(ofType(events, "claim.status_changed").length, 0);
    // The run's report says the same.
    writeReport(dir);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.match(report, /## Not checked by Lean/);
    assert.ok(report.includes(NOT_CHECKED_LINE));
    assert.match(report, /Proof A\./);
    assert.equal((JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { informal: Array<{ accepted: boolean }> }).informal[0]?.accepted, true);
  });

  it("cuts a long proof at 4000 characters and says so", async () => {
    const long = `Proof. ${"x".repeat(MAX_INFORMAL_SHOWN + 500)}`;
    const { dir } = await demoRun({ config: { sessions: 1, informalFirst: {} }, responses: [...accepted(long), ...failing] });
    const text = resultOf(dir);
    assert.match(text, /\[cut: the proof is \d+ characters and this shows the first 4000/);
    assert.ok(!text.includes("x".repeat(MAX_INFORMAL_SHOWN + 100)));
    assert.ok(text.includes("x".repeat(MAX_INFORMAL_SHOWN - 100)));
  });

  it("says No solution found and shows no attempt when nothing was accepted and no Lean proof was certified", async () => {
    const { dir, events } = await demoRun({
      config: { sessions: 1, informalFirst: { rounds: 2 } },
      responses: [gen("Proof B, a rejected attempt."), verdict("wrong", ["no"]), gen("Proof C, another rejected attempt."), verdict("wrong", ["no"]), ...failing],
    });
    const text = resultOf(dir);
    assert.match(text, /\*\*No solution found\.\*\* No Lean proof of `Demo\.add_zero'` was certified and no informal argument was accepted/);
    assert.doesNotMatch(text, /Not checked by Lean|Proof B|Proof C|rejected attempt/);
    writeReport(dir);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.doesNotMatch(report, /Not checked by Lean|Proof B|Proof C/);
    // Journaled, and still a hint: the claim is open.
    assert.equal(ofType(events, "claim.status_changed").length, 0);
  });

  it("shows no informal proof when a Lean proof was certified: one line says it exists", async () => {
    const c = certifier();
    const { dir, events } = await demoRun({
      config: { sessions: 1, informalFirst: {} },
      registry: certifyingRegistry(c.certifier),
      certifier: c.certifier,
      responses: [...accepted(), check("exact trivial_proof")],
    });
    const text = resultOf(dir);
    assert.match(text, /^# Result\n\n\*\*Proved\.\*\* The Lean kernel certified a proof of `Demo\.add_zero'`/);
    assert.doesNotMatch(text, /Not checked by Lean|Proof A\. Zero/);
    assert.match(text, /An informal proof of `Demo\.add_zero'` also exists \(accepted after 3 verifier passes\); it is not shown, because a Lean proof was certified\./);
    assert.deepEqual(ofType(events, "claim.status_changed").map((e) => e.data.to), ["computed", "proved"], "the status came from Lean alone");
  });

  it("is built from the journal alone: the same journal, the same text, and a run without the informal proof has none of it", async () => {
    const { dir } = await demoRun({ config: { sessions: 1, informalFirst: {} }, responses: [...accepted(), ...failing] });
    const events = readEvents(join(dir, "journal.jsonl"));
    const blob = () => PROOF;
    assert.equal(renderResult(buildResult(events, { blob })), renderResult(buildResult(events, { blob })));
    const plain = await demoRun({ config: { sessions: 1 }, responses: failing });
    assert.doesNotMatch(resultOf(plain.dir), /Not checked by Lean|No solution found/);
    assert.equal(buildResult(readEvents(join(plain.dir, "journal.jsonl"))).informal, undefined);
  });
});
