import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ValidationReport } from "@seshat/core";
import { Type } from "@earendil-works/pi-ai";
import { Ledger } from "../src/budget.ts";
import type { Workbench } from "../src/problem.ts";
import { LSP_CALLS_BEFORE_CHECK, LSP_CHECK_REMINDER, runSession } from "../src/session.ts";
import { call, check, fauxModels, say } from "./m0-helpers.ts";

const REPORT: ValidationReport = {
  verdict: "invalid",
  method: "repl",
  reasons: [],
  axioms: [],
  messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "boom" }],
  sorries: [],
  checked: "theorem t : True := by\n  bad\n",
  submissionHash: "h",
  editsOutsideRegions: false,
  holes: false,
  leanStatus: "lean_error",
};
const workbench = { check: async () => ({ report: REPORT, accepted: false }) } as unknown as Workbench;

/** A session whose model makes the given calls, then ends; the `lean_lsp` tool counts the calls that reach it. */
async function run(script: Array<"lsp" | "check">, withLsp = true): Promise<{ reached: number; answers: string[] }> {
  const { models, faux, name } = fauxModels();
  faux.setResponses([...script.map((s) => (s === "lsp" ? call("lean_lsp", { op: "diagnostics" }) : check("bad"))), say("Notes.")]);
  let reached = 0;
  const lsp = {
    name: "lean_lsp",
    label: "lean.lsp",
    description: "Lean's language server",
    parameters: Type.Object({ op: Type.String() }),
    executionMode: "sequential",
    execute: async () => {
      reached += 1;
      return { content: [{ type: "text" as const, text: "diagnostics: none" }], details: {} };
    },
  } as unknown as AgentTool<never, unknown>;
  const result = await runSession({
    models,
    model: faux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "You prove theorems.",
    prompt: "Prove it.",
    workbench,
    attemptId: "att_x",
    actor: "prover:p1",
    limits: { turns: 40, contextTokens: 100_000 },
    ledger: new Ledger(),
    signal: new AbortController().signal,
    wrapUp: false,
    ...(withLsp ? { tools: [lsp] } : {}),
  });
  const answers = result.messages.flatMap((m) => ("role" in m && m.role === "toolResult" && m.toolName === "lean_lsp" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []));
  return { reached, answers };
}

describe("lean.lsp without a check", () => {
  it("answers the ninth call with a reminder, without calling the capability", async () => {
    const { reached, answers } = await run(Array<"lsp">(LSP_CALLS_BEFORE_CHECK + 1).fill("lsp"));
    assert.equal(reached, LSP_CALLS_BEFORE_CHECK);
    assert.equal(answers.length, LSP_CALLS_BEFORE_CHECK + 1);
    assert.equal(answers.at(-1), LSP_CHECK_REMINDER);
    assert.match(LSP_CHECK_REMINDER, /^Check your file with lean_check now: only lean_check counts/);
    assert.ok(answers.slice(0, -1).every((a) => a === "diagnostics: none"));
  });

  it("is reset by a lean_check: the calls after it reach the capability again", async () => {
    const script: Array<"lsp" | "check"> = [...Array<"lsp">(LSP_CALLS_BEFORE_CHECK).fill("lsp"), "check", ...Array<"lsp">(LSP_CALLS_BEFORE_CHECK).fill("lsp")];
    const { reached, answers } = await run(script);
    assert.equal(reached, 2 * LSP_CALLS_BEFORE_CHECK);
    assert.ok(!answers.includes(LSP_CHECK_REMINDER));
  });
});
