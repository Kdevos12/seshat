import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Json } from "@seshat/core";
import {
  addLesson, allLessons, countOutcome, deactivateWorn, DECISION_KIND, decisionData, failureGroups, type LearnOptions, learnConstraints, learnStrategy,
  LESSON_KIND, selectLessons, type SelectOptions, stagedLessons,
} from "../src/index.ts";
import { attempt, finished, open, problem } from "./helpers.ts";

const learn: LearnOptions = { globalPromotion: "human", globalMinDomains: 2, globalMinClaims: 3, minAttempts: 3, distill: true, maxDistill: 2 };
const select: SelectOptions = { deactivation: "effect", minObservations: 5, threshold: 0.9, maxLessons: 3 };

async function claims(memory: ReturnType<typeof open>["memory"], n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let k = 0; k < n; k++) ids.push((await memory.ensureClaim({ statement: `(n : ℕ) : n + ${k} = ${k} + n`, header: "import Mathlib", origin: "t" })).claimId);
  return ids;
}

const draft = (key: string, over: Partial<Parameters<typeof addLesson>[1]> = {}) => ({
  text: `lesson ${key}`, type: "strategy" as const, scope: "global" as const, scopeKey: "", key, origin: "outcome" as const, support: ["a1"], claims: ["c1"], domains: ["msc:11"], ...over,
});

describe("lessons are added, merged and never rewritten", () => {
  it("add a stamped entry with zeroed counters, and merge a duplicate into the older entry without touching its text or counters", () => {
    const { memory } = open();
    const first = addLesson(memory, draft("k1"));
    assert.equal(first.created, true);
    const [lesson] = allLessons(memory);
    assert.deepEqual([lesson?.useful, lesson?.harmful, lesson?.active, lesson?.state, lesson?.stamp?.modelId], [0, 0, true, "active", "p/m"]);
    assert.equal(memory.node(first.nodeId)?.provenance?.mathlibRev, "rev-a", "a learned record carries the run's provenance (Global Constraint 16)");

    memory.updateNode(first.nodeId, { useful: 2 }, "test");
    const again = addLesson(memory, draft("k1", { text: "a different wording", support: ["a2"], claims: ["c2"], domains: ["msc:5"] }));
    assert.deepEqual([again.created, again.nodeId], [false, first.nodeId]);
    const [merged] = allLessons(memory);
    assert.equal(allLessons(memory).length, 1);
    assert.equal(merged?.text, "lesson k1", "the text is never rewritten");
    assert.deepEqual([merged?.support, merged?.claims, merged?.domains, merged?.useful], [["a1", "a2"], ["c1", "c2"], ["msc:11", "msc:5"], 2]);
    // A duplicate that adds nothing writes nothing.
    const events = memory.nodes(LESSON_KIND).length;
    addLesson(memory, draft("k1", { support: ["a1"] }));
    assert.equal(memory.nodes(LESSON_KIND).length, events);
  });

  it("put a claim lesson on its claim and cut the text", async () => {
    const { memory } = open();
    const [c] = await claims(memory, 1);
    const r = addLesson(memory, draft("k2", { scope: "claim", scopeKey: c as string, text: "x".repeat(400) }));
    assert.equal(memory.node(r.nodeId)?.claimId, c);
    assert.equal(allLessons(memory)[0]?.text.length, 240);
  });
});

describe("strategy lessons from accepted proofs", () => {
  it("teach a domain lesson from an accepted proof, and nothing from a failed one or an unlabeled one", async () => {
    const { memory, journal } = open();
    const [c] = await claims(memory, 1);
    const { context } = problem(memory, { claimId: c as string });
    const win = attempt(journal, c as string, { outcome: "valid" });
    assert.deepEqual(learnStrategy(context, finished(win, { outcome: "invalid" }), "induction", learn), { added: 0 });
    assert.deepEqual(learnStrategy(context, finished(win), undefined, learn), { added: 0 });
    assert.deepEqual(learnStrategy(context, finished(win), "other", learn), { added: 0 });
    assert.deepEqual(learnStrategy(context, finished(win), "induction", learn), { added: 1 });
    const [l] = allLessons(memory);
    assert.deepEqual([l?.scope, l?.scopeKey, l?.strategy, l?.type, l?.claims, l?.support], ["domain", "msc:11", "induction", "strategy", [c], [win]]);
    assert.match(l?.text ?? "", /A `induction` proof was accepted by Lean on msc:11 problems/);
    // The same strategy on the same domain is a duplicate: it merges.
    assert.deepEqual(learnStrategy(context, finished("att_x"), "induction", learn), { added: 0 });
    assert.equal(allLessons(memory).length, 1);
  });

  it("widen to a global lesson in enough domains and claims, staged for the team under --human and direct otherwise", async () => {
    for (const human of [true, false]) {
      const { memory } = open();
      const ids = await claims(memory, 3);
      const domains = ["msc:11", "msc:5", "msc:11"];
      for (const [k, id] of ids.entries()) {
        const { context } = problem(memory, { claimId: id, domain: [domains[k] as string], human });
        learnStrategy(context, finished(`att_${k}`), "cases", learn);
        const globals = allLessons(memory).filter((l) => l.scope === "global");
        assert.equal(globals.length, k === 2 ? 1 : 0, "the third claim in the second domain reaches the thresholds");
      }
      const global = allLessons(memory).find((l) => l.scope === "global");
      assert.equal(global?.state, human ? "pending" : "active");
      assert.deepEqual([global?.domains.sort(), global?.claims.length, global?.widenedFrom?.length], [["msc:11", "msc:5"], 3, 2]);
      assert.equal(stagedLessons(memory).length, human ? 1 : 0);
    }
    // `off` makes no global lesson, `staged` stages even without --human.
    for (const [mode, expect] of [["off", 0], ["staged", 1]] as const) {
      const { memory } = open();
      const ids = await claims(memory, 3);
      for (const [k, id] of ids.entries()) learnStrategy(problem(memory, { claimId: id, domain: [k === 0 ? "msc:5" : "msc:11"] }).context, finished(`a${k}`), "cases", { ...learn, globalPromotion: mode });
      const globals = allLessons(memory).filter((l) => l.scope === "global");
      assert.equal(globals.length, expect);
      assert.equal(stagedLessons(memory).length, expect);
    }
  });
});

describe("constraints from failures that recur", () => {
  async function failing(n: number, perClaim: number[], failure = { class: "unsolved_goals", detail: "unsolved goals at case succ" }) {
    const { memory, journal } = open();
    const ids = await claims(memory, n);
    for (const [k, id] of ids.entries()) for (let j = 0; j < (perClaim[k] ?? 0); j++) attempt(journal, id, { outcome: "invalid", failure });
    return { memory, journal, ids };
  }

  it("group the failed attempts by class and normalized detail over every claim", async () => {
    const { memory, journal, ids } = await failing(2, [2, 2]);
    attempt(journal, ids[0] as string, { outcome: "invalid", failure: { class: "other", detail: "whatever" } });
    attempt(journal, ids[0] as string, { outcome: "invalid", failure: { class: "tactic_failed", detail: "  linarith   failed " } });
    attempt(journal, ids[0] as string, { outcome: "valid" });
    const groups = failureGroups(memory);
    assert.deepEqual(groups.map((g) => [g.group, g.attempts.length, g.claims.length]), [["unsolved_goals|unsolved goals at case succ", 4, 2], ["tactic_failed|linarith failed", 1, 1]]);
  });

  it("make a global constraint of a failure on enough attempts across two claims, put in a line by one model call", async () => {
    const { memory, ids } = await failing(2, [2, 1]);
    const { context, prompts } = problem(memory, { claimId: ids[0] as string, answers: ["Close every case before you stop: state the base case and the step."], human: true });
    const r = await learnConstraints(context, learn);
    assert.deepEqual(r, { added: 1, distilled: 1 });
    const [l] = allLessons(memory);
    assert.deepEqual([l?.type, l?.scope, l?.origin, l?.state, l?.group, l?.support.length, l?.claims.length], ["constraint", "global", "distilled", "pending", "unsolved_goals|unsolved goals at case succ", 3, 2]);
    assert.equal(l?.text, "Close every case before you stop: state the base case and the step.");
    assert.match(prompts[0] ?? "", /Failure class: unsolved_goals\n\nTyped detail: unsolved goals at case succ\n\nAttempts: 3, on 2 claim\(s\)/);
    // It is added once: the next problem's end finds the key and merges.
    assert.deepEqual(await learnConstraints(context, learn), { added: 0, distilled: 0 });
    assert.equal(allLessons(memory).length, 1);
  });

  it("fall back to a template when the model fails or is not asked, and respect the cap on model calls", async () => {
    const { memory, ids } = await failing(2, [2, 2]);
    const { context, logs } = problem(memory, { claimId: ids[0] as string, answers: [] });
    assert.deepEqual(await learnConstraints(context, learn), { added: 1, distilled: 1 });
    const [l] = allLessons(memory);
    assert.deepEqual([l?.origin, l?.state], ["outcome", "active"]);
    assert.match(l?.text ?? "", /^Lean rejected 4 attempts on 2 claim\(s\) the same way \(unsolved goals: unsolved goals at case succ\); check for it before you submit\.$/);
    assert.ok(logs.some((t) => /the model could not put a recurring failure in a line, a template does/.test(t)));

    const off = await failing(2, [2, 2]);
    assert.deepEqual(await learnConstraints(problem(off.memory, { claimId: off.ids[0] as string }).context, { ...learn, distill: false }), { added: 1, distilled: 0 });
  });

  it("do nothing below the minimum, and keep a failure on one claim as a claim lesson until another claim shows it", async () => {
    const few = await failing(2, [1, 1]);
    assert.deepEqual(await learnConstraints(problem(few.memory, { claimId: few.ids[0] as string }).context, learn), { added: 0, distilled: 0 });

    const { memory, journal, ids } = await failing(2, [3, 0]);
    const { context } = problem(memory, { claimId: ids[0] as string });
    await learnConstraints(context, { ...learn, distill: false });
    const [one] = allLessons(memory);
    assert.deepEqual([one?.scope, one?.scopeKey, one?.state], ["claim", ids[0], "active"]);
    assert.equal(memory.node(one?.nodeId as string)?.claimId, ids[0]);
    // The failure shows on the other claim too: a global constraint covers it, and the claim lesson stops being shown.
    attempt(journal, ids[1] as string, { outcome: "invalid", failure: { class: "unsolved_goals", detail: "unsolved goals at case succ" } });
    await learnConstraints(context, { ...learn, distill: false });
    const all = allLessons(memory);
    assert.deepEqual(all.map((l) => [l.scope, l.state]), [["claim", "deactivated"], ["global", "active"]]);
    assert.equal(all[0]?.deactivated?.rule, "widened");
    assert.deepEqual(all[1]?.widenedFrom, [all[0]?.nodeId]);
  });
});

describe("which lessons a session is offered", () => {
  it("are the active ones in scope, best standing first, at most the cap", async () => {
    const { memory } = open();
    const [c, other] = await claims(memory, 2);
    const mk = (key: string, over: Partial<Parameters<typeof addLesson>[1]>, patch: Record<string, Json> = {}) => {
      const r = addLesson(memory, draft(key, over));
      if (Object.keys(patch).length > 0) memory.updateNode(r.nodeId, patch, "test");
      return r.nodeId;
    };
    const g = mk("g", {}, { useful: 3, harmful: 1 });
    const d = mk("d", { scope: "domain", scopeKey: "msc:11" }, { useful: 5 });
    mk("d5", { scope: "domain", scopeKey: "msc:5" }, { useful: 9 });
    const cl = mk("cl", { scope: "claim", scopeKey: c as string }, { useful: 1 });
    mk("co", { scope: "claim", scopeKey: other as string }, { useful: 8 });
    mk("off", {}, { useful: 9, active: false });
    mk("wait", {}, { useful: 9, pending: true });
    const { context } = problem(memory, { claimId: c as string });
    assert.deepEqual(selectLessons(context, { maxLessons: 5 }).map((l) => l.nodeId), [d, g, cl]);
    assert.deepEqual(selectLessons(context, { maxLessons: 2 }).map((l) => l.nodeId), [d, g]);
    assert.deepEqual(selectLessons(context, { maxLessons: 0 }), []);
  });
});

describe("counters and deactivation", () => {
  it("move the presence counters by outcome: a point for an accepted attempt, a loss for a failed one on the lesson's strategy", async () => {
    const { memory, journal } = open();
    const [c] = await claims(memory, 1);
    const anyStrategy = addLesson(memory, draft("any", { scope: "domain", scopeKey: "msc:11" })).nodeId;
    const induction = addLesson(memory, draft("ind", { scope: "domain", scopeKey: "msc:11", strategy: "induction" })).nodeId;
    const absent = addLesson(memory, draft("absent")).nodeId;
    const { context } = problem(memory, { claimId: c as string });
    const run = (outcome: "valid" | "invalid", label: string) => {
      const id = attempt(journal, c as string, { outcome, included: [anyStrategy, induction], withheld: [absent] });
      countOutcome(context, finished(id, { outcome }), label);
    };
    run("valid", "cases");
    run("invalid", "cases");
    run("invalid", "induction");
    const by = Object.fromEntries(allLessons(memory).map((l) => [l.key, [l.useful, l.harmful]]));
    assert.deepEqual(by, { any: [1, 2], ind: [1, 1], absent: [0, 0] });
    // A session that was cut says nothing.
    const cut = attempt(journal, c as string, { outcome: "valid", included: [anyStrategy] });
    countOutcome(context, finished(cut, { outcome: "budget_exhausted" }), "cases");
    assert.equal(allLessons(memory).find((l) => l.key === "any")?.useful, 1);
  });

  it("deactivate by effect when P(effect < 0) is above 0.9 after the minimum on each side, and keep one that presence alone would drop", async () => {
    const { memory, journal } = open();
    const [c] = await claims(memory, 1);
    const bad = addLesson(memory, draft("bad")).nodeId;
    const flat = addLesson(memory, draft("flat")).nodeId;
    const { context, logs } = problem(memory, { claimId: c as string });
    const many = (n: number, outcome: "valid" | "invalid", items: { included?: string[]; withheld?: string[] }) => {
      for (let k = 0; k < n; k++) attempt(journal, c as string, { outcome, ...items });
    };
    // `flat` is shown in many attempts that fail, and also withheld from as many that fail: presence says harmful, effect says nothing.
    many(8, "invalid", { included: [flat] });
    many(8, "invalid", { withheld: [flat] });
    many(2, "invalid", { included: [bad] });
    many(2, "valid", { withheld: [bad] });
    assert.deepEqual(deactivateWorn(context, select), [], "too few observations on each side");
    many(8, "invalid", { included: [bad] });
    many(8, "valid", { withheld: [bad] });
    const gone = deactivateWorn(context, select);
    assert.deepEqual(gone.map((l) => l.nodeId), [bad]);
    const states = Object.fromEntries(allLessons(memory).map((l) => [l.key, l.state]));
    assert.deepEqual(states, { bad: "deactivated", flat: "active" });
    assert.match(allLessons(memory)[0]?.deactivated?.reason ?? "", /^P\(effect < 0\) = 1\.00 with 10 attempt\(s\) that had it \(0\.0 accepted\) and 10 that did not \(10\.0 accepted\)$/);
    assert.equal(allLessons(memory)[0]?.deactivated?.rule, "effect");
    assert.ok(logs.some((t) => /deactivated "lesson bad"/.test(t)));
    // A deactivated lesson is not offered, and is not deactivated twice.
    assert.deepEqual(selectLessons(context, { maxLessons: 5 }).map((l) => l.nodeId), [flat]);
    assert.deepEqual(deactivateWorn(context, select), []);
  });

  it("deactivate by presence when asked: harmful outweighs useful after the minimum", async () => {
    const { memory } = open();
    const [c] = await claims(memory, 1);
    const worn = addLesson(memory, draft("worn")).nodeId;
    const kept = addLesson(memory, draft("kept")).nodeId;
    const young = addLesson(memory, draft("young")).nodeId;
    memory.updateNode(worn, { useful: 2, harmful: 4 }, "t");
    memory.updateNode(kept, { useful: 4, harmful: 4 }, "t");
    memory.updateNode(young, { useful: 0, harmful: 2 }, "t");
    const { context } = problem(memory, { claimId: c as string });
    assert.deepEqual(deactivateWorn(context, { ...select, deactivation: "presence" }).map((l) => l.nodeId), [worn]);
    assert.match(allLessons(memory)[0]?.deactivated?.reason ?? "", /harmful 4 outweighs useful 2/);
  });
});

describe("staged promotion", () => {
  it("keeps a global lesson pending until a person approves it, and drops one they reject", async () => {
    const { memory } = open();
    const pending = addLesson(memory, draft("p1", { pending: true })).nodeId;
    const rejected = addLesson(memory, draft("p2", { pending: true })).nodeId;
    const still = addLesson(memory, draft("p3", { pending: true })).nodeId;
    const [c] = await claims(memory, 1);
    const { context } = problem(memory, { claimId: c as string });
    assert.deepEqual(selectLessons(context, { maxLessons: 5 }), [], "nothing pending is offered");
    assert.deepEqual(stagedLessons(memory).map((l) => l.nodeId), [pending, rejected, still]);
    memory.recordNode({ kind: DECISION_KIND, data: decisionData({ lessonId: pending, decision: "approve", by: "ada" }) as unknown as Json });
    memory.recordNode({ kind: DECISION_KIND, data: decisionData({ lessonId: rejected, decision: "reject", by: "ada", note: "too vague" }) as unknown as Json });
    // A node of that kind that is not a person's is not a decision.
    memory.recordNode({ kind: DECISION_KIND, data: { lessonId: still, decision: "approve", by: "x", provenance: "line" } });
    const states = Object.fromEntries(allLessons(memory).map((l) => [l.key, l.state]));
    assert.deepEqual(states, { p1: "active", p2: "rejected", p3: "pending" });
    assert.deepEqual(selectLessons(context, { maxLessons: 5 }).map((l) => l.nodeId), [pending]);
  });
});
