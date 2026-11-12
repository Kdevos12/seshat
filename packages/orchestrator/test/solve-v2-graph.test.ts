import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { type Arm, ablationProblems, armConfig } from "../src/ablation.ts";
import { DEFAULT_CONFIG, type RunConfig } from "../src/index.ts";
import { experimentArms } from "../src/experiments.ts";
import { buildReport } from "../src/report.ts";
import { call, check, demoRun, ofType, say } from "./m0-helpers.ts";

/**
 * The arm `solve-v2-graph` (plan change KG1): `solve-v2` plus lines M2 and M4. One problem under this arm's configuration with the faux model and
 * the simulated Lean: the run finishes, v2's state card and masking of old checks are still in the prover's requests next to M4's packet, and the
 * prover is offered `expand` and `graph_query`. Nothing here ran against a real model or Lean.
 */
const table: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } };
const arm = (): Arm => experimentArms("solve-defaults", { host: { capabilities: {} } }).find((a) => a.name === "solve-v2-graph") ?? assert.fail("the arm");

type Message = TranscriptContext["messages"][number];
const textOf = (m: Message): string => (m.role === "assistant" ? JSON.stringify(m.content) : typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

describe("the solve-v2-graph arm in a run", () => {
  it("is accepted by the ablation's line rules next to M1, M10 and M6", () => {
    assert.deepEqual(ablationProblems(table, experimentArms("solve-defaults", { host: { capabilities: {} } })), []);
    for (const id of ["M1", "M10", "M6", "M2", "M4"]) assert.ok(arm().lines.includes(id), id);
  });

  it("finishes, keeps the state card and the masking, and gives the prover M4's packet and its two tools", async () => {
    const requests: TranscriptContext[] = [];
    // One scripted prover: its first three requests check, call expand and call graph_query, then it checks again. Any other model call (M4's query extraction) gets a bare answer.
    let step = 0;
    const script = (): AssistantMessage[] => [check("bad_0"), call("expand", { id: "C1" }), call("graph_query", { depth: 1 } as never), ...Array.from({ length: 11 }, (_, k) => check(`bad_${k + 1}`))];
    const responder = (context: TranscriptContext): AssistantMessage => {
      if (!textOf(context.messages[0] as Message).includes("writes Lean 4 proofs")) return say("");
      requests.push(context);
      const next = script()[step++];
      return next ?? say("notes");
    };
    const config = { ...armConfig({ ...table, provers: 1, sessions: 2, thinkingLevel: "off" }, arm()), limits: { turns: 14, contextTokens: 1_000_000 } } as Partial<RunConfig>;
    delete config.intake;
    const responses = Array.from({ length: 60 }, () => responder);
    const { events, result } = await demoRun({ config, responses });
    assert.equal(ofType(events, "run.finished").length, 1);
    assert.equal(result.stopped, undefined);
    const started = ofType(events, "run.started")[0]?.data.config as { lines?: Array<{ id: string }> };
    assert.ok(["M2", "M4"].every((id) => started.lines?.some((l) => l.id === id)));
    assert.ok(requests.length >= 5, `${requests.length} request(s)`);
    const all = requests.map((r) => r.messages.map(textOf).join("\n"));
    // M4 replaces the conversation with its packet at every request, so no request holds an old check result for the masking to hide: it is on
    // (the run's configuration) and has nothing to do. The state card is kept by M4's packet.
    assert.equal((started as { maskOldChecks?: boolean }).maskOldChecks, true, "the masking is on in the run's configuration");
    const counted = buildReport(events);
    assert.equal(counted.tools.expand?.calls, 1, "an expand call is journaled as a tool run of the prover's attempt");
    assert.equal(counted.tools.graph_query?.calls, 1);
    assert.equal(counted.graph?.context?.expandCalls, 1);
    assert.equal(counted.graph?.context?.graphQueryCalls, 1);
    assert.ok((counted.graph?.context?.packets ?? 0) >= 1 && (counted.graph?.context?.packetTokens ?? 0) > 0 && (counted.graph?.context?.factsShown ?? -1) >= 0);
    assert.ok(counted.graph?.graph !== undefined, "M2 ran");
    assert.ok(requests.every((r) => r.messages.filter((m) => m.role === "toolResult").length <= 1), "one check result at most per request: the packet shows the last check only");
    assert.ok(all.some((t) => /Where the problem stands\nState of the problem, written by the harness from its journal/.test(t) && /# Goal C1/.test(t)), "v2's state card is in the packet");
    assert.ok(ofType(events, "node.recorded").some((e) => e.data.kind === "context_packet"), "M4 compiled a packet");
    assert.ok(all.some((t) => /expand\(id\) shows one in full and graph_query explores/.test(t)), "the packet names the two tools");
    // The prover is offered both tools: each call is answered by the tool, not by an unknown-tool error, and its answer is in the next packet's tail.
    assert.ok(all.some((t) => /# Answers to your last tool calls[^\n]*\nexpand:\n[^\n]*C1/.test(t)), "the answer of expand");
    assert.ok(all.some((t) => /# Answers to your last tool calls[^\n]*\ngraph_query:\n\d+ claims?, \d+ edges?/.test(t)), "the answer of graph_query");
  });
});
