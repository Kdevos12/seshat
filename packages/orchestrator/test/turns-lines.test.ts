import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { BlobStore, type HarnessEvent, Journal } from "@seshat/core";
import { m2Line } from "@seshat/graph";
import { isInterrupted, type Line, type LineRegistry, type Llm } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { lean, toyAnswer } from "../../graph/test/helpers.ts";
import { Ledger } from "../src/budget.ts";
import { lineLlm } from "../src/llm.ts";
import { isTurnEnded, Turn } from "../src/turns.ts";
import { check, DemoLean, demoResume, demoRun, fauxModels, ofType, say } from "./m0-helpers.ts";
import { assertSound, sessionPromptOf } from "./resume-helpers.ts";
import { consortium } from "./turns-helpers.ts";

/**
 * A real line across turns (review round 1, I2): M2 with its refutation side, whose model calls run alongside
 * the provers and are refused once a turn is over. A pause is not a failure of the side: the resumed turn
 * asks only for the calls the journal does not hold, and the run reaches what an uninterrupted run reaches.
 */
const nodesOf = (events: readonly HarnessEvent[], kind: string): Array<Record<string, unknown>> =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => e.data.data as Record<string, unknown>);
/** The nodes of a kind as they stand at the end, with the patches of `node.updated` applied. */
const finalNodes = (events: readonly HarnessEvent[], kind: string): Array<Record<string, unknown>> => {
  const recorded = ofType(events, "node.recorded").filter((e) => e.data.kind === kind);
  return recorded.map((e) => {
    let data = { ...(e.data.data as Record<string, unknown>) };
    for (const u of ofType(events, "node.updated")) if (u.data.nodeId === e.data.nodeId) data = { ...data, ...(u.data.patch as Record<string, unknown>) };
    return data;
  });
};
const twinCalls = (events: readonly HarnessEvent[]): number => ofType(events, "model_call.finished").filter((m) => m.data.site === "graph.attempt").length;
const isTwin = (context: TranscriptContext): boolean => /negation of a statement whose truth is not known/.test(sessionPromptOf(context));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 5) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * M2 as the run sees it, keeping the problem's memory, and telling a test whether the refutation side was refused a
 * call (the turn is over), so that the prover's model need not wait for a side that will not go on.
 */
function watchedM2(): { line: Line; seen: { memory?: MemoryStore; claimId?: string; refused: boolean } } {
  const seen: { memory?: MemoryStore; claimId?: string; refused: boolean } = { refused: false };
  const watch = <P extends { memory: MemoryStore; claimId: string; llm: Llm }>(problem: P): P => {
    seen.memory = problem.memory;
    seen.claimId = problem.claimId;
    const refusing = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        seen.refused = true;
        throw error;
      }
    };
    return {
      ...problem,
      llm: { ...problem.llm, complete: (request) => refusing(() => problem.llm.complete(request)), completeJson: ((request: never) => refusing(() => problem.llm.completeJson!(request))) as Llm["completeJson"] },
    };
  };
  const line: Line = {
    ...m2Line,
    hooks: {
      ...m2Line.hooks,
      beforeProvers: async (problem) => {
        await m2Line.hooks.beforeProvers?.(watch(problem));
      },
      resumeProblem: async (problem, held) => {
        await m2Line.hooks.resumeProblem?.(watch(problem), held);
      },
    },
  };
  return { line, seen };
}

/** The refutation side answers wrong once, then right; the prover waits for the line to settle the claim or to be refused. */
function twinScenario(already = 0) {
  const { line, seen } = watchedM2();
  let calls = already;
  const router = async (context: TranscriptContext): Promise<AssistantMessage> => {
    if (isTwin(context)) {
      calls += 1;
      return say(lean(calls === 1 ? "exact bad" : "exact trivial_proof"));
    }
    const memory = seen.memory as MemoryStore;
    await until(
      () => memory.edges({ to: seen.claimId as string, kinds: ["negation_of"] }).some((e) => memory.claim(e.from)?.status === "computed") || calls >= 2 || seen.refused,
      "the refutation side to be done or refused",
    );
    return context.messages.some((m) => m.role === "toolResult") ? say("I will stop here.") : check("bad");
  };
  return { lines: { M2: line } as LineRegistry, responses: Array.from({ length: 60 }, () => router) };
}

describe("line M2 across turns", () => {
  const options = { lines: ["M2"], sessions: 3 };

  async function inTurns(limits: readonly number[]) {
    let scenario = twinScenario();
    const first = await demoRun({ lines: scenario.lines, config: { ...options, consortium: consortium({ tokens: limits[0] ?? 1e12 }) }, lean: new DemoLean(toyAnswer), responses: scenario.responses });
    let events = first.events;
    for (let turn = 2; turn <= limits.length + 1 && ofType(events, "run.finished").length === 0; turn++) {
      scenario = twinScenario(twinCalls(events));
      const next = await demoResume({ dir: first.dir, bench: first.bench, lines: scenario.lines, lean: new DemoLean(toyAnswer), responses: scenario.responses, turns: { limit: { tokens: limits[turn - 1] ?? 1e12 } } });
      events = next.events;
    }
    return { events, outcomes: first.result.problems.map((p) => p.outcome) };
  }

  it("reaches what an uninterrupted run reaches: the side is not lost when a turn ends under it", async () => {
    const whole = twinScenario();
    const reference = await demoRun({ lines: whole.lines, config: options, lean: new DemoLean(toyAnswer), responses: whole.responses });
    assert.deepEqual(reference.result.problems.map((p) => p.outcome), ["unsolved"]);
    assert.deepEqual(nodesOf(reference.events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "refutation", 2]]);
    assert.deepEqual(finalNodes(reference.events, "twin_work").map((n) => [n.end, n.tries]), [["refutation", 2]]);

    // The limit of one token ends the turn at the side's first answer: its second call is refused, and the next turn makes it.
    const cut = await inTurns([1]);
    assert.equal(ofType(cut.events, "turn.ended").length, 2);
    assert.equal(ofType(cut.events, "turn.ended")[0]?.data.reason, "tokens");
    assert.equal(twinCalls(cut.events), 2, "the two calls the side has, once each");
    assert.deepEqual(finalNodes(cut.events, "twin_work").map((n) => [n.end, n.tries]), [["refutation", 2]], "the side is not recorded as an error");
    assert.deepEqual(nodesOf(cut.events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "refutation", 2]]);
    assert.deepEqual(ofType(cut.events, "problem.finished").map((e) => e.data.outcome), ["unsolved"]);
    assertSound(cut.events);
  });

  // Sampled: the limits of the first two turns, in tokens, 1 (after the first response), 3000 and 6000 (a response here is
  // about 2,300 tokens, mostly the prompt), the last turn unlimited. The assertions do not depend on where a cut falls.
  // Not sampled: cuts by dollars or minutes, a line other than M2, two problems with the side, a run cut in more than three turns.
  const SAMPLED = [1, 3000, 6000];
  for (const first of SAMPLED) {
    for (const second of [1, 6000]) {
      it(`M0 with M2 reaches the same twin and outcome when turn 1 is cut at ${first} tokens and turn 2 at ${second}`, async () => {
        const run = await inTurns([first, second]);
        assert.deepEqual(ofType(run.events, "problem.finished").map((e) => e.data.outcome), ["unsolved"], `turns ended by ${ofType(run.events, "turn.ended").map((e) => e.data.reason).join(", ")}`);
        assert.deepEqual(nodesOf(run.events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "refutation", 2]]);
        assert.equal(twinCalls(run.events), 2, "no call of the side lost or asked for twice");
        assert.deepEqual(finalNodes(run.events, "twin_work").map((n) => [n.end, n.tries]), [["refutation", 2]], "the side ends once, as it does uninterrupted");
        assertSound(run.events);
      });
    }
  }
});

describe("the point where a request is sent (review round 1, I3)", () => {
  /** A line that holds prover p2 in `briefing` (inside `openSession`, after the prover's checks of the turn) until `release` is called: it has passed the gates and has not sent. */
  const holding = (held: Promise<void>, release: () => void): Line => ({
    id: "M1",
    title: "holds a prover between its check of the turn and its request",
    requires: [],
    resume: "stateless",
    hooks: {
      briefing: async (session) => {
        if (session.prover === "p2") await held;
        return undefined;
      },
      // p1's response has been counted by now, and it reached the limit: p2 may go on.
      afterCheck: async (session) => {
        if (session.prover === "p1") release();
        return undefined;
      },
    },
  });

  it("sends no request after the limit, even from a prover that passed every earlier check before the limit was reached", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const run = await demoRun({
      lines: { M1: holding(held, release) },
      config: { lines: ["M1"], provers: 2, sessions: 3, consortium: consortium({ tokens: 1 }) },
      // The first response (prover p1's) reaches the limit, and only then is p2 let go of: its request must not be sent.
      responses: Array.from({ length: 10 }, () => check("bad")),
    });
    assert.equal(run.faux.state.callCount, 1, "one request was sent in all: p1's");
    assert.equal(ofType(run.events, "turn.ended")[0]?.data.reason, "tokens");
    // The refused request ended p2's session with the turn, not with an error.
    const attempts = ofType(run.events, "attempt.finished");
    assert.ok(attempts.every((a) => a.data.stoppedBy === "turn"), attempts.map((a) => a.data.stoppedBy).join(","));
    assert.equal(attempts.some((a) => a.data.error !== undefined), false);
    assertSound(run.events);
  });

  it("refuses a line's one-shot call when the turn ended while the model was being resolved, and sends nothing", async () => {
    const { models, faux } = fauxModels();
    faux.setResponses([say("an answer")]);
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-llm-")), "run_1");
    const root = new Ledger();
    const turn = new Turn({ number: 1, limit: { tokens: 1000 }, source: "test", startSpend: { usd: 0, inputTokens: 0, outputTokens: 0 } });
    root.observe((cost) => turn.charge(cost));
    const model = faux.getModel();
    const llm = lineLlm({
      line: "M2",
      journal,
      blobs: new BlobStore(join(mkdtempSync(join(tmpdir(), "mh-llm-")), "blobs")),
      models,
      model: `${model.provider}/${model.id}`,
      // Another response ends the turn while the model is being resolved.
      resolveModel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        turn.strike({ reason: "tokens", detail: "another response reached the limit" });
        return model;
      },
      thinkingLevel: "off",
      ledger: root.child(),
      problemId: "prb_1",
      signal: new AbortController().signal,
      turn,
    });
    await assert.rejects(() => llm.complete({ prompt: "p", site: "graph.attempt" }), (error: unknown) => isTurnEnded(error) && isInterrupted(error));
    assert.equal(faux.state.callCount, 0, "no request was sent");
    assert.equal(journal.projection.modelCallsOfProblem("prb_1").length, 0);
    journal.close();
  });
});
