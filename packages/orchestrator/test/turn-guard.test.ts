import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ValidationReport } from "@seshat/core";
import { Type } from "@earendil-works/pi-ai";
import { Ledger } from "../src/budget.ts";
import type { Workbench } from "../src/problem.ts";
import { runSession, SUBMIT_NOW, TURNS_BEFORE_CHECK } from "../src/session.ts";
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

/** A session whose model makes the given calls, then ends; `lean_search` counts the calls that reach it. */
async function run(script: Array<"search" | "check">, opts: { turns?: number; tool?: boolean; ending?: boolean } = {}): Promise<{ reached: number; answers: string[]; stop: string }> {
  const { models, faux } = fauxModels();
  faux.setResponses([...script.map((s) => (s === "search" ? call("lean_search", { q: "x" }) : check("bad"))), say("Notes.")]);
  let reached = 0;
  const search = {
    name: "lean_search",
    label: "lean.search",
    description: "Searches",
    parameters: Type.Object({ q: Type.String() }),
    executionMode: "sequential",
    execute: async () => {
      reached += 1;
      return { content: [{ type: "text" as const, text: "found" }], details: {} };
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
    limits: { turns: opts.turns ?? 40, contextTokens: 100_000 },
    ledger: new Ledger(),
    signal: new AbortController().signal,
    wrapUp: false,
    ...(opts.tool === false ? {} : { tools: [search] }),
    ...(opts.ending === true ? { endingTools: ["lean_search"] } : {}),
  });
  const answers = result.messages.flatMap((m) => ("role" in m && m.role === "toolResult" && m.toolName === "lean_search" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []));
  return { reached, answers, stop: result.stop };
}

describe("exploring is not checking", () => {
  it("answers the seventh exploring turn in a row with the refusal, without calling the tool", async () => {
    const { reached, answers } = await run(Array<"search">(TURNS_BEFORE_CHECK + 1).fill("search"));
    assert.equal(reached, TURNS_BEFORE_CHECK);
    assert.equal(answers.length, TURNS_BEFORE_CHECK + 1);
    assert.equal(answers.at(-1), SUBMIT_NOW);
    assert.ok(answers.slice(0, -1).every((a) => a === "found"));
  });

  it("is reset by a check: the tool answers again after it", async () => {
    const script: Array<"search" | "check"> = [...Array<"search">(TURNS_BEFORE_CHECK).fill("search"), "check", ...Array<"search">(TURNS_BEFORE_CHECK).fill("search")];
    const { reached, answers } = await run(script);
    assert.equal(reached, 2 * TURNS_BEFORE_CHECK);
    assert.ok(!answers.includes(SUBMIT_NOW));
  });

  it("answers at two turns from the limit when no check was made", async () => {
    // 5 turns allowed: the fourth turn is the last but one (two turns left, itself included).
    const { reached, answers } = await run(["search", "search", "search", "search", "search"], { turns: 5 });
    assert.equal(reached, 3);
    assert.deepEqual(answers.slice(3), [SUBMIT_NOW, SUBMIT_NOW]);
  });

  it("leaves a session that made a check alone near the limit", async () => {
    const { reached, answers } = await run(["check", "search", "search", "search"], { turns: 5 });
    assert.equal(reached, 3);
    assert.ok(!answers.includes(SUBMIT_NOW));
  });

  it("does not touch a session with only lean_check", async () => {
    const { stop } = await run(Array<"check">(TURNS_BEFORE_CHECK + 3).fill("check"), { tool: false });
    assert.equal(stop, "model");
  });

  it("does not refuse an ending tool", async () => {
    const { reached, answers } = await run(Array<"search">(TURNS_BEFORE_CHECK + 1).fill("search"), { ending: true });
    assert.equal(reached, TURNS_BEFORE_CHECK + 1);
    assert.ok(!answers.includes(SUBMIT_NOW));
  });
});
