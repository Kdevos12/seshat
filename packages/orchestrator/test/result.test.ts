import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type HarnessEvent, readEvents } from "@seshat/core";
import { buildResult, md, readResult, renderResult, resumeCommand, shellQuote, writeResult } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { certifyingRegistry, check, demoRun, killedAt, ofType, say, tempDir } from "./m0-helpers.ts";
import { scriptedJournal } from "./scripted-journal.ts";
import { TWO_PROBLEMS } from "./turns-helpers.ts";

const PROOF_FILE = "theorem x : True := by\n  trivial";

describe("the result of a run (PB8)", () => {
  it("is built from a scripted journal: claims by status, certified proofs, candidates, counter-examples, evidence and what failed", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const result = buildResult(events, { blob: (hash) => (hash === "h" ? PROOF_FILE : undefined) });

    assert.equal(result.state, "paused");
    assert.equal(result.stop?.reason, "impasse");
    assert.match(result.stop?.detail ?? "", /impasse/);
    assert.deepEqual(result.certified.map((c) => [c.claimId, c.negation, c.file]), [[s.claims.proved, false, PROOF_FILE], [s.claims.refuted, true, PROOF_FILE]]);
    assert.deepEqual(result.candidates.map((c) => c.claimId), [s.claims.computed]);
    assert.deepEqual(result.claims.byStatus, { open: 3, proved: 1, computed: 1, refuted: 1 });
    // The problems stand as the journal says: the refuted one is certified, the others are not settled.
    assert.deepEqual(result.problems.map((p) => [p.target, p.claimStatus, p.certified]), [["goldbach", "open", false], ["odd_prime", "refuted", true], ["accumulation", "open", false]]);
    // A counter-model is a lead; fingerprints, conjectures and obstructions are evidence.
    assert.deepEqual(result.counterexamples.map((c) => c.kind), ["counter_model"]);
    assert.deepEqual([...new Set(result.evidence.map((c) => c.kind))].sort(), ["conjecture", "fingerprint", "identification", "obstruction"]);
    // What failed, by strategy: automation twice, the last failure kept.
    const automation = result.failed.find((f) => f.strategy === "automation");
    assert.deepEqual([automation?.attempts, automation?.outcomes], [2, { invalid: 2 }]);
    assert.match(automation?.lastFailure ?? "", /simp made no progress/);
    assert.ok(result.spend.sites.length > 0);
    assert.match(result.resume, /pnpm harness resume RUN_DIR --checkout CHECKOUT/);

    const text = renderResult(result);
    assert.match(text, /\*\*Refuted\.\*\* The Lean kernel certified a proof of the negation of `odd_prime`/);
    assert.match(text, /\*\*Not solved yet\.\*\* `goldbach` is `open`/);
    assert.match(text, /## Lean proofs certified so far/);
    assert.match(text, /theorem x : True := by/);
    assert.match(text, /## Passed the fast check, not certified[\s\S]*candidates \(`computed`\), not results/);
    assert.match(text, /## Counter-examples[\s\S]*A claim is `refuted` only by a certified proof of its negation|refuted` only by a certified proof/);
    assert.match(text, /\[evidence\] nod_\w+ \(about clm_\w+\), conjecture/);
    assert.match(text, /## Indicative evidence \(not proofs\)/);
    // The same journal, the same text.
    assert.equal(renderResult(buildResult(events, { blob: (hash) => (hash === "h" ? PROOF_FILE : undefined) })), text);
  });

  it("states no status the journal does not hold: a candidate is never called proved, and a claim is certified only by a valid kernel replay", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    // Cut the journal before the certification of part A: its fast check is in, its kernel replay is not.
    const certifiedAt = events.findIndex((e) => e.type === "validation.finished" && e.data.validationId === s.validations.certified);
    const result = buildResult(events.slice(0, certifiedAt));
    assert.deepEqual(result.certified, []);
    const text = renderResult(result);
    assert.doesNotMatch(text, /Proved\./);
    assert.match(text, /None yet\. A claim is `proved` or `refuted` only when the kernel replay certified a proof/);
    assert.equal(result.state, "cut");
    assert.match(text, /The journal has no end: the process was killed or crashed, or it is still running/);
  });

  it("warns, in the first lines, when the journal's hash chain does not verify", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const tampered = events.map((e, i) => (i === 3 ? ({ ...e, ts: "2001-01-01T00:00:00.000Z" } as HarnessEvent) : e));
    const text = renderResult(buildResult(tampered));
    assert.match(text.split("\n").slice(0, 8).join("\n"), /Warning: the journal's hash chain does not verify at event 3/);
  });

  it("says plainly that results stay computed when the run had no certifier", async () => {
    const run = await demoRun({ responses: [check("exact trivial_proof")] });
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.match(text, /\*\*Not proved: a candidate\.\*\*/);
    assert.match(text, /No certifier ran\./);
    assert.match(text, /stays `computed`/);
    assert.match(text, /## Passed the fast check, not certified/);
    assert.match(text, /exact trivial_proof/, "the candidate's Lean file is quoted");
    assert.doesNotMatch(text, /## Lean proofs certified so far\n\nNone yet[\s\S]*Proved\./);
  });
});

describe("RESULT.md next to the journal", () => {
  it("holds the certified proof, the spend per site and the resume command when a run is proved", async () => {
    const c = certifier();
    const run = await demoRun({ registry: certifyingRegistry(c.certifier), certifier: c.certifier, responses: [check("exact trivial_proof")] });
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.match(text, /^# Result\n\n\*\*Proved\.\*\* The Lean kernel certified a proof of `Demo\.add_zero'`/);
    assert.match(text, /Certified by kernel replay val_\w+, proof from p\d?/);
    assert.match(text, /```lean\n[\s\S]*exact trivial_proof[\s\S]*```/);
    assert.match(text, /\| prover\.session \| 1 \|/);
    assert.match(text, /The run finished: every problem has an outcome/);
    assert.match(text, /Nothing to resume: the run is finished/);
    assert.match(text, /Built from the journal alone, by code, with no model call/);
    assert.equal(ofType(run.events, "model_call.finished").length, 0, "writing it called no model");
  });

  it("is rewritten after every certified result, while the run goes on", async () => {
    const c = certifier();
    const seen: Array<{ line: string; text: string | undefined }> = [];
    let dir = "";
    const run = await demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      registry: certifyingRegistry(c.certifier),
      certifier: c.certifier,
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
      log: (line) => {
        if (/^\[\d\/2\]/.test(line)) seen.push({ line, text: existsSync(join(dir, "RESULT.md")) ? readFileSync(join(dir, "RESULT.md"), "utf8") : undefined });
      },
      // The run directory is chosen here so that the log can look into it.
      dir: (dir = join(process.env.TMPDIR ?? "/tmp", `result-live-${process.pid}-${Date.now()}`)),
    });
    assert.equal(seen.length, 2);
    // When the first problem's end is logged, RESULT.md already holds its proof and not the second's.
    assert.match(seen[0]?.text ?? "", /Certified by kernel replay/);
    assert.equal((seen[0]?.text?.match(/### Proof of/g) ?? []).length, 1);
    assert.match(seen[0]?.text ?? "", /The journal has no end: the process was killed or crashed, or it is still running/);
    assert.equal((seen[1]?.text?.match(/### Proof of/g) ?? [])?.length, 2);
    assert.equal((readFileSync(join(run.dir, "RESULT.md"), "utf8").match(/### Proof of/g) ?? []).length, 2);
  });

  it("is written at a stop by the budget, and says so", async () => {
    const run = await demoRun({ config: { sessions: 6, budget: { problemUsd: 100, runUsd: 0.0001 } }, responses: [check("bad"), say("NOTES: bad"), check("bad"), say("NOTES: bad")] });
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.match(text, /the dollar budget ran out/);
    assert.match(text, /\*\*Not solved yet\.\*\*/);
    assert.match(text, /## What was tried and failed/);
  });

  it("is written at a stop by a signal", async () => {
    const controller = new AbortController();
    const aborted = await demoRun({ signal: controller.signal, responses: [check("bad"), say("NOTES"), check("bad"), say("NOTES")], log: (l) => l.includes("[1/1]") || controller.abort() });
    assert.match(readFileSync(join(aborted.dir, "RESULT.md"), "utf8"), /the run was stopped/);
  });

  it("is rebuilt by readResult and writeResult for a run whose process died, from the journal alone", async () => {
    const c = certifier();
    const run = await demoRun({ file: TWO_PROBLEMS, problems: 2, registry: certifyingRegistry(c.certifier), certifier: c.certifier, responses: [check("exact trivial_proof"), check("exact trivial_proof")] });
    // The process died after the first problem was certified: the journal ends there, and RESULT.md was never written.
    const cut = killedAt(run.dir, (e) => e.type === "problem.registered" && e.data.problemId.endsWith("two_mul'"));
    rmSync(join(cut, "RESULT.md"), { force: true });
    const result = writeResult(cut);
    assert.equal(result.state, "cut");
    assert.equal(result.certified.length, 1);
    const text = readFileSync(join(cut, "RESULT.md"), "utf8");
    assert.match(text, /The journal has no end/);
    assert.match(text, /exact trivial_proof/);
    assert.match(result.resume, new RegExp(`pnpm harness resume ${cut.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} --checkout ${run.bench.checkout.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`), "the cut keeps the run's resume.json");
    rmSync(join(cut, "resume.json"));
    assert.match(readResult(cut).resume, /--checkout CHECKOUT .*resume\.json is missing/);
    assert.equal(readResult(run.dir).state, "finished");
  });

  it("reads the resume command from the run directory when the run left one", async () => {
    const run = await demoRun({ responses: [check("bad"), say("NOTES")] });
    assert.ok(existsSync(join(run.dir, "resume.json")), "a run leaves the checkout it began with");
    const command = resumeCommand(run.dir, "cut");
    assert.match(command, new RegExp(`^pnpm harness resume ${run.dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} --checkout ${run.bench.checkout.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    assert.match(resumeCommand(run.dir, "finished"), /Nothing to resume/);
  });
});

describe("a run cut at every event", () => {
  it("leaves a result that holds every certified result up to the cut", async () => {
    const c = certifier();
    const run = await demoRun({ file: TWO_PROBLEMS, problems: 2, registry: certifyingRegistry(c.certifier), certifier: c.certifier, responses: [check("exact trivial_proof"), check("exact trivial_proof")] });
    const events = run.events;
    const { BlobStore } = await import("@seshat/core");
    const blobs = new BlobStore(join(run.dir, "blobs"));
    let certifiedSeen = 0;
    for (let k = 1; k <= events.length; k++) {
      const prefix = events.slice(0, k);
      const result = buildResult(prefix, { blob: (hash) => blobs.get(hash) });
      // The claims the prefix made `proved` or `refuted`, by the journal's own events.
      const settled = prefix.flatMap((e) => (e.type === "claim.status_changed" && (e.data.to === "proved" || e.data.to === "refuted") ? [e.data.claimId] : []));
      assert.deepEqual(result.certified.map((x) => x.claimId).sort(), [...settled].sort(), `cut after event ${k - 1}`);
      const text = renderResult(result);
      for (const proof of result.certified) {
        assert.ok(proof.file?.includes("exact trivial_proof"), "the certified Lean file is quoted in full");
        assert.ok(text.includes(proof.claimId));
      }
      // A candidate becomes a certified result and leaves the candidates; the two never hold one claim.
      const both = result.candidates.filter((x) => result.certified.some((y) => y.claimId === x.claimId));
      assert.deepEqual(both, []);
      // The cut's state is the journal's: finished only at the end.
      assert.equal(result.state === "finished", prefix.some((e) => e.type === "run.finished") && k === events.length);
      certifiedSeen = Math.max(certifiedSeen, result.certified.length);
    }
    assert.equal(certifiedSeen, 2);
  });
});

describe("RESULT.md review fixes", () => {
  it("makes journal text inert in Markdown and keeps a statement from closing its own code span", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const result = buildResult(events);
    const hostile = "x` ![](http://host/?k) <img src=x> | a\nb";
    const text = renderResult({
      ...result,
      claims: { ...result.claims, listed: [{ id: "clm_x", status: "open", statement: hostile }] },
      evidence: [{ id: "nod_x", kind: "conjecture", text: hostile }],
      counterexamples: [{ id: "nod_y", kind: "counter_model", text: hostile }],
      certified: [{ ...result.certified[0]!, statement: hostile }],
    });
    for (const line of text.split("\n").filter((l) => /^(\| clm_x|- \[evidence\]|- nod_y)/.test(l))) {
      assert.doesNotMatch(line, /(^|[^\\])(<img|!\[)/, line);
      assert.match(line, /\\!\\\[/);
    }
    assert.match(text, /``\s?x` !\[\]\(http:\/\/host\/\?k\) <img src=x> \| a b\s?``/, "the statement is in a code span that the backtick cannot close");
    assert.equal(md("a`b|c\nd"), "a\\`b\\|c d");
  });

  it("quotes the values of the resume command and refuses what cannot be quoted", () => {
    assert.equal(shellQuote("runs/ok-1"), "runs/ok-1");
    assert.equal(shellQuote("a b; rm -rf ~"), "'a b; rm -rf ~'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.throws(() => shellQuote("a\nb"));
    const dir = tempDir();
    writeFileSync(join(dir, "resume.json"), JSON.stringify({ checkout: "/p/with space", bench: "/p/i.json", host: "sandboxed" }));
    assert.equal(resumeCommand(dir, "paused"), `pnpm harness resume ${shellQuote(dir)} --checkout '/p/with space' --bench /p/i.json --host sandboxed`);
    writeFileSync(join(dir, "resume.json"), JSON.stringify({ checkout: "x\n```\nrm -rf ~", host: "h" }));
    assert.match(resumeCommand(dir, "paused"), /resume.json is missing/);
  });

  it("calls a problem certified only by a replay of the right kind", () => {
    const s = scriptedJournal();
    // A certified proof of the negation of a claim that is still open does not make the problem certified.
    s.journal.emit("validation.finished", { validationId: "val_neg", claimId: s.claims.stuck, attemptId: s.attempts[6]!, method: "kernel_replay", verdict: "valid", reasons: [], axioms: [], submissionHash: "h", negation: true }, "certifier");
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const stuck = buildResult(events).problems.find((p) => p.target === "accumulation");
    assert.deepEqual([stuck?.claimStatus, stuck?.certified], ["open", false]);
  });
});
