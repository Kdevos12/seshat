import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import { BP_AUX, BP_PROOF } from "./blueprint-helpers.ts";
import { liftAnswer } from "./lift-helpers.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";

/** Long proofs (LP2, DP1, DP3): the faux provider and a simulated Lean that prints what `extract_goal` prints. */
type Context = Parameters<typeof sessionPromptOf>[0];
const PROOF = "Proof. Step 1: zero is a right identity. Step 2: one is a right identity. Step 3: zero is a left identity. Step 4: commute.\n\nMathlib facts:\n- Nat.add_zero";
const verdict = say(JSON.stringify({ verdict: "correct", findings: ["ok"] }));
const informal = [say(PROOF), verdict, verdict, verdict];
const draftOf = (proof: string) => say(JSON.stringify({ proof }));
const answer = (aux: string, proof: string) => say(JSON.stringify({ aux, proof }));

/** Four steps; the simulated Lean closes the second by a tactic. */
const FOUR = `-- step 1: zero is a right identity
have h_1 : 1 * n = n := by sorry
-- step 2: one is a right identity
have h_2 : n * 1 = n := by sorry
-- step 3: zero is a left identity
have h_3 : 0 + n = n := by sorry
-- step 4: commute
have h_4 : n + 0 = 0 + n := by sorry
exact main_ok`;

/** The nodes of a kind as they stand at the end of the run: what was recorded, with the merge patches applied after. */
const nodes = (events: readonly HarnessEvent[], kind: string) =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => {
    const patches = ofType(events, "node.updated").filter((u) => u.data.nodeId === e.data.nodeId).map((u) => u.data.patch as Record<string, unknown>);
    return { nodeId: e.data.nodeId, ...(e.data.data as Record<string, unknown>), ...Object.assign({}, ...patches) } as Record<string, unknown> & { nodeId: string };
  });
const planned = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.planner");

async function run(responses: unknown[], config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return await demoRun({
    lines: { M12: createM12Line() },
    config: {
      lines: ["M12"], provers: 1, sessions: 1, informalFirst: {}, triage: true, longProof: {}, ...config,
      lineOptions: { M12: { blueprints: true, refine: true, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0, maxInnerTasks: 0, ...options } },
    },
    lean: new DemoLean(liftAnswer),
    responses: responses as never,
  });
}

describe("the draft from the informal proof, lifted by Lean (LP2, DP1)", () => {
  it("a 4-step draft whose battery closes one step is a healthy blueprint of 3 holes, registered before the first outer session", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events, faux } = await run([...informal, ((c: Context) => { prompts.push(sessionPromptOf(c)); return draftOf(FOUR); }) as never, check("exact bad"), say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft, ...more] = nodes(events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(draft?.healthy, true);
    assert.equal(draft?.planner, true);
    assert.equal(draft?.fromInformal, true);
    assert.equal(draft?.lifted, true);
    assert.equal(draft?.round, undefined, "the draft is not a refinement round");
    assert.deepEqual(draft?.names, ["aux_h_1", "aux_h_3", "aux_h_4"]);
    assert.equal(draft?.registered, true);
    assert.equal((draft?.holes as string[]).length, 3);
    // The battery closed one of the four steps with no model call, and the other three became holes.
    const [battery] = nodes(events, "sorry_battery");
    assert.deepEqual([battery?.tried, battery?.closed], [4, 1]);
    // The link lemma of the decomposition is checked by Lean, as for any blueprint; the steps carry their context in their statements, so no hole uses another.
    assert.deepEqual(draft?.uses, [[], [], []]);
    assert.equal(ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into").length, 1);
    assert.equal(planned(events).length, 1);
    assert.match(prompts[0] ?? "", /Draft prompt draft-1\. /);
    assert.match(prompts[0] ?? "", /-- step 1: <the informal step, in one line>/);
    assert.match(prompts[0] ?? "", /> Proof\. Step 1/);
    // The informal proof sets no status: only Lean's checks do, and none made the target proved.
    assert.equal(ofType(events, "claim.status_changed").some((e) => e.data.to === "proved"), false);
    // The statements the holes carry are what extract_goal printed: the theorem's binders, then the earlier steps (the closed one included).
    const statements = ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && (e.data.gloss ?? "").startsWith("aux_h_")).map((e) => String(e.data.statement ?? ""));
    assert.equal(statements.length, 3);
    assert.ok(statements.some((t) => t.includes("(h_1 : 1 * n = n) (h_2 : n * 1 = n)") && t.endsWith(": 0 + n = n")), statements.join(" | "));
  });

  it("lifts a have inside a cases branch and one whose type mentions an intro'd variable", { timeout: 60000 }, async () => {
    const proof = `intro k
-- step 1: zero on the right
have h_1 : k + 0 = k := by sorry
induction n with
| zero =>
  -- step 2: zero plus zero
  have h_2 : 0 + 0 = 0 := by sorry
  exact main_ok
| succ m ih => exact main_ok`;
    const { events, faux } = await run([...informal, draftOf(proof), check("exact bad"), say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft] = nodes(events, "m12_sketch");
    assert.equal(draft?.healthy, true, String(draft?.problem ?? draft?.errors));
    assert.deepEqual(draft?.names, ["aux_h_1", "aux_h_2"]);
  });

  it("sends a draft whose extracted statement does not compile to the first refinement round", { timeout: 60000 }, async () => {
    // `intro _` names nothing: the statement extract_goal prints has `x✝`, which Lean cannot read back.
    const proof = "intro _\n-- step 1: zero on the right\nhave h_1 : n + 0 = n := by sorry\nexact main_ok";
    const { events, faux } = await run([...informal, draftOf(proof), answer(BP_AUX, BP_PROOF), check("exact bad"), say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft, round1] = nodes(events, "m12_sketch");
    assert.equal(draft?.fromInformal, true);
    assert.equal(draft?.healthy, false);
    assert.match(String((draft?.errors as string[] | undefined)?.[0]), /unexpected token/);
    assert.equal(round1?.round, 1);
    assert.equal(round1?.fromInformal, undefined);
    assert.equal(round1?.refinedFrom, draft?.nodeId);
    assert.equal(round1?.healthy, true);
  });

  it("sends a draft Lean refuses to the first refinement round, and a draft with no proof makes no record", { timeout: 60000 }, async () => {
    const refused = await run([...informal, draftOf("have h_1 : 1 * n = n := by bad_tactic\nexact main_ok"), answer(BP_AUX, BP_PROOF), check("exact bad"), say("Notes.")]);
    const [draft, round1] = nodes(refused.events, "m12_sketch");
    assert.equal(draft?.healthy, false);
    assert.match(String(draft?.problem), /the draft proof has errors Lean reports/);
    assert.equal(round1?.round, 1);
    const flawed = await run([...informal, say("not json"), say("still not json"), check("exact bad"), say("Notes.")]);
    assert.equal(nodes(flawed.events, "m12_sketch").length, 0, "the prover writes the first blueprint as it always did");
  });

  it("is off without longProof, and needs M12's blueprints when asked for", { timeout: 60000 }, async () => {
    const { events } = await run([...informal, check("exact bad"), say("Notes.")], { longProof: undefined, triage: false });
    assert.equal(nodes(events, "m12_sketch").some((n) => n.fromInformal === true), false);
    assert.equal(planned(events).length, 0);
    await assert.rejects(() => run([], { longProof: { draft: true } }, { blueprints: false }), /longProof.draft and longProof.drafts need line M12 with the option blueprints/);
    await assert.rejects(() => run([], { longProof: { drafts: 0 } }), /longProof.drafts must be a whole number of at least 1/);
  });
});

/** Three drafts: 3 holes after the lift (4 steps, the battery closes one), 2 holes in 3 steps, 2 holes in 2 steps. */
const D1 = FOUR;
const D2 = `have h_1 : 1 * n = n := by sorry
have h_2 : n * 1 = n := by sorry
have h_3 : 0 + n = n := by sorry
exact main_ok`;
const D3 = `have h_1 : 1 * n = n := by sorry
have h_2 : 0 + n = n := by sorry
exact main_ok`;

describe("several drafts, ranked for free (DP3)", () => {
  it("registers the draft with the fewest holes after the lift (ties to the fewer steps) and records the others, never registered", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const asked = (text: string) => ((c: Context) => { prompts.push(sessionPromptOf(c)); return draftOf(text); }) as never;
    const { events, faux } = await run([...informal, asked(D1), asked(D2), asked(D3), check("exact bad"), say("Notes.")], { longProof: { drafts: 3 } });
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(planned(events).length, 3);
    assert.match(prompts[0] ?? "", /\(draft 1 of 3, written independently of the others\)/);
    assert.match(prompts[2] ?? "", /\(draft 3 of 3, /);
    const drafts = nodes(events, "m12_sketch");
    assert.equal(drafts.length, 3);
    assert.deepEqual(drafts.map((d) => d.healthy), [true, true, true], "healthy as Lean said, kept or not");
    assert.deepEqual(drafts.map((d) => (d.names as string[]).length), [3, 2, 2], "the worst first, the kept draft last");
    assert.deepEqual(drafts.map((d) => d.discarded), [true, true, undefined]);
    assert.deepEqual(drafts.map((d) => d.registered), [false, false, true], "a draft that is not kept is never registered");
    assert.ok(drafts.every((d) => d.fromInformal === true && d.planner === true && d.round === undefined));
    // Only the kept draft's holes are claims, and the battery ran on every draft.
    assert.equal(ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma")).length, 2);
    assert.equal(nodes(events, "sorry_battery").length, 3);
  });

  it("drafts: 1 is the draft of LP2, and a healthy draft is kept over one Lean refused", { timeout: 60000 }, async () => {
    const { events } = await run([...informal, draftOf(D3), check("exact bad"), say("Notes.")], { longProof: { drafts: 1 } });
    assert.equal(nodes(events, "m12_sketch").length, 1);
    assert.equal(planned(events).length, 1);
    // A healthy draft is preferred to a refused one, whatever its holes: the refused one is recorded first and not kept.
    const refused = "have h_1 : 1 * n = n := by bad_tactic\nexact main_ok";
    const mixed = await run([...informal, draftOf(refused), draftOf(D1), check("exact bad"), say("Notes.")], { longProof: { drafts: 2 } });
    const [worse, better] = nodes(mixed.events, "m12_sketch");
    assert.deepEqual([worse?.healthy, worse?.discarded, better?.healthy, better?.discarded], [false, true, true, undefined]);
  });

  it("stops at the drafts made when the gate skips or a call fails, and the drafts made are ranked", { timeout: 60000 }, async () => {
    const down = fauxAssistantMessage([], { stopReason: "error", errorMessage: "the model is down" });
    const failed = await run([...informal, draftOf(D1), down, down, down, down, down, down], { longProof: { drafts: 3 } });
    const [only, ...more] = nodes(failed.events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(only?.healthy, true);
    assert.equal(only?.discarded, undefined);
    assert.equal(planned(failed.events).filter((m) => m.data.outcome === "ok").length, 1);
    // A gate that refuses the first call: the gate is asked once, not once for each draft.
    const skipped = await run([...informal, check("exact bad"), say("Notes.")], { longProof: { drafts: 3 }, seed: "draft-gate", budget: { problemUsd: 1 }, gate: { floor: 0, share: { task: 0.0001 } } });
    assert.deepEqual(ofType(skipped.events, "budget.gated").map((e) => e.data).filter((g) => g.site === "task").map((g) => g.action), ["skip"]);
    assert.equal(planned(skipped.events).length, 0);
    assert.equal(nodes(skipped.events, "m12_sketch").length, 0);
  });
});
