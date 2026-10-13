import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { BlobStore, type CertificationRequest, type LeanCertifier } from "@math-harness/core";
import { renderRunReport, resolveModel } from "../src/index.ts";
import { check, DemoLean, demoAnswer, demoRun, fauxModels, ofType, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

function userText(message: Message | undefined): string {
  if (message?.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The text of the first user message of a request: the session prompt. */
function sessionPromptOf(context: TranscriptContext): string {
  return userText(context.messages.find((m) => m.role === "user"));
}

/** The text of the last tool result of a request. */
function lastToolResult(context: TranscriptContext): string {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  return last === undefined ? "" : last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("M0 run", () => {
  it("records a proof that passes the fast check as a candidate", async () => {
    const { result, events, dir, lean } = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const [validation] = ofType(events, "validation.finished");
    assert.equal(validation?.data.method, "repl");
    assert.equal(validation?.data.verdict, "valid");
    const [change] = ofType(events, "claim.status_changed");
    assert.deepEqual([change?.data.from, change?.data.to, change?.data.validationId], ["open", "computed", validation?.data.validationId]);
    const [attempt] = ofType(events, "attempt.finished");
    assert.deepEqual([attempt?.data.outcome, attempt?.data.stoppedBy, attempt?.data.turns], ["valid", "solved", 1]);
    assert.ok((attempt?.data.usd ?? 0) > 0, "the session's cost is recorded");

    // The reference, then the prover's check: two tool runs of lean.check, the second one of the attempt.
    assert.equal(lean instanceof DemoLean ? lean.calls.length : 0, 2);
    const runs = ofType(events, "tool_run.started");
    assert.deepEqual(runs.map((r) => [r.data.capability, r.data.attemptId ?? null]), [
      ["lean.check", null],
      ["lean.check", attempt?.data.attemptId],
    ]);

    // The proof, the submission and the tool run's input are kept.
    const proof = result.problems[0]?.proof ?? "";
    assert.match(readFileSync(join(dir, proof), "utf8"), /exact trivial_proof/);
    const blobs = new BlobStore(join(dir, "blobs"));
    assert.match(blobs.get(validation?.data.submissionHash ?? "") ?? "", /exact trivial_proof/);
    assert.ok(blobs.has(runs[1]?.data.inputHash ?? ""));
    assert.ok(existsSync(join(dir, "transcripts", `${attempt?.data.attemptId}.json`)));
    for (const file of ["config.json", "journal.jsonl", "report.json", "report.md"]) assert.ok(existsSync(join(dir, file)), file);

    const [finished] = ofType(events, "run.finished");
    assert.deepEqual([finished?.data.attempted, finished?.data.solved, finished?.data.candidates], [1, 0, 1]);
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /\| Candidates \(fast check only\) \| 1 \|/);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { problems: string[]; prompt: { version: string } };
    assert.equal(config.problems.length, 1);
    assert.equal(config.prompt.version, "m0-1");
  });

  it("carries the file and the notes from one session to the next", async () => {
    const prompts: string[] = [];
    const { result, events } = await demoRun({
      responses: [
        check("have h : 1 = 1 := rfl\nsorry"),
        (context) => {
          assert.match(lastToolResult(context), /Checked the sketch: no error, 1 hole\(s\) left/);
          assert.match(lastToolResult(context), /PROOF line 2, `sorry`:\n {3}n : ℕ\n {3}⊢ n \+ 0 = n/);
          return say("NOTES: the hole needs trivial_proof.");
        },
        (context) => {
          prompts.push(sessionPromptOf(context));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const attempts = ofType(events, "attempt.finished");
    assert.deepEqual(attempts.map((a) => [a.data.outcome, a.data.stoppedBy, a.data.failureClass ?? null]), [
      ["invalid", "model", "holes"],
      ["valid", "solved", null],
    ]);
    assert.deepEqual(ofType(events, "lesson.recorded").map((l) => l.data.text), ["NOTES: the hole needs trivial_proof."]);
    const second = prompts[0] ?? "";
    assert.match(second, /This is session 2 of at most 2/);
    assert.match(second, /# Your notes from the previous sessions\nNOTES: the hole needs trivial_proof\./);
    assert.match(second, /-- HARNESS:PROOF:BEGIN\n {2}have h : 1 = 1 := rfl\n {2}sorry\n {2}-- HARNESS:PROOF:END/);
    assert.match(second, /# What Lean said about the file as it is\nChecked the sketch: no error, 1 hole\(s\) left/);
    // A sketch with holes is not a validation; the complete proof is.
    assert.deepEqual(ofType(events, "validation.finished").map((v) => v.data.verdict), ["valid"]);
  });

  it("refuses forbidden code before Lean runs, and says why", async () => {
    const results: string[] = [];
    const { events, lean } = await demoRun({
      config: { sessions: 1 },
      responses: [
        check("native_decide"),
        (context) => {
          results.push(lastToolResult(context));
          return say("native_decide is refused; next time use decide.");
        },
      ],
    });
    assert.match(results[0] ?? "", /^Refused before Lean ran; nothing was checked:\n- proof: 'native_decide' is not allowed$/);
    assert.equal((lean as DemoLean).calls.length, 1, "only the reference reached Lean");
    const [attempt] = ofType(events, "attempt.finished");
    assert.deepEqual([attempt?.data.outcome, attempt?.data.failureClass], ["invalid", "refused"]);
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.verdict, v.data.reasons]), [
      ["invalid", ["proof: 'native_decide' is not allowed"]],
    ]);
  });

  it("ends a session at its turn limit, asks for notes, and goes on", async () => {
    const asked: string[] = [];
    const { events, result } = await demoRun({
      config: { limits: { turns: 2, contextTokens: 100_000 } },
      responses: [
        check("bad"),
        check("bad again"),
        (context) => {
          asked.push(userText(context.messages.findLast((m) => m.role === "user")));
          return say("NOTES: bad is not a lemma.");
        },
        say("I have nothing better."),
      ],
    });
    assert.match(asked[0] ?? "", /This session has reached its limit/);
    const attempts = ofType(events, "attempt.finished");
    assert.deepEqual(attempts.map((a) => [a.data.outcome, a.data.stoppedBy, a.data.turns]), [
      ["invalid", "turns", 3],
      ["no_submission", "model", 1],
    ]);
    assert.deepEqual(ofType(events, "lesson.recorded").map((l) => l.data.text), ["NOTES: bad is not a lemma.", "I have nothing better."]);
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.match(result.problems[0]?.reason ?? "", /provers stopped: 1 sessions/);
  });

  it("stops a problem when its budget runs out", async () => {
    const { events, result } = await demoRun({
      pricePerMillion: 100_000,
      config: { budget: { problemUsd: 1 } },
      responses: [check("bad"), check("bad"), check("bad")],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.equal(result.problems[0]?.reason, "the problem's budget ran out");
    const attempts = ofType(events, "attempt.finished");
    assert.deepEqual(attempts.map((a) => a.data.outcome), ["budget_exhausted"]);
    assert.ok((attempts[0]?.data.usd ?? 0) >= 1);
  });

  it("stops the other provers when one finds a proof", async () => {
    // Checks take 30 ms, so the second prover's check is under way when the first one's succeeds.
    const { events, result } = await demoRun({
      config: { provers: 2 },
      lean: new DemoLean(demoAnswer, 30),
      responses: [check("exact trivial_proof"), check("slow")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const attempts = ofType(events, "attempt.finished").map((a) => [a.data.outcome, a.data.stoppedBy]).sort();
    assert.deepEqual(attempts, [["aborted", "aborted"], ["valid", "solved"]]);
    assert.deepEqual(ofType(events, "tool_run.finished").map((t) => t.data.outcome), ["ok", "ok", "aborted"]);
    assert.equal(result.problems[0]?.attempts, 2);
  });

  it("skips a problem whose original file does not compile", async () => {
    const lean = new DemoLean((code) =>
      code.includes("HARNESS:") ? demoAnswer(code) : { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "unknown package" }] },
    );
    const { result, events } = await demoRun({ lean, responses: [] });
    assert.equal(result.problems[0]?.outcome, "skipped");
    assert.match(result.problems[0]?.reason ?? "", /the original file does not compile: 1: unknown package/);
    assert.equal(ofType(events, "attempt.started").length, 0);
  });

  it("stops the run when Lean cannot be reached", async () => {
    const lean = new DemoLean(() => ({ error: { status: "server_error", message: "connection refused" } }));
    const { result } = await demoRun({ lean, problems: 2, responses: [] });
    assert.equal(result.stopped, "lean_unavailable");
    assert.deepEqual(result.problems.map((p) => p.outcome), ["error"]);
    assert.equal(result.report.planned, 2);
    assert.match(renderRunReport(result.report), /^\| No outcome \(not started, or the run was killed\) \| 1 \|$/m);
  });

  it("makes a candidate proved when the certifier certifies it, and open again when it rejects it", async () => {
    const requests: CertificationRequest[] = [];
    const certifier = (verdict: "certified" | "rejected"): LeanCertifier => ({
      implementation: "fake-certifier",
      version: "0",
      certify: async (request) => {
        requests.push(request);
        return { verdict, reasons: verdict === "certified" ? [] : ["kernel: declaration has metavariables"], axioms: ["propext"], timeMs: 1 };
      },
    });
    const proved = await demoRun({ certifier: certifier("certified"), responses: [check("exact trivial_proof")] });
    assert.equal(proved.result.problems[0]?.outcome, "proved");
    assert.deepEqual(ofType(proved.events, "validation.finished").map((v) => [v.data.method, v.data.verdict]), [
      ["repl", "valid"],
      ["kernel_replay", "valid"],
    ]);
    assert.deepEqual(ofType(proved.events, "claim.status_changed").map((c) => c.data.to), ["computed", "proved"]);
    assert.equal(ofType(proved.events, "run.finished")[0]?.data.solved, 1);
    assert.match(requests[0]?.candidate ?? "", /exact trivial_proof/);

    const rejected = await demoRun({ certifier: certifier("rejected"), responses: [check("exact trivial_proof")] });
    assert.equal(rejected.result.problems[0]?.outcome, "unsolved");
    assert.match(rejected.result.problems[0]?.reason ?? "", /certification rejected the candidate: kernel: declaration has metavariables/);
    assert.deepEqual(ofType(rejected.events, "claim.status_changed").map((c) => c.data.to), ["computed", "open"]);
  });

  it("stops between problems when the run is aborted", async () => {
    const controller = new AbortController();
    const { result, events } = await demoRun({
      problems: 2,
      config: { sessions: 1 },
      signal: controller.signal,
      responses: [
        (context) => {
          controller.abort();
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.stopped, "aborted");
    assert.deepEqual(result.problems.map((p) => p.outcome), ["aborted"]);
    assert.equal(ofType(events, "run.finished")[0]?.data.stopped, "aborted");
  });
});

describe("resolveModel", () => {
  it("names unknown providers and models, and providers without credentials", async () => {
    const { models, name } = fauxModels();
    assert.equal((await resolveModel(models, name)).id, "prover");
    await assert.rejects(resolveModel(models, "prover"), /expected provider\/id/);
    await assert.rejects(resolveModel(models, "nobody/x"), /unknown provider nobody/);
    await assert.rejects(resolveModel(models, "faux/other"), /unknown model other of faux; known: prover/);
    models.getAuth = async () => undefined;
    await assert.rejects(resolveModel(models, name), /no credentials for faux/);
  });
});
