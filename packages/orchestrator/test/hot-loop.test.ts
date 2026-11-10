import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { LeanCheckOptions, LeanCheckResult, LeanChecker, LeanSnippet } from "@seshat/core";
import { BlobStore } from "@seshat/core";
import { join } from "node:path";
import { PROVER_SYSTEM_TEMPLATE, promptHash, systemPrompt } from "../src/prompt.ts";
import { call, check, DemoLean, demoRun, ofType, proofOf, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

/** The text of a message's content. */
function textOf(message: Message): string {
  if (message.role === "assistant") return JSON.stringify(message.content);
  return typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** `DemoLean` that records the time limit of each check, and answers `timeout` to a proof that says `slow` when the limit is below 300 s. */
class LimitedLean implements LeanChecker {
  readonly implementation = "limited-lean";
  readonly version = "0";
  readonly limits: Array<{ proof: string | undefined; timeoutSec: number | undefined }> = [];
  private readonly inner = new DemoLean();

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    for (const s of snippets) this.limits.push({ proof: proofOf(s.code)?.trim(), timeoutSec: options.timeoutSec });
    if (snippets.some((s) => proofOf(s.code)?.includes("hang")) && (options.timeoutSec ?? 300) < 300) {
      return snippets.map((s) => ({ id: s.id, status: "timeout" as const, messages: [], sorries: [], timeMs: 1, error: "timed out" }));
    }
    return this.inner.check(snippets.map((s) => ({ ...s, code: s.code.replace("hang", "") })), options);
  }
}

describe("bounded checks (CA4)", () => {
  it("bounds the prover's check by checkTimeoutSec and leaves the reference's limit alone", async () => {
    const lean = new LimitedLean();
    const { events } = await demoRun({
      lean,
      config: { checkTimeoutSec: 7 },
      responses: [check("hang"), check("exact trivial_proof")],
    });
    // The reference check keeps the validator's 300 s; the prover's two checks get 7.
    assert.deepEqual(lean.limits.map((l) => l.timeoutSec), [300, 7, 7]);
    // The session goes on after the check that passed the limit.
    const attempts = ofType(events, "attempt.finished");
    assert.equal(attempts[0]?.data.outcome, "valid");
  });

  it("without the option the prover's check runs under the validator's policy, as it always did", async () => {
    const lean = new LimitedLean();
    await demoRun({ lean, responses: [check("exact trivial_proof")] });
    assert.deepEqual(lean.limits.map((l) => l.timeoutSec), [300, 300]);
  });

  it("tells the model that a check passed the limit", async () => {
    const lean = new LimitedLean();
    const seen: string[] = [];
    await demoRun({
      lean,
      config: { checkTimeoutSec: 7 },
      responses: [
        check("hang"),
        (context: TranscriptContext) => {
          seen.push(textOf(context.messages.filter((m) => m.role === "toolResult").at(-1) as Message));
          return say("My notes.");
        },
      ],
    });
    assert.match(seen[0] ?? "", /did not finish within the time limit/);
  });
});

const edit = (region: "aux" | "proof", old: string, replacement: string) => call("lean_edit", { region, old, new: replacement });

/** The text of the last tool result a request carries. */
function lastResult(context: TranscriptContext): string {
  return textOf(context.messages.filter((m) => m.role === "toolResult").at(-1) as Message);
}

describe("the edit tool (CA5)", () => {
  it("replaces the one occurrence, runs the check, and the journal stores the full submission as lean_check would", async () => {
    const lean = new DemoLean();
    const { events, dir } = await demoRun({
      lean,
      config: { editTool: true },
      responses: [check("have h : 1 = 1 := rfl\n  bad"), edit("proof", "bad", "exact trivial_proof")],
    });
    const validation = ofType(events, "validation.finished").at(-1);
    assert.equal(validation?.data.verdict, "valid");
    const submitted = new BlobStore(join(dir, "blobs")).get(validation?.data.submissionHash ?? "") ?? "";
    assert.match(submitted, /have h : 1 = 1 := rfl\n\s+exact trivial_proof/);
    assert.doesNotMatch(submitted, /bad/);
    // The same check as lean_check: a tool run of lean.check of the attempt, for each of the two.
    assert.equal(ofType(events, "tool_run.started").filter((r) => r.data.attemptId !== undefined).length, 2);
  });

  it("answers that there is nothing to edit before any lean_check, and checks nothing", async () => {
    const lean = new DemoLean();
    const seen: string[] = [];
    await demoRun({
      lean,
      config: { editTool: true },
      responses: [edit("proof", "x", "y"), (context: TranscriptContext) => (seen.push(lastResult(context)), say("notes"))],
    });
    assert.match(seen[0] ?? "", /Nothing to edit/);
    assert.equal(lean.calls.length, 1, "only the reference was checked");
  });

  it("answers not found, and found N times, with the region's current text, and checks nothing", async () => {
    const lean = new DemoLean();
    const seen: string[] = [];
    const record = (context: TranscriptContext) => (seen.push(lastResult(context)), edit("proof", "zzz", "w"));
    await demoRun({
      lean,
      config: { editTool: true },
      responses: [
        check("bad\n  bad"),
        edit("proof", "nowhere", "x"),
        record,
        (context: TranscriptContext) => (seen.push(lastResult(context)), edit("aux", "bad", "x")),
        (context: TranscriptContext) => (seen.push(lastResult(context)), edit("proof", "bad", "x")),
        (context: TranscriptContext) => (seen.push(lastResult(context)), say("notes")),
      ],
    });
    assert.match(seen[0] ?? "", /^not found/);
    assert.match(seen[0] ?? "", /bad\n\s+bad/, "the region's current text comes back");
    assert.match(seen[1] ?? "", /^not found/);
    assert.match(seen[2] ?? "", /^not found: .*aux region/);
    assert.match(seen[3] ?? "", /^found 2 times/);
    // The reference, the first draft, and nothing else.
    assert.equal(lean.calls.length, 2);
  });

  it("edits the aux region as last checked, not as the first draft was", async () => {
    const { events, dir } = await demoRun({
      config: { editTool: true },
      responses: [check("bad", "lemma aux_a : True := trivial"), edit("aux", "True", "1 = 1"), edit("proof", "bad", "exact trivial_proof")],
    });
    const validations = ofType(events, "validation.finished");
    const last = validations.at(-1);
    const submitted = new BlobStore(join(dir, "blobs")).get(last?.data.submissionHash ?? "") ?? "";
    assert.match(submitted, /aux_a : 1 = 1/);
  });

  it("is declared, and prompted, only when the option is on", async () => {
    const seen: Array<{ system: string; tools: string[] }> = [];
    const look = (context: TranscriptContext) => {
      const system = context.messages.filter((m) => m.role === "system");
      seen.push({
        system: system.map((m) => (typeof m.content === "string" ? m.content : textOf(m))).join("\n"),
        tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
      });
      return say("n");
    };
    await demoRun({ responses: [look] });
    await demoRun({ config: { editTool: true }, responses: [look] });
    assert.equal(seen[0]?.system, systemPrompt(4000, []), "a run without the option sends the merged prompt");
    assert.equal(seen[1]?.system, systemPrompt(4000, [], PROVER_SYSTEM_TEMPLATE, true));
    assert.match(seen[1]?.system ?? "", /lean_edit\(region, old, new\)/);
    assert.doesNotMatch(seen[0]?.system ?? "", /lean_edit/);
    assert.deepEqual(seen[0]?.tools, ["lean_check"]);
    assert.deepEqual(seen[1]?.tools, ["lean_check", "lean_edit"]);
    assert.equal(promptHash(4000, []), promptHash(4000, [], PROVER_SYSTEM_TEMPLATE, false));
    assert.notEqual(promptHash(4000, []), promptHash(4000, [], PROVER_SYSTEM_TEMPLATE, true));
  });
});
