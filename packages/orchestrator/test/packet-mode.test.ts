import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Line } from "@seshat/lines";
import { checkConfig, DEFAULT_CONFIG, PACKET_MODES, type PacketMode } from "../src/index.ts";
import { cacheReport } from "../src/cache-report.ts";
import { check, demoRun, ofType } from "./m0-helpers.ts";

/**
 * The packet modes of PD2 (documentation/lines.md, "Packet modes"): on a scripted session of four requests, with a
 * faux provider that caches the longest common prefix of a session's requests.
 */
const PREMISES = Array.from({ length: 40 }, (_, k) => `premise_${k}: a lemma about n + ${k} = ${k} + n, stated in full so that it takes room`);

const FACTS = Array.from({ length: 40 }, (_, k) => `fact_${k}: what the project has learned about the goal, number ${k}, in a sentence that takes room`);

/** A line whose prefix comes in another order on every request, and whose tail reads the last Lean feedback. */
const line: Line = {
  id: "M4",
  title: "a packet",
  requires: [],
  hooks: {
    contextPacket: async (_session, request) => ({
      prefix: `Goal: n + 0 = n.\n${[...PREMISES.slice(request.request), ...PREMISES.slice(0, request.request)].join("\n")}`,
      tail:
        `Request ${request.request}. Last Lean feedback: ${request.transcript.findLast((e) => e.role === "tool")?.text.split("\n")[0] ?? "no check yet"}\n` +
        FACTS.map((fact) => `${fact} (seen at request ${request.request})`).join("\n"),
    }),
  },
};

async function solve(packetMode: PacketMode | undefined) {
  const requests: TranscriptContext[] = [];
  const step = (proof: string) => (context: TranscriptContext) => (requests.push(structuredClone(context)), check(proof));
  const run = await demoRun({
    lines: { M4: line },
    config: { lines: ["M4"], limits: { turns: 40, contextTokens: 120_000 }, ...(packetMode !== undefined ? { packetMode } : {}) },
    responses: [step("bad"), step("bad"), step("bad"), step("exact trivial_proof")],
  });
  return { ...run, requests };
}

describe("packetMode", () => {
  it("is checked, recorded when given, and prefix_tail by default", async () => {
    assert.deepEqual(PACKET_MODES, ["prefix_tail", "append_only", "recompiled"]);
    assert.deepEqual(checkConfig({ ...DEFAULT_CONFIG, selection: {}, model: "p/m", packetMode: "append_only" }), []);
    assert.match(checkConfig({ ...DEFAULT_CONFIG, selection: {}, model: "p/m", packetMode: "sideways" as PacketMode }).join(), /packetMode must be one of prefix_tail, append_only, recompiled/);
    const unset = await solve(undefined);
    const explicit = await solve("prefix_tail");
    assert.equal("packetMode" in (ofType(unset.events, "run.started")[0]?.data.config as object), false);
    assert.equal((ofType(explicit.events, "run.started")[0]?.data.config as { packetMode?: string }).packetMode, "prefix_tail");
    assert.deepEqual(unset.requests.map((r) => JSON.stringify(r.messages.map((m) => m.content))), explicit.requests.map((r) => JSON.stringify(r.messages.map((m) => m.content))));
  });

  it("append_only compiles the packet once and keeps the history byte-identical across requests", async () => {
    const { requests, result } = await solve("append_only");
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(requests.length, 4);
    for (let k = 1; k < requests.length; k += 1) {
      const before = (requests[k - 1] as TranscriptContext).messages;
      const now = (requests[k] as TranscriptContext).messages;
      assert.ok(now.length > before.length, "the history grows by the model's output and the tool result");
      for (const [i, message] of before.entries()) {
        assert.equal(Buffer.from(JSON.stringify(now[i])).equals(Buffer.from(JSON.stringify(message))), true, `request ${k + 1}: message ${i} is the one of request ${k}`);
      }
    }
    // The packet was compiled for request 1 and not again: the later requests read "Request 1".
    const text = (r: TranscriptContext) => JSON.stringify(r.messages.find((m) => m.role === "user")?.content);
    for (const r of requests) assert.match(text(r), /Request 1\. Last Lean feedback: no check yet/);
    assert.doesNotMatch(text(requests[3] as TranscriptContext), /Request 2\./);
    // The tool results the model read are in the later requests, as they came.
    assert.equal((requests[3] as TranscriptContext).messages.filter((m) => m.role === "toolResult").length, 3);
  });

  it("prefix_tail rewrites the history for each request: the tail changes, and nothing but the prefix is kept", async () => {
    const { requests } = await solve("prefix_tail");
    for (const r of requests) assert.equal(r.messages.filter((m) => m.role === "toolResult").length, 0);
    const tails = requests.map((r) => JSON.stringify(r.messages.find((m) => m.role === "user")?.content));
    assert.equal(new Set(tails).size, 4);
  });

  it("differs in dollars and in the share read from the cache between the modes", async () => {
    const reports = new Map<PacketMode, { usd: number; cached: number; input: number; ratio: number | undefined }>();
    for (const mode of PACKET_MODES) {
      const { result, events } = await solve(mode);
      assert.equal(result.problems[0]?.outcome, "candidate");
      const cache = cacheReport(events);
      reports.set(mode, { usd: result.report.usd, cached: result.report.cachedInputTokens, input: result.report.inputTokens, ratio: cache?.total.ratio });
    }
    const of = (mode: PacketMode) => reports.get(mode) as { usd: number; cached: number; input: number; ratio: number | undefined };
    const [tail, append, recompiled] = [of("prefix_tail"), of("append_only"), of("recompiled")] as const;
    // The frozen prefix is read from the cache and the tail is not; the whole history is read in append_only; the recompiled prefix is lost.
    assert.ok(append.cached > tail.cached && tail.cached > recompiled.cached, JSON.stringify([...reports]));
    assert.ok((append.ratio ?? 0) > (tail.ratio ?? 0) && (tail.ratio ?? 0) > (recompiled.ratio ?? 0), JSON.stringify([...reports]));
    assert.ok(append.usd < tail.usd && tail.usd < recompiled.usd, JSON.stringify([...reports]));
  });
});
