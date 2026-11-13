import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { BLUEPRINT_FORMAT, createM12Line, PLANNER_VERSION } from "@seshat/scheduler";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { BP_AUX, BP_PROOF, blueprintAnswer, HARD_AUX } from "./blueprint-helpers.ts";
import { assertSound, consumed, sessionPromptOf } from "./resume-helpers.ts";

/** The nodes of a kind as they stand at the end of the run: what was recorded, with the merge patches applied after. */
const nodes = (events: readonly HarnessEvent[], kind: string) =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => {
    const patches = ofType(events, "node.updated").filter((u) => u.data.nodeId === e.data.nodeId).map((u) => u.data.patch as Record<string, unknown>);
    return { nodeId: e.data.nodeId, claimId: e.data.claimId, ...(e.data.data as Record<string, unknown>), ...Object.assign({}, ...patches) } as Record<string, unknown> & { nodeId: string };
  });
const OPTIONS = { blueprints: true, refine: true, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0 };
const planned = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.planner");
const holeClaims = (events: readonly HarnessEvent[]) => ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"));
const statusOf = (events: readonly HarnessEvent[], claimId: unknown) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === claimId).map((e) => e.data.to);
const answer = (aux: string, proof: string) => say(JSON.stringify({ aux, proof }));
/** The prompt of the planner call (a request with no assistant message and the planner's version in it), kept when the response is built. */
const asked = (prompts: string[], response: ReturnType<typeof say>) => (context: Parameters<typeof sessionPromptOf>[0]) => {
  prompts.push(sessionPromptOf(context));
  return response;
};

const THIRD = `lemma aux_third (n : ℕ) : n * 1 = n := by
  sorry`;

/** A blueprint with one hole that nothing proves (`aux_hard`) and one the battery closes (`aux_third`). */
const HARD_BLUEPRINT = `${HARD_AUX}\n\n${THIRD}`;
const HARD_PROOF = "exact main_ok aux_hard aux_third";
/** What the planner writes for it: `aux_hard` split in two, each saying it refines it; `aux_third` as it was. */
const SPLIT_AUX = `-- refines: aux_hard
lemma aux_h1 (n : ℕ) : n + 2 = n + 1 + 1 := by
  sorry

-- refines: aux_hard
lemma aux_h2 (n : ℕ) : n + 1 + 1 = 2 + n := by
  sorry

${THIRD}`;
const SPLIT_PROOF = "exact main_ok aux_h1 aux_h2 aux_third";

async function run(responses: Array<ReturnType<typeof say> | ((context: Parameters<typeof sessionPromptOf>[0]) => ReturnType<typeof say>)>, options: Record<string, unknown> = {}, config: Record<string, unknown> = {}, lean = new DemoLean(blueprintAnswer)) {
  return await demoRun({
    lines: { M12: createM12Line() },
    config: { lines: ["M12"], provers: 1, sessions: 1, ...config, lineOptions: { M12: { ...OPTIONS, ...options } } },
    lean,
    responses: responses as never,
  });
}

describe("refinement rounds (CA12, PA11)", () => {
  it("case a: revises a blueprint Lean refused into a healthy one, whose holes are registered", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    // aux_right is used by nothing and aux_left, aux_third are not named by the main proof: every hole is out of reach.
    const { events, faux } = await run(
      [check("exact main_ok", BP_AUX), say("Done."), asked(prompts, answer(BP_AUX, BP_PROOF))],
      { maxInnerTasks: 0 },
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    const [first, second, ...more] = nodes(events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(first?.healthy, false);
    assert.match(String(first?.problem), /aux_right does not reach the target/);
    assert.equal(second?.healthy, true);
    assert.equal(second?.planner, true);
    assert.equal(second?.round, 1);
    assert.equal(second?.refinedFrom, first?.nodeId);
    assert.deepEqual(second?.depth, [0, 0, 0]);
    assert.equal(second?.registered, true);
    assert.equal(holeClaims(events).length, 3, "the holes of the planner's blueprint are claims");
    assert.equal(ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into").length, 2);
    // One call at the site of the planner, a model call of the line.
    const [call, ...rest] = planned(events);
    assert.equal(rest.length, 0);
    assert.equal(call?.data.line, "M12");
    assert.equal(call?.data.outcome, "ok");
    // The prompt: the version, the target, the blueprint, why it was refused, the format; and no conversation.
    const prompt = prompts[0] ?? "";
    assert.ok(prompt.includes(PLANNER_VERSION));
    assert.match(prompt, /theorem target \(n : ℕ\) : n \+ 0 = n/);
    assert.ok(prompt.includes("lemma aux_left"));
    assert.ok(prompt.includes("exact main_ok"));
    assert.match(prompt, /This blueprint was not accepted: aux_right does not reach the target/);
    assert.ok(prompt.includes(BLUEPRINT_FORMAT));
    assert.match(prompt, /- aux_right: not registered, depth 0/);
    assert.doesNotMatch(prompt, /Done\./);
  });

  it("case b: splits a hole that ended too hard with refines; the hole that did not change keeps its claim, its status and gets no session", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events, faux } = await run(
      [
        check(HARD_PROOF, HARD_BLUEPRINT),
        say("Two lemmas are left."),
        say("I cannot do this."), // the session on aux_hard: too_hard (aux_third is closed by the battery)
        asked(prompts, answer(SPLIT_AUX, SPLIT_PROOF)),
        check("exact hole_ok"),
        check("exact hole_ok"),
      ],
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    const sketches = nodes(events, "m12_sketch");
    assert.equal(sketches.length, 2);
    const [first, second] = sketches;
    assert.deepEqual(first?.names, ["aux_hard", "aux_third"]);
    assert.equal(second?.healthy, true);
    assert.deepEqual(second?.names, ["aux_h1", "aux_h2", "aux_third"]);
    assert.deepEqual(second?.depth, [1, 1, 0], "a hole that refines aux_hard has its depth plus one; aux_third has the depth it had");
    assert.equal(second?.refinedFrom, first?.nodeId);
    // Four claims: aux_third is not made again.
    const claims = holeClaims(events);
    assert.equal(claims.length, 4);
    const [, third] = (first?.holes as string[] | undefined) ?? [];
    assert.deepEqual(second?.holes, [(claims[2] as (typeof claims)[number]).data.claimId, (claims[3] as (typeof claims)[number]).data.claimId, third]);
    assert.deepEqual(statusOf(events, third), ["computed"], "its status is the one it had, and it changed once");
    const sessions = nodes(events, "m12_session");
    assert.equal(sessions.filter((n) => n.claimId === third).length, 0, "no session on the hole that did not change");
    assert.equal(sessions.length, 3, "one on aux_hard, one on each new hole");
    assert.deepEqual(nodes(events, "hole_verdict").map((v) => v.verdict), ["too_hard", "proved", "proved", "proved"]);
    // The prompt says what happened to each hole.
    const prompt = prompts[0] ?? "";
    assert.match(prompt, /- aux_hard \[\w+\]: open, verdict too_hard, depth 0, last: the session ended \(\w+\) with no verdict/);
    assert.match(prompt, /- aux_third \[\w+\]: computed, verdict proved, depth 0/);
    assert.doesNotMatch(prompt, /This blueprint was not accepted/);
    assert.equal(planned(events).length, 1);
  });

  it("does nothing without the option refine: a hole that ended too hard is the end of it", { timeout: 60000 }, async () => {
    const { events } = await run([check(HARD_PROOF, HARD_BLUEPRINT), say("Two lemmas are left."), say("I cannot do this.")], { refine: false });
    assert.equal(nodes(events, "m12_sketch").length, 1);
    assert.equal(planned(events).length, 0);
    assert.equal(nodes(events, "m12_sketch")[0]?.depth, undefined);
  });
});

describe("refinement rounds: the gate", () => {
  it("skips a round the budget gate refuses: the gate journals the skip, the call is not made and the gate is asked once for the state", { timeout: 60000 }, async () => {
    const { events } = await run(
      [check("exact main_ok", BP_AUX), say("Done."), answer(BP_AUX, BP_PROOF)],
      { maxInnerTasks: 0 },
      { seed: "refine-gate", budget: { problemUsd: 1 }, gate: { floor: 0, share: { task: 0.0001 } } },
    );
    const skips = ofType(events, "budget.gated").map((e) => e.data).filter((g) => g.site === "task");
    assert.deepEqual(skips.map((g) => g.action), ["skip"]);
    assert.equal(planned(events).length, 0);
    assert.equal(nodes(events, "m12_sketch").length, 1);
  });

  it("makes the round when the gate lets it through, and records the gate's answer for it", { timeout: 60000 }, async () => {
    const { events } = await run(
      [check("exact main_ok", BP_AUX), say("Done."), answer(BP_AUX, BP_PROOF)],
      { maxInnerTasks: 0 },
      { seed: "refine-gate", budget: { problemUsd: 1 }, gate: { floor: 0, share: { task: 1 } } },
    );
    assert.deepEqual(ofType(events, "budget.gated").map((e) => e.data).filter((g) => g.site === "task").map((g) => g.action), ["launch"]);
    assert.equal(planned(events).length, 1);
    assert.equal(nodes(events, "m12_sketch").filter((n) => n.healthy === true).length, 1);
  });
});

/** A chain of refinements: each round splits nothing but replaces the hole that ended too hard by one that refines it. */
const link = (k: number): string => `-- refines: aux_a${k - 1}
lemma aux_a${k} (n : ℕ) : n + ${k + 2} = ${k + 2} + n := by
  sorry`;
const FIRST = `lemma aux_a0 (n : ℕ) : n + 2 = 2 + n := by
  sorry`;
const chain = (rounds: number, prompts: string[]) => [
  check("exact main_ok aux_a0", FIRST),
  say("One lemma is left."),
  say("too hard"),
  ...Array.from({ length: rounds }, (_, k) => [asked(prompts, answer(link(k + 1), `exact main_ok aux_a${k + 1}`)), say("too hard")]).flat(),
];

describe("refinement rounds: depth and caps", () => {
  it("refuses a blueprint whose hole would be deeper than 3, with the reason, and tells the planner each hole's depth", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events } = await run(chain(4, prompts), { maxRefinements: 4 });
    const sketches = nodes(events, "m12_sketch");
    assert.deepEqual(sketches.map((n) => [n.round, n.healthy, n.depth]), [[undefined, true, [0]], [1, true, [1]], [2, true, [2]], [3, true, [3]], [4, false, [4]]]);
    assert.equal(sketches[4]?.problem, "aux_a4 refines too deep (depth 4, at most 3)");
    assert.match(prompts[3] ?? "", /- aux_a3 \[\w+\]: open, verdict too_hard, depth 3/);
    assert.match(prompts[3] ?? "", /a hole deeper than 3 is refused/);
    assert.equal(nodes(events, "m12_session").length, 4, "no session on the refused blueprint's hole");
  });

  it("makes at most maxRefinements rounds for a problem, though the last hole ended too hard", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events } = await run(chain(1, prompts), { maxRefinements: 1 });
    assert.equal(nodes(events, "m12_sketch").length, 2);
    assert.equal(planned(events).length, 1);
    assert.equal(nodes(events, "m12_session").length, 2);
  });

  it("makes no round at all with maxRefinements 0", { timeout: 60000 }, async () => {
    const { events } = await run(chain(0, []), { maxRefinements: 0 });
    assert.equal(planned(events).length, 0);
    assert.equal(nodes(events, "m12_sketch").length, 1);
  });
});

describe("refinement rounds: a planner that fails", () => {
  it("is no round, stops the rounds of the problem for the rest of the run, and says why in the journal", { timeout: 60000 }, async () => {
    const down = fauxAssistantMessage([], { stopReason: "error", errorMessage: "the model is down" });
    const { events } = await run([check("exact main_ok", BP_AUX), say("Done."), down, down, down, down, down, down], { maxInnerTasks: 0 });
    assert.equal(nodes(events, "m12_sketch").length, 1, "no record: it is no round");
    const [stop, ...more] = nodes(events, "m12_refine_stop");
    assert.equal(more.length, 0);
    assert.equal(stop?.round, 1);
    assert.match(String(stop?.reason), /model/);
    assert.ok(planned(events).every((m) => m.data.outcome !== "ok"));
  });

  it("an answer that is not a blueprint is a round that counts, and the next round (case a) may try again", { timeout: 60000 }, async () => {
    const { events } = await run([check("exact main_ok", BP_AUX), say("Done."), say("I have no idea."), say("still no JSON"), answer(BP_AUX, BP_PROOF)], { maxInnerTasks: 0 });
    const sketches = nodes(events, "m12_sketch");
    assert.deepEqual(sketches.map((n) => [n.planner, n.round, n.healthy]), [[undefined, undefined, false], [true, 1, false], [true, 2, true]]);
    assert.match(String(sketches[1]?.problem), /not a blueprint/);
  });
});

describe("refinement rounds in a resumed run", () => {
  const script = () => [
    check(HARD_PROOF, HARD_BLUEPRINT),
    say("Two lemmas are left."),
    say("I cannot do this."),
    answer(SPLIT_AUX, SPLIT_PROOF),
    check("exact hole_ok"),
    check("exact hole_ok"),
  ];
  const first = () => demoRun({
    lines: { M12: createM12Line() },
    config: { lines: ["M12"], provers: 1, sessions: 1, lineOptions: { M12: OPTIONS } },
    lean: new DemoLean(blueprintAnswer),
    responses: script(),
  });
  const resumed = async (whole: Awaited<ReturnType<typeof first>>, cut: number) =>
    await demoResume({
      dir: killedAt(whole.dir, cut),
      bench: whole.bench,
      responses: script().slice(consumed(whole.events.slice(0, cut))),
      lines: { M12: createM12Line() },
      lean: new DemoLean(blueprintAnswer),
    });

  it("counts the rounds from the records and does not make a round again whose record exists", { timeout: 60000 }, async () => {
    const whole = await first();
    const cut = whole.events.findIndex((e) => e.type === "node.recorded" && e.data.kind === "m12_sketch" && (e.data.data as { planner?: boolean }).planner === true) + 1;
    assert.ok(cut > 0);
    const run = await resumed(whole, cut);
    assertSound(run.events);
    assert.equal(planned(run.events).length, 1, "the call is not made again");
    assert.equal(nodes(run.events, "m12_sketch").length, 2, "nor the record");
    assert.equal(holeClaims(run.events).length, 4);
    assert.equal(nodes(run.events, "m12_session").length, 3);
    const third = (nodes(run.events, "m12_sketch")[0]?.holes as string[])[1];
    assert.deepEqual(statusOf(run.events, third), ["computed"]);
  });

  it("asks again for a round cut while its call was in flight: the lost call is not in the journal, the round is made once", { timeout: 60000 }, async () => {
    const whole = await first();
    const cut = whole.events.findIndex((e) => e.type === "model_call.finished" && e.data.site === "scheduler.planner");
    assert.ok(cut > 0);
    const run = await resumed(whole, cut);
    assertSound(run.events);
    assert.equal(planned(run.events).length, 1);
    assert.equal(nodes(run.events, "m12_sketch").length, 2);
    assert.deepEqual(nodes(run.events, "m12_sketch")[1]?.names, ["aux_h1", "aux_h2", "aux_third"]);
    assert.equal(nodes(run.events, "m12_session").length, 3);
  });
});

describe("refinement rounds: what memory already holds", () => {
  it("reuses a statement that is computed already, under whatever name the planner gives it: the same claim, and no session", { timeout: 60000 }, async () => {
    const renamed = SPLIT_AUX.replace("aux_third", "aux_three");
    const { events, faux } = await run([
      check(HARD_PROOF, HARD_BLUEPRINT), say("Two lemmas are left."), say("I cannot do this."),
      answer(renamed, "exact main_ok aux_h1 aux_h2 aux_three"), check("exact hole_ok"), check("exact hole_ok"),
    ]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [first, second] = nodes(events, "m12_sketch");
    assert.deepEqual(second?.names, ["aux_h1", "aux_h2", "aux_three"]);
    assert.equal((second?.holes as string[])[2], (first?.holes as string[])[1], "aux_three is the claim aux_third was");
    assert.equal(holeClaims(events).length, 4);
    assert.equal(nodes(events, "m12_session").length, 3, "none on the claim that was computed");
  });
});
