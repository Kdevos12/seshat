import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import type { Line, ProblemContext } from "@seshat/lines";
import { createM12Line } from "@seshat/scheduler";
import { BP_AUX, BP_PROOF, HARD_AUX } from "./blueprint-helpers.ts";
import { liftAnswer } from "./lift-helpers.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";
import { readRecordedRun } from "../src/resume.ts";
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

  it("reads a draft written with a leading `by` as its tactics (run6, 2003 B3)", { timeout: 60000 }, async () => {
    const { events, faux } = await run([...informal, draftOf(`by\n${FOUR.split("\n").map((l) => `  ${l}`).join("\n")}`), check("exact bad"), say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft] = nodes(events, "m12_sketch");
    assert.equal(draft?.healthy, true, String(draft?.problem ?? draft?.errors));
    assert.deepEqual(draft?.names, ["aux_h_1", "aux_h_3", "aux_h_4"]);
  });

  it("sends a draft whose extracted statement does not compile to the first refinement round", { timeout: 60000 }, async () => {
    // `intro _` names nothing: the statement extract_goal prints has `x✝`, which Lean cannot read back.
    const proof = "intro _\n-- step 1: zero on the right\nhave h_1 : n + 0 = 0 + n := by sorry\nexact main_ok";
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

  it("sends a draft that leaves the theorem itself as a step to the first refinement round (run 7, VL1)", { timeout: 60000 }, async () => {
    const proof = "-- step 1: zero on the right\nhave h_1 : n * 1 = n := by sorry\n-- step 2: the theorem\nhave h_2 :  n + 0  = n := by sorry\nexact h_2";
    const { events, faux } = await run([...informal, draftOf(proof), answer(BP_AUX, BP_PROOF), check("exact bad"), say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const [draft, round1] = nodes(events, "m12_sketch");
    assert.equal(draft?.healthy, false);
    assert.match(String(draft?.problem), /leaves the theorem itself as its step h_2/);
    assert.equal(round1?.round, 1);
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

  it("a draft whose battery closes every step is submitted through validate, and is no blueprint (DP1)", { timeout: 60000 }, async () => {
    const proof = "-- step 1: one is a right identity\nhave h_2 : n * 1 = n := by sorry\nexact main_ok";
    const { events } = await run([...informal, draftOf(proof), check("exact bad"), say("Notes.")]);
    const [draft] = nodes(events, "m12_sketch");
    assert.equal(draft?.fromInformal, true);
    assert.equal(draft?.healthy, false);
    assert.match(String(draft?.problem), /the draft has no hole left: it was submitted to Lean through validate, which said \w+/);
    const [battery] = nodes(events, "sorry_battery");
    assert.deepEqual([battery?.tried, battery?.closed], [1, 1]);
    // Lean decided: a validation of the target's own claim was recorded, with the draft's proof.
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId;
    assert.ok(ofType(events, "validation.finished").some((v) => v.data.claimId === claimId), "the draft reached validate");
  });

  it("records longProof in run.started, which a resumption reads back; a run without it records none", { timeout: 60000 }, async () => {
    const { events, dir } = await run([...informal, check("exact bad"), say("Notes.")], { longProof: { drafts: 2, freeze: false } });
    const started = ofType(events, "run.started")[0];
    assert.deepEqual((started?.data.config as Record<string, unknown>).longProof, { drafts: 2, freeze: false });
    assert.deepEqual(readRecordedRun(dir).config.longProof, { drafts: 2, freeze: false });
    const off = await run([...informal, check("exact bad"), say("Notes.")], { longProof: undefined, triage: false });
    assert.equal("longProof" in (ofType(off.events, "run.started")[0]?.data.config as Record<string, unknown>), false);
  });

  it("is off without longProof, and needs M12's blueprints when asked for", { timeout: 60000 }, async () => {
    const { events } = await run([...informal, check("exact bad"), say("Notes.")], { longProof: undefined, triage: false });
    assert.equal(nodes(events, "m12_sketch").some((n) => n.fromInformal === true), false);
    assert.equal(planned(events).length, 0);
    await assert.rejects(() => run([], { longProof: { draft: true } }, { blueprints: false }), /longProof.draft, longProof.drafts and longProof.freeze need line M12 with the option blueprints/);
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

/** A blueprint with one hole that nothing proves (`aux_hard`, with its informal step) and one the battery closes (`aux_third`). */
const HARD_BLUEPRINT = `-- step 1: two commutes with n\n${HARD_AUX}\n\nlemma aux_third (n : ℕ) : n * 1 = n := by\n  sorry`;
const HARD_PROOF = "exact main_ok aux_hard aux_third";
/** The local redraft of `aux_hard` (DP7): two steps, which the lifter makes two holes on aux_hard's own file. */
const SUB = `-- step 1: two is one plus one
have h_1 : n + 2 = n + 1 + 1 := by sorry
-- step 2: regroup
have h_2 : n + 1 + 1 = 2 + n := by sorry
exact main_ok`;
/** What a refinement round writes for the hard blueprint: aux_hard split in two (case b). */
const SPLIT_AUX = `-- refines: aux_hard
lemma aux_s1 (n : ℕ) : n + 2 = n + 1 + 1 := by
  sorry

-- refines: aux_hard
lemma aux_s2 (n : ℕ) : n + 1 + 1 = 2 + n := by
  sorry

lemma aux_third (n : ℕ) : n * 1 = n := by
  sorry`;

/** M12 with some of its problem's context replaced in the hooks that take it: what a test of the line's side of the gate, or of a session's stop, needs. */
function withContext(patch: (problem: ProblemContext) => Partial<ProblemContext>): Line {
  const line = createM12Line();
  const wrap = (problem: ProblemContext): ProblemContext => Object.assign(Object.create(problem) as ProblemContext, patch(problem));
  const hooks = { ...line.hooks } as Record<string, unknown>;
  for (const key of ["beforeProvers", "resumeProblem", "afterAttempt", "schedule", "afterProblem"] as const) {
    const hook = line.hooks[key] as ((problem: ProblemContext, ...rest: unknown[]) => unknown) | undefined;
    if (hook !== undefined) hooks[key] = (problem: ProblemContext, ...rest: unknown[]) => hook(wrap(problem), ...rest);
  }
  return { ...line, hooks: hooks as Line["hooks"] };
}

/** A run whose outer session writes the hard blueprint, with M12's hole sessions on (no informal proof, so no first draft). */
async function hard(responses: unknown[], config: Record<string, unknown> = {}, options: Record<string, unknown> = {}, line: Line = createM12Line()) {
  return await demoRun({
    lines: { M12: line },
    config: {
      lines: ["M12"], provers: 1, sessions: 1, triage: true, longProof: {}, ...config,
      lineOptions: { M12: { blueprints: true, refine: false, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0, ...options } },
    },
    lean: new DemoLean(liftAnswer),
    responses: [check(HARD_PROOF, HARD_BLUEPRINT), say("Two lemmas are left."), ...responses] as never,
  });
}

const claimOf = (events: readonly HarnessEvent[], gloss: string) => ofType(events, "claim.created").find((e) => e.actor === "line:M12" && (e.data.gloss ?? "").startsWith(gloss))?.data;
const statusOf = (events: readonly HarnessEvent[], claimId: unknown) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === claimId).map((e) => e.data.to);

describe("local recursion on a hole that is too hard (DP7)", () => {
  it("drafts a hole that ended too hard as a blueprint on its claim; its holes get sessions, and Lean proves the hole and then the target through validate", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events, faux } = await hard([
      say("I cannot do this."), // the session on aux_hard: too_hard, the model said so (aux_third is closed by the battery)
      ((c: Context) => { prompts.push(sessionPromptOf(c)); return draftOf(SUB); }) as never,
      check("exact hole_ok"),
      check("exact hole_ok"),
    ]);
    assert.equal(faux.getPendingResponseCount(), 0);
    const hardClaim = claimOf(events, "aux_hard")?.claimId;
    const target = ofType(events, "problem.registered")[0]?.data.claimId;
    const [top, sub, ...more] = nodes(events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(top?.redraftOf, undefined);
    assert.equal(sub?.redraftOf, hardClaim, "the redraft is registered on the hole's claim");
    assert.deepEqual([sub?.healthy, sub?.registered, sub?.lifted, sub?.fromInformal, sub?.planner, sub?.round, sub?.attemptId], [true, true, true, true, true, undefined, "aux_hard:draft"]);
    assert.deepEqual(sub?.names, ["aux_h_1", "aux_h_2"]);
    // Its holes are claims under the hole, with a `decomposes_into` edge from the hole that Lean checked (the link lemma, as for any blueprint).
    const subHoles = sub?.holes as string[];
    assert.ok(subHoles.every((id) => ofType(events, "claim.created").find((e) => e.data.claimId === id)?.data.parentId === hardClaim));
    const edge = ofType(events, "edge.added").find((e) => e.data.kind === "decomposes_into" && e.data.from === hardClaim && subHoles.every((h) => (e.data.to as string[]).includes(h)));
    assert.ok(edge !== undefined, "an edge from the hole to its redraft's holes");
    assert.equal(sub?.edgeId, edge?.data.edgeId);
    assert.ok(ofType(events, "edge.status_changed").some((e) => e.data.edgeId === edge?.data.edgeId && e.data.to === "lean_checked"), "its link lemma is checked by Lean");
    // The hole had its one session; each of the redraft's holes had one.
    const sessions = nodes(events, "m12_session");
    assert.deepEqual(sessions.map((n) => [n.claimId, n.verdict]), [[hardClaim, "too_hard"], [subHoles[0], "proved"], [subHoles[1], "proved"]]);
    // The hole, then the target, are accepted only through validate: a composed proof of each, which Lean checked.
    for (const id of [hardClaim, target]) {
      assert.deepEqual(statusOf(events, id).slice(0, 1), ["computed"], String(id));
      assert.ok(nodes(events, "derivation").some((d) => d.claimId === id && d.verdict === "valid"), `a derivation of ${String(id)} that validate accepted`);
      const change = ofType(events, "claim.status_changed").find((e) => e.data.claimId === id);
      assert.ok(ofType(events, "validation.finished").some((v) => v.data.validationId === change?.data.validationId && v.data.verdict === "valid"));
    }
    // One planner call, the draft's prompt with the hole as the target and its informal step quoted as unchecked data; in the problem's ledger.
    const [call, ...rest] = planned(events);
    assert.equal(rest.length, 0);
    assert.equal(call?.data.line, "M12");
    assert.match(prompts[0] ?? "", /Draft prompt draft-1\. /);
    assert.match(prompts[0] ?? "", /theorem target \(n : ℕ\) : n \+ 2 = 2 \+ n/);
    assert.match(prompts[0] ?? "", /checked by no one and not by Lean/);
    assert.match(prompts[0] ?? "", /> step 1: two commutes with n/);
  });

  it("is off with depth 0 and without longProof: the hole that ended too hard goes to the refinement round, as before", { timeout: 60000 }, async () => {
    const responses = [say("I cannot do this."), answer(SPLIT_AUX, "exact main_ok aux_s1 aux_s2 aux_third"), check("exact hole_ok"), check("exact hole_ok")];
    for (const config of [{ longProof: { depth: 0 } }, { longProof: undefined, triage: false }]) {
      const { events, faux } = await hard(responses, config, { refine: true });
      assert.equal(faux.getPendingResponseCount(), 0);
      const sketches = nodes(events, "m12_sketch");
      assert.equal(sketches.length, 2, JSON.stringify(config));
      assert.ok(sketches.every((r) => r.redraftOf === undefined));
      assert.equal(sketches[1]?.round, 1, "case b: a refinement round splits it");
      assert.deepEqual(sketches[1]?.names, ["aux_s1", "aux_s2", "aux_third"]);
      assert.equal(planned(events).length, 1);
    }
  });

  it("never nests past the depth: with depth 1 a hole of the redraft that ends too hard gets no redraft of its own; with depth 2 it does", { timeout: 60000 }, async () => {
    const shallow = await hard([say("I cannot do this."), draftOf(SUB), say("I cannot do this either."), check("exact hole_ok")]);
    assert.equal(shallow.faux.getPendingResponseCount(), 0);
    assert.equal(planned(shallow.events).length, 1, "one redraft, of aux_hard");
    const records = nodes(shallow.events, "m12_sketch");
    assert.equal(records.length, 2);
    const [first] = records[1]?.holes as string[];
    assert.deepEqual(nodes(shallow.events, "hole_verdict").filter((v) => v.claimId === first).map((v) => v.verdict), ["too_hard"]);
    // Depth 2: the hole of the redraft is redrafted too, as soon as its session ends (here a draft Lean refuses, recorded on its claim and not healthy).
    const deep = await hard([say("I cannot do this."), draftOf(SUB), say("I cannot do this either."), draftOf("have h_1 : 1 * n = n := by bad_tactic\nexact main_ok"), check("exact hole_ok")], { longProof: { depth: 2 } });
    assert.equal(deep.faux.getPendingResponseCount(), 0);
    assert.equal(planned(deep.events).length, 2);
    const [, sub, subSub, ...more] = nodes(deep.events, "m12_sketch");
    assert.equal(more.length, 0);
    assert.equal(subSub?.redraftOf, (sub?.holes as string[])[0]);
    assert.equal(subSub?.attemptId, "aux_h_1:draft");
    assert.equal(subSub?.healthy, false);
    assert.match(String(subSub?.problem), /the draft proof has errors Lean reports/);
  });

  it("gives no redraft to a hole whose session the budget stopped, and a redraft Lean refuses leaves the hole to the refinement round", { timeout: 60000 }, async () => {
    // The session's end as a stop for the money, the problem's budget not spent: too_hard with the reason budget.
    const budget = withContext((problem) => ({ holeSession: async (request) => ({ ...(await problem.holeSession!(request)), stop: "budget" as const }) }));
    const stopped = await hard([say("I cannot do this.")], {}, {}, budget);
    assert.equal(stopped.faux.getPendingResponseCount(), 0);
    assert.deepEqual(nodes(stopped.events, "hole_verdict").filter((v) => v.verdict === "too_hard").map((v) => v.reason), ["budget"]);
    assert.equal(planned(stopped.events).length, 0);
    assert.equal(nodes(stopped.events, "m12_sketch").length, 1);
    // A redraft that Lean refuses is recorded on the hole and not healthy; the refinement round then revises the problem's blueprint (case b), as before.
    const refused = await hard(
      [say("I cannot do this."), draftOf("have h_1 : 1 * n = n := by bad_tactic\nexact main_ok"), answer(SPLIT_AUX, "exact main_ok aux_s1 aux_s2 aux_third"), check("exact hole_ok"), check("exact hole_ok")],
      {}, { refine: true },
    );
    assert.equal(refused.faux.getPendingResponseCount(), 0);
    const [top, sub, round] = nodes(refused.events, "m12_sketch");
    assert.deepEqual([sub?.redraftOf !== undefined, sub?.healthy, sub?.registered], [true, false, true]);
    assert.deepEqual([round?.round, round?.refinedFrom], [1, top?.nodeId], "the round revises the problem's blueprint, not the redraft");
  });

  it("asks the problem's budget gate before its planner call: a skip stops the recursion, with no call and no spend, and the gate is asked once", { timeout: 60000 }, async () => {
    const asked: Array<{ site: string; estimateUsd: number }> = [];
    const gate = withContext((problem) => ({
      budget: Object.assign(Object.create(problem.budget) as ProblemContext["budget"], {
        ask: async (request: { site: string; estimateUsd: number }) => {
          asked.push(request);
          return { action: "skip" as const, by: "rule", reason: "no room for it", exploration: false };
        },
      }),
    }));
    const { events, faux } = await hard([say("I cannot do this.")], {}, {}, gate);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(asked.map((a) => a.site), ["task"], "asked once, as a task of one call");
    assert.equal(planned(events).length, 0);
    assert.equal(nodes(events, "m12_sketch").length, 1, "no redraft");
  });
});
