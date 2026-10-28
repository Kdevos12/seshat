import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createM2Line } from "@seshat/graph";
import { createM12Line, createM18Line, M18_OPTIONS } from "@seshat/scheduler";
import { buildReport } from "../src/report.ts";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { HYPOTHESIS, m18Answer, proves, SMALL, variants } from "./m18-helpers.ts";
import { certifier, sessionPromptOf } from "./resume-helpers.ts";

const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind);
const data = (events: readonly HarnessEvent[], kind: string) => nodes(events, kind).map((e) => e.data.data as Record<string, unknown>);
const sum = (numbers: readonly number[]) => numbers.reduce((a, b) => a + b, 0);

/**
 * The run: the outer prover's first session fails and costs more than the 10% of a 0.05 dollar budget that moves a problem up, so the problem moves to rung 1
 * before its second session, where M18 asks for variants; its two tasks are worked before the third session.
 */
const script = (): FauxResponseStep[] => [
  check("bad"), say("notes"),
  variants(["small_case", SMALL], ["extra_hypothesis", HYPOTHESIS]),
  check("bad"), say("notes"),
  proves("exact var_ok"), proves("exact var_ok"),
  check("bad"), say("notes"),
];
const BUDGET = 0.05;
const config = { lines: ["M12", "M18"], provers: 1, sessions: 3, budget: { problemUsd: BUDGET }, lineOptions: { M12: { fractions: [0.1] } } as never };
const lines = () => ({ M12: createM12Line(), M18: createM18Line() });

describe("line M18 in a run", () => {
  it("is registered at rung 1, after M12, requiring it and declaring how it resumes", async () => {
    const { LINES } = await import("../src/index.ts");
    const { LINE_ORDER } = await import("@seshat/lines");
    assert.equal(LINES.M18?.id, "M18");
    assert.equal(LINES.M18?.rung, 1);
    assert.deepEqual(LINES.M18?.requires, ["M12"]);
    assert.equal(LINES.M18?.resume, "rebuild");
    assert.ok(LINES.M18?.hooks.beforeProvers !== undefined && LINES.M18.hooks.resumeProblem !== undefined && LINES.M18.hooks.runTask !== undefined);
    assert.equal(LINE_ORDER[LINE_ORDER.indexOf("M12") + 1], "M18");
    assert.equal(M18_OPTIONS.share, 0.2);
  });

  it("makes variant claims and tasks when the ladder moves the problem up, and works them", { timeout: 30000 }, async () => {
    const { result, events, faux } = await demoRun({ lines: lines(), config, lean: new DemoLean(m18Answer), certifier: certifier().certifier, responses: script() });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;
    const moves = ofType(events, "ladder.escalated");
    assert.deepEqual(moves.map((m) => [m.data.from, m.data.to, m.data.lines]), [[0, 1, ["M18"]]]);

    // The variants are claims of the line, each a special case of the target, with an edge that points at it.
    const made = ofType(events, "claim.created").filter((e) => e.actor === "line:M18" && !(e.data.gloss ?? "").startsWith("link lemma"));
    assert.deepEqual(made.map((e) => e.data.statement), [SMALL, HYPOTHESIS]);
    const edges = ofType(events, "edge.added").filter((e) => e.data.kind === "special_case_of");
    assert.deepEqual(edges.map((e) => [e.data.from, e.data.to]), made.map((e) => [e.data.claimId, [claimId]]));
    // Lean checked that the target implies each (the simulated Lean accepts `exact fun h => h` for the link lemma).
    assert.equal(ofType(events, "edge.status_changed").filter((e) => e.data.to === "lean_checked").length, 2);

    // One task each, proposed by the line, worked through the ledger like any task, and ended `done` by the orchestrator.
    const tasks = ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M18");
    assert.deepEqual(tasks.map((t) => [t.data.kind, t.data.claimId, t.data.budget]), made.map((e) => ["prove", e.data.claimId, { sessions: 3 }]));
    for (const task of tasks) {
      assert.deepEqual(ofType(events, "task.status_changed").filter((e) => e.data.taskId === task.data.taskId).map((e) => e.data.to), ["ready", "running", "done"]);
    }

    // The proofs are validated and certified like any other: the variants end `proved`, and the target's status is not touched.
    for (const e of made) {
      assert.deepEqual(ofType(events, "claim.status_changed").filter((s) => s.data.claimId === e.data.claimId).map((s) => s.data.to), ["computed", "proved"]);
    }
    assert.deepEqual(ofType(events, "claim.status_changed").filter((s) => s.data.claimId === claimId), []);
    assert.equal(result.problems[0]?.outcome, "unsolved");

    // The model calls are the line's: the variants once, the sessions on the variants; all of them charged to the problem.
    assert.deepEqual(ofType(events, "model_call.finished").filter((m) => m.data.line === "M18").map((m) => m.data.site), ["curriculum.variants", "curriculum.prove", "curriculum.prove"]);
    assert.equal(faux.getPendingResponseCount(), 0);

    // What the model proposed and tried is unverified: every node the line wrote carries the run's provenance stamp.
    const recorded = nodes(events, "m18_generation").length + nodes(events, "m18_variant").length + nodes(events, "m18_session").length;
    assert.equal(recorded, 1 + 2 + 2);
    const stamped = [...nodes(events, "m18_generation"), ...nodes(events, "m18_variant"), ...nodes(events, "m18_session")].filter((e) => e.data.provenance !== undefined);
    assert.equal(stamped.length, recorded);
  });

  it("does not move the target's status, with the graph's propagation on and every variant proved", { timeout: 30000 }, async () => {
    // A special case follows from the general statement, not the other way: the propagation derives nothing for the target.
    const { events } = await demoRun({
      lines: { ...lines(), M2: createM2Line() },
      config: { ...config, lines: ["M2", "M12", "M18"], lineOptions: { M12: { fractions: [0.1] }, M2: { twin: false } } as never },
      lean: new DemoLean(m18Answer),
      certifier: certifier().certifier,
      responses: script(),
    });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;
    const edge = ofType(events, "edge.added").find((e) => e.data.kind === "special_case_of");
    assert.deepEqual(edge?.data.to, [claimId]);
    const proved = ofType(events, "claim.status_changed").filter((s) => s.data.to === "proved").map((s) => s.data.claimId);
    const variantIds = ofType(events, "claim.created").filter((e) => e.actor === "line:M18" && [SMALL, HYPOTHESIS].includes(e.data.statement)).map((e) => e.data.claimId);
    assert.equal(variantIds.length, 2);
    assert.ok(variantIds.every((id) => proved.includes(id)), "the two variants are proved");
    assert.equal(ofType(events, "claim.status_changed").some((s) => s.data.claimId === claimId), false);
    assert.equal(ofType(events, "problem.finished")[0]?.data.outcome, "unsolved");
  });

  it("feeds the proved special cases and one or two proofs to the next briefing", { timeout: 30000 }, async () => {
    const prompts: string[] = [];
    const watch = (step: FauxResponseStep) => (context: Parameters<typeof sessionPromptOf>[0]) => {
      if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
      return step as never;
    };
    const steps = script();
    const { events } = await demoRun({
      lines: lines(),
      config,
      lean: new DemoLean(m18Answer),
      responses: [watch(steps[0] as FauxResponseStep), steps[1] as never, steps[2] as never, watch(steps[3] as FauxResponseStep), ...steps.slice(4, 7), watch(steps[7] as FauxResponseStep), steps[8] as never],
    });
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[0] ?? "", /Special cases already proved/);
    assert.doesNotMatch(prompts[1] ?? "", /Special cases already proved/, "nothing is proved while the session runs");
    const third = prompts[2] ?? "";
    assert.match(third, /Special cases already proved/);
    assert.ok(third.includes(`- ${SMALL} (Lean checked that the target implies it)`));
    assert.ok(third.includes(HYPOTHESIS));
    // Both proofs are shown (the default is two examples), as theorems the model can read.
    assert.equal((third.match(/exact var_ok/g) ?? []).length, 2);
    assert.match(third, /theorem variant_1 /);
    void events;
  });

  it("shows one proof when it is asked for one, and the same one on the same seed", { timeout: 60000 }, async () => {
    const run = async (seed: number) => {
      const prompts: string[] = [];
      const steps = script();
      const watch = (step: FauxResponseStep) => (context: Parameters<typeof sessionPromptOf>[0]) => {
        if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
        return step as never;
      };
      await demoRun({
        lines: lines(),
        config: { ...config, lineOptions: { M12: { fractions: [0.1] }, M18: { examples: 1, seed } } as never },
        lean: new DemoLean(m18Answer),
        responses: [steps[0] as never, steps[1] as never, steps[2] as never, steps[3] as never, steps[4] as never, steps[5] as never, steps[6] as never, watch(steps[7] as FauxResponseStep), steps[8] as never],
      });
      return /theorem variant_1 (.*) := by/.exec(prompts[0] ?? "")?.[1];
    };
    const [a, b] = [await run(3), await run(3)];
    assert.ok(a !== undefined);
    assert.equal(a, b, "the same seed draws the same example");
    const seen = new Set<string | undefined>();
    for (let seed = 0; seed < 12 && seen.size < 2; seed += 1) seen.add(await run(seed));
    assert.equal(seen.size, 2, "another seed can draw the other proof");
  });

  it("spends no more than its share of the problem's budget, and fails the tasks it cannot pay for", { timeout: 30000 }, async () => {
    // 4% of the budget, 0.002 dollars: the call for the variants and one session fit, and the second variant's task is refused its session.
    const { events, result } = await demoRun({
      lines: lines(),
      config: { ...config, lineOptions: { M12: { fractions: [0.1] }, M18: { share: 0.04 } } as never },
      lean: new DemoLean(m18Answer),
      responses: [...script().slice(0, 6), check("bad"), say("notes")],
    });
    const spent = sum(ofType(events, "model_call.finished").filter((m) => m.data.line === "M18").map((m) => m.data.usd));
    const cap = 0.04 * BUDGET;
    const calls = ofType(events, "model_call.finished").filter((m) => m.data.line === "M18");
    assert.equal(calls.length, 2, "the call for the variants and one session, not the second");
    // It overshoots by at most one call: the last call began under the cap.
    assert.ok(spent > cap - (calls.at(-1)?.data.usd ?? 0) && spent < cap + (calls.at(-1)?.data.usd ?? 0), `${spent} against a cap of ${cap}`);
    const tasks = ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M18");
    const ends = tasks.map((t) => ofType(events, "task.status_changed").filter((e) => e.data.taskId === t.data.taskId).at(-1));
    assert.deepEqual(ends.map((e) => e?.data.to), ["done", "failed"]);
    assert.match(ends[1]?.data.reason ?? "", /the curriculum's share of the budget is spent/);
    assert.equal(result.problems[0]?.outcome, "unsolved");
    // The line's spend is the ladder's: the dollars of rung 1 in the report include the calls of M18, and all the rungs add up to the problem's cost.
    const ladder = buildReport(events).problems[0]?.ladder;
    assert.ok((ladder?.usdByRung["1"] ?? 0) >= spent - 1e-9, JSON.stringify(ladder));
    assert.ok(Math.abs(sum(Object.values(ladder?.usdByRung ?? {})) - (result.problems[0]?.usd ?? NaN)) < 1e-9);
  });

  it("makes nothing until the ladder moves the problem up, and nothing with a share of 0", { timeout: 30000 }, async () => {
    // A budget the first session does not reach 30% of: the problem stays on rung 0 and the line does not ask for anything.
    const idle = await demoRun({
      lines: lines(),
      config: { ...config, budget: { problemUsd: 5 } },
      lean: new DemoLean(m18Answer),
      responses: [check("bad"), say("notes"), check("bad"), say("notes"), check("bad"), say("notes")],
    });
    assert.deepEqual(ofType(idle.events, "ladder.escalated"), []);
    assert.deepEqual(ofType(idle.events, "model_call.finished").filter((m) => m.data.line === "M18"), []);
    assert.deepEqual(ofType(idle.events, "task.created").filter((e) => e.data.proposedBy === "line:M18"), []);

    const none = await demoRun({
      lines: lines(),
      config: { ...config, lineOptions: { M12: { fractions: [0.1] }, M18: { share: 0 } } as never },
      lean: new DemoLean(m18Answer),
      responses: [check("bad"), say("notes"), check("bad"), say("notes"), check("bad"), say("notes")],
    });
    assert.equal(ofType(none.events, "ladder.escalated").length, 1);
    assert.deepEqual(ofType(none.events, "model_call.finished").filter((m) => m.data.line === "M18"), []);
    assert.deepEqual(data(none.events, "m18_generation").map((g) => g.note), ["the share of the budget is 0"]);
  });

  it("drops statements that are not in signature form, repeat the target or mention sorry, and tasks the rest", { timeout: 30000 }, async () => {
    const { events } = await demoRun({
      lines: lines(),
      config,
      lean: new DemoLean(m18Answer),
      responses: [
        check("bad"), say("notes"),
        variants(["small_case", "(n : ℕ) : n + 0 = n"], ["small_case", ": 2 + 0 = 2 := by sorry"], ["prime_case", "no colon here"], ["extra_hypothesis", HYPOTHESIS]),
        check("bad"), say("notes"), proves("exact var_ok"), check("bad"), say("notes"),
      ],
    });
    assert.deepEqual(ofType(events, "claim.created").filter((e) => e.actor === "line:M18" && !(e.data.gloss ?? "").startsWith("link lemma")).map((e) => e.data.statement), [HYPOTHESIS]);
    assert.deepEqual(data(events, "m18_generation").map((g) => [g.proposed, g.kept]), [[4, 1]]);
  });

  it("starts at once with the ladder off", { timeout: 30000 }, async () => {
    const { events } = await demoRun({
      lines: lines(),
      config: { ...config, budget: { problemUsd: 5 }, lineOptions: { M12: { ladder: false } } as never },
      lean: new DemoLean(m18Answer),
      responses: [variants(["small_case", SMALL]), proves("exact var_ok"), check("bad"), say("notes"), check("bad"), say("notes")],
    });
    assert.deepEqual(ofType(events, "ladder.escalated"), []);
    assert.deepEqual(ofType(events, "model_call.finished").filter((m) => m.data.line === "M18").map((m) => m.data.site), ["curriculum.variants", "curriculum.prove"]);
  });
});
