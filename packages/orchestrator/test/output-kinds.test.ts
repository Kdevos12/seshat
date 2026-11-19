import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { CHARS_PER_TOKEN, outputKinds } from "../src/output-kinds.ts";

const cost = (outputTokens: number) => ({ usd: 0, inputTokens: 0, outputTokens });
const ev = (type: string, data: unknown) => ({ type, data }) as unknown as HarnessEvent;
const started = (attemptId: string, site?: string) => ev("attempt.started", { attemptId, claimId: "c", prover: "p", iteration: 1, model: "m", ...(site !== undefined ? { site } : {}) });
const charged = (attemptId: string, out: number) => ev("attempt.charged", { attemptId, ...cost(out) });
const modelCall = (extra: Record<string, unknown>, out: number) => ev("model_call.finished", { modelCallId: "mc", line: "L", model: "m", outcome: "ok", requestHash: "req", durationMs: 0, ...cost(out), ...extra });

describe("output tokens by role and kind", () => {
  it("splits a message's usage across thinking, text and tool-call arguments by characters", () => {
    const args = { proof: "x".repeat(40) };
    const argChars = JSON.stringify(args).length;
    const transcript = [
      { role: "user", content: "hi" },
      { role: "assistant", usage: { output: 100 }, content: [{ type: "thinking", thinking: "t".repeat(argChars) }, { type: "text", text: "w".repeat(argChars) }, { type: "toolCall", name: "lean_check", arguments: args }] },
    ];
    const [row, ...rest] = outputKinds({ events: [started("a1"), charged("a1", 100)], transcript: (id) => (id === "a1" ? transcript : undefined) });
    assert.equal(rest.length, 0);
    assert.equal(row?.role, "prover");
    assert.equal(row?.calls, 1);
    assert.equal(row?.outputTokens, 100);
    assert.ok(Math.abs((row?.thinking ?? 0) - 100 / 3) < 1e-9 && Math.abs((row?.text ?? 0) - 100 / 3) < 1e-9 && Math.abs((row?.toolCalls ?? 0) - 100 / 3) < 1e-9);
    assert.equal(row?.estimatedMessages, 0);
  });

  it("estimates a message with no usage from its characters, and says so", () => {
    const transcript = [{ role: "assistant", content: [{ type: "text", text: "a".repeat(4 * CHARS_PER_TOKEN) }] }];
    const [row] = outputKinds({ events: [started("a1"), charged("a1", 10)], transcript: () => transcript });
    assert.equal(row?.text, 4);
    assert.equal(row?.estimatedMessages, 1);
  });

  it("gives a one-shot call's text from its blob and the rest of its output as thinking that was not stored", () => {
    const events = [modelCall({ site: "scheduler.planner", responseHash: "resp" }, 500)];
    const [row] = outputKinds({ events, blob: (h) => (h === "resp" ? "p".repeat(40) : undefined) });
    assert.equal(row?.role, "planner");
    assert.equal(row?.text, 40 / CHARS_PER_TOKEN);
    assert.equal(row?.thinking, 500 - 40 / CHARS_PER_TOKEN);
    assert.equal(row?.thinkingNotStored, row?.thinking);
    assert.equal(row?.split, 500);
  });

  it("measures a hole session by its transcript, and reads 'not recorded' (no split) without one", () => {
    const calls = [modelCall({ site: "scheduler.hole", role: "hole" }, 30), modelCall({ site: "scheduler.hole", role: "hole" }, 20)];
    const blob = (h: string) => (h === "req" ? JSON.stringify({ session: "k", claimId: "c", sessionId: "hole_1" }) : undefined);
    const bare = outputKinds({ events: calls, blob });
    assert.equal(bare[0]?.role, "hole");
    assert.equal(bare[0]?.calls, 2);
    assert.equal(bare[0]?.outputTokens, 50);
    assert.equal(bare[0]?.split, 0);
    const transcript = [
      { role: "assistant", usage: { output: 30 }, content: [{ type: "text", text: "abcd" }] },
      { role: "assistant", usage: { output: 20 }, content: [{ type: "toolCall", name: "lean_check", arguments: {} }] },
    ];
    const measured = outputKinds({ events: calls, blob, transcript: (id) => (id === "hole_1" ? transcript : undefined) });
    assert.equal(measured[0]?.split, 50, "the session's transcript is counted once for its two calls");
    assert.equal(measured[0]?.text, 30);
    assert.equal(measured[0]?.toolCalls, 20);
  });

  it("puts a call with no role and no known site under its site, or other", () => {
    const rows = outputKinds({ events: [modelCall({ site: "graph.attempt" }, 5), modelCall({}, 7)] });
    assert.deepEqual(rows.map((r) => [r.role, r.outputTokens]), [["graph.attempt", 5], ["other", 7]]);
  });
});
