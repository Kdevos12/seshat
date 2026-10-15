import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createFleet, STRATEGY_HINTS, strategySection, type AllocationData } from "@seshat/fleet";
import { framingProblems } from "@seshat/guards";
import { LINES } from "../src/lines.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** The opening message of a session. */
function opening(context: TranscriptContext): string {
  return textOf(context.messages.find((m) => m.role === "user") as Message);
}

/** A response for any session: it checks a proof first, then writes notes after the result. */
function anySession(proof: string): (context: TranscriptContext) => AssistantMessage {
  return (context) => (context.messages.some((m) => m.role === "toolResult") ? say("notes") : check(proof));
}

/** The allocation nodes of a run, in order. */
function allocations(events: readonly HarnessEvent[]): AllocationData[] {
  return ofType(events, "node.recorded")
    .filter((e) => e.data.kind === "allocation")
    .map((e) => e.data.data as AllocationData);
}

const FLEET = { lines: ["M1", "fleet"] };
const seed = (n: number, more: Record<string, unknown> = {}) => ({ lineOptions: { fleet: { seed: n, ...more } } as never });

describe("the fleet policy in a run", () => {
  it("needs M1, whose classified labels its posteriors are made of", async () => {
    await assert.rejects(demoRun({ responses: [], config: { lines: ["fleet"] } }), /line fleet requires line M1, which is not enabled/);
  });

  it("tells each session a strategy, journals the allocation, and writes the strategy on the attempt", async () => {
    const prompts: string[] = [];
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(7), sessions: 1 },
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const [record] = allocations(events);
    assert.equal(ofType(events, "attempt.started")[0]?.data.strategy, record?.strategy);
    assert.match(prompts[0] ?? "", new RegExp(`\\n\\n# Strategy for this session\\nThe harness chose a strategy for this session from what has been tried on this statement: ${record?.strategy} \\(`));
    assert.deepEqual([record?.rule, record?.prover, record?.session, record?.width, record?.waited, record?.attempts], ["thompson", "p1", 1, 1, false, 0]);
    assert.equal(Object.keys(record?.draws ?? {}).length, 12);
    const written = ofType(events, "node.recorded").find((e) => e.data.kind === "allocation");
    assert.equal(written?.actor, "line:fleet");
  });

  it("words its section so that the framing check of M6 has nothing to flag, on any label", () => {
    for (const label of Object.keys(STRATEGY_HINTS)) {
      const section = strategySection(label);
      assert.deepEqual(framingProblems(`${section.title}\n${section.text}`), [], label);
    }
  });

  it("draws the same strategy for the same seed, and others for other seeds", async () => {
    const strategyFor = async (n: number) => {
      const { events } = await demoRun({ config: { ...FLEET, ...seed(n), sessions: 1 }, responses: [check("exact trivial_proof")] });
      return allocations(events)[0]?.strategy;
    };
    const first = await strategyFor(1);
    assert.equal(await strategyFor(1), first);
    const others = new Set(await Promise.all([2, 3, 4, 5, 6, 7].map(strategyFor)));
    assert.ok(others.size >= 2, [...others].join(","));
  });

  it("keeps a strategy while Lean gets further with it, and draws again when it stalls", async () => {
    const { events } = await demoRun({
      config: { ...FLEET, ...seed(3), sessions: 3 },
      responses: [check("omega"), say("one"), check("linarith"), say("two"), check("simp"), say("three")],
    });
    const records = allocations(events);
    // omega left unsolved goals, which is further than nothing; linarith got no further.
    assert.deepEqual(records.map((r) => r.rule), ["thompson", "continued", "thompson"]);
    assert.equal(records[1]?.strategy, records[0]?.strategy);
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.strategy), records.map((r) => r.strategy));
  });

  it("learns from the attempts: the second session's allocation counts the first one's failure", async () => {
    const { events } = await demoRun({
      config: { ...FLEET, ...seed(4), sessions: 2 },
      responses: [check("omega"), say("one"), check("exact trivial_proof")],
    });
    const [first, second] = allocations(events);
    assert.deepEqual([first?.attempts, first?.successRate], [0, 0.5]);
    assert.deepEqual([second?.attempts, second?.successRate], [1, 0.3333]);
  });
});

describe("the fleet's models", () => {
  it("chooses among the models it is given and gives the session the one it chose", async () => {
    const { events } = await demoRun({
      extraModels: ["strong"],
      config: { ...FLEET, ...seed(5, { models: ["faux/prover", "faux/strong"], strategies: false }), sessions: 4 },
      responses: [anySession("omega"), anySession("omega"), anySession("omega"), anySession("omega"), anySession("omega"), anySession("omega"), anySession("omega"), anySession("omega")],
    });
    const records = allocations(events);
    assert.equal(records.length, 4);
    assert.ok(records.every((r) => r.model === "faux/prover" || r.model === "faux/strong"));
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.model), records.map((r) => r.model));
  });

  it("escalates a hard decision to the stronger model, as many times as it may", async () => {
    const { events } = await demoRun({
      extraModels: ["strong"],
      config: { ...FLEET, ...seed(6, { escalateTo: "faux/strong", escalateAfter: 2, escalateBelow: 0.5, maxEscalations: 1, strategies: false }), sessions: 4 },
      responses: Array.from({ length: 8 }, () => anySession("omega")),
    });
    // Two failures make the rate 1/4: the third session goes to the stronger model, the fourth does not.
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.model), ["faux/prover", "faux/prover", "faux/strong", "faux/prover"]);
    assert.deepEqual(allocations(events).map((r) => [r.session, r.model, r.escalated]), [[3, "faux/strong", true]]);
  });

  it("stops the problem before a session starts when a model it names does not exist", async () => {
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(8, { models: ["faux/nobody"], strategies: false }), sessions: 1 },
      responses: [check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.match(result.problems[0]?.reason ?? "", /^the harness failed: line fleet failed in beforeSession: unknown model nobody/);
    assert.equal(ofType(events, "attempt.started").length, 0);
  });
});

describe("the fleet's width", () => {
  const widen = { minAttempts: 1, widenBelow: 0.9, strategies: false, models: ["faux/prover"] };

  it("starts one prover, and the others when the posterior of a single agent is low", async () => {
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(9, widen), provers: 3, sessions: 2 },
      responses: Array.from({ length: 30 }, () => anySession("omega")),
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    const order = events.filter((e) => e.type === "attempt.started" || e.type === "attempt.finished");
    const firstFinish = order.findIndex((e) => e.type === "attempt.finished");
    // Until the first session ended, p1 was the only one to start.
    assert.deepEqual([...new Set(order.slice(0, firstFinish).map((e) => (e.type === "attempt.started" ? e.data.prover : "?")))], ["p1"]);
    const records = allocations(events);
    const byProver = (prover: string) => records.filter((r) => r.prover === prover);
    assert.equal(byProver("p1")[0]?.waited, false);
    assert.deepEqual([byProver("p2")[0]?.waited, byProver("p3")[0]?.waited], [true, true]);
    // One failure puts the rate at 1/3, under 0.9: the width is 3, so p2 and p3 came in while p1 lived on.
    assert.equal(byProver("p2")[0]?.width, 3);
    // p2 and p3 were let in when p1's first session ended, while p1's second session was still to end.
    const allocationAt = (prover: string) => events.findIndex((e) => e.type === "node.recorded" && e.data.kind === "allocation" && (e.data.data as AllocationData).prover === prover);
    const p1Ends = events.flatMap((e, k) => (e.type === "attempt.finished" && ofType(events, "attempt.started").some((s) => s.data.attemptId === e.data.attemptId && s.data.prover === "p1") ? [k] : []));
    assert.equal(p1Ends.length, 2);
    assert.ok(allocationAt("p2") > (p1Ends[0] ?? Infinity) && allocationAt("p2") < (p1Ends[1] ?? 0), "p2 was let in while p1 worked on");
    assert.ok(allocationAt("p3") > (p1Ends[0] ?? Infinity) && allocationAt("p3") < (p1Ends[1] ?? 0), "p3 was let in while p1 worked on");
    assert.equal(ofType(events, "attempt.started").length, 6);
  });

  it("keeps the provers to one at a time while a single agent does well enough", async () => {
    const { events } = await demoRun({
      config: { ...FLEET, ...seed(10, { strategies: false, models: ["faux/prover"] }), provers: 2, sessions: 2 },
      responses: Array.from({ length: 30 }, () => anySession("omega")),
    });
    // The rate stays over 0.3 after one failure (1/3) and falls under it after two (1/4, with the default of 2 attempts): p2 waits for p1's second session.
    const started = ofType(events, "attempt.started").map((e) => `${e.data.prover}.${e.data.iteration}`);
    assert.deepEqual(started.slice(0, 2), ["p1.1", "p1.2"]);
    assert.equal(allocations(events).find((r) => r.prover === "p2")?.waited, true);
  });

  it("does not wait when the option says so", async () => {
    const { events } = await demoRun({
      config: { ...FLEET, ...seed(11, { widen: false, strategies: false, models: ["faux/prover"] }), provers: 3, sessions: 1 },
      responses: Array.from({ length: 12 }, () => anySession("omega")),
    });
    assert.deepEqual(allocations(events).map((r) => r.waited), [false, false, false]);
    const order = events.filter((e) => e.type === "attempt.started" || e.type === "attempt.finished").map((e) => e.type);
    assert.deepEqual(order.slice(0, 3), ["attempt.started", "attempt.started", "attempt.started"]);
  });

  it("frees the provers that wait when another one proves the claim", async () => {
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(12, { strategies: false, models: ["faux/prover"] }), provers: 3, sessions: 2 },
      responses: [check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.prover), ["p1"]);
    assert.deepEqual(result.problems[0]?.attempts, 1);
  });

  it("gives provers on the same claim different strategies while they work at once", async () => {
    const fleet = createFleet({ random: () => () => 0.5 });
    const { events } = await demoRun({
      lines: { ...LINES, fleet },
      config: { ...FLEET, ...seed(13, { widen: false }), provers: 3, sessions: 1 },
      responses: Array.from({ length: 12 }, () => anySession("omega")),
    });
    // Every draw is equal, so the first candidate would win each time without the exclusion.
    const strategies = allocations(events).map((r) => r.strategy);
    assert.equal(new Set(strategies).size, 3, strategies.join(","));
  });
});

describe("the fleet and the provers' notes", () => {
  it("gives a prover the typed summaries of the others' attempts and none of their text", async () => {
    const prompts: string[] = [];
    await demoRun({
      config: { ...FLEET, ...seed(14, { widen: false }), provers: 2, sessions: 1 },
      responses: [
        check("omega"),
        say("SECRET-NOTE-OF-A-PROVER: the key is the lemma foo_bar"),
        (context) => { prompts.push(opening(context)); return say("done"); },
      ],
    });
    // Whichever prover started second, its opening message has no other prover's notes.
    assert.ok(prompts.every((p) => !p.includes("SECRET-NOTE")));
  });
});
