import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { LeanCheckOptions, LeanCheckResult, LeanChecker, LeanSnippet } from "@seshat/core";
import { check, DemoLean, demoRun, ofType, proofOf, say } from "./m0-helpers.ts";

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
