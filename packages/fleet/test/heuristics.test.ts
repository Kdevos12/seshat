import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { type BankCard, builtinBank, type CardContext, type HeuristicCard } from "@seshat/heuristics";
import type { FinishedAttempt, JsonObject, ProblemContext, SessionContext } from "@seshat/lines";
import { type Attempt, MemoryStore } from "@seshat/memory";
import { allocations, cardEffect, createFleet, drawCard, eligibleCards, FLEET_OPTIONS, heuristicsConfigOf, heuristicSection, runBank, seeded } from "../src/index.ts";

const config = { cards: "all" as const, noCardShare: 0, crossModelWeight: 0.5, familyPriorWeight: 2, minObservations: 8 };
const context = (over: Partial<CardContext> = {}): CardContext => ({ domains: ["msc:11"], features: ["forall_nat", "size_small"], attempts: 3, depthStuck: 0, mode: "standard", ...over });
const card = (id: string, family: HeuristicCard["family"], level: HeuristicCard["level"] = "strategy", origin = "builtin"): BankCard => ({
  id, version: 1, family, level, ask: `Ask of ${id}?`, tradition: "test", source: "test", origin,
});

/** A finished attempt of a bucket, with a card. */
function attempt(heuristic: string, family: string, valid: boolean, model = "faux/prover"): Attempt {
  const settings = heuristic === "none" ? { heuristic, heuristicRule: "control", heuristicBucket: "b" } : { heuristic, heuristicFamily: family, heuristicBucket: "b" };
  return {
    attemptId: `a_${Math.random()}`, claimId: "c", prover: "p1", iteration: 1, model, role: "prover", outcome: valid ? "valid" : "invalid",
    ...(valid ? {} : { failureClass: "syntax" }), startedSeq: 1, settings,
  } as unknown as Attempt;
}

describe("drawing a session's card", () => {
  it("draws only cards that apply and agree with the session's strategy", () => {
    const bank = [card("neutral", "vary", "tactic"), card("ind", "induction", "tactic"), card("cex", "counterexample", "tactic"), card("attitude", "counterexample", "strategy")];
    assert.deepEqual(eligibleCards(bank, context(), "induction").map((c) => c.id), ["neutral", "ind", "attitude"]);
    assert.deepEqual(eligibleCards(bank, context(), undefined).map((c) => c.id), ["neutral", "ind", "cex", "attitude"], "no strategy: every card");
    const conditional = { ...card("late", "vary"), when: { minAttempts: 5 } };
    assert.deepEqual(eligibleCards([conditional], context(), undefined), []);
  });

  it("gives the control a share of the sessions, drawn first, and no card when none applies", () => {
    const bank = [card("one", "vary")];
    const input = { bank, context: context(), taken: new Set<string>(), history: [], model: "faux/prover", partial: 0.5 };
    assert.equal(drawCard(() => 0.1, { ...input, config: { ...config, noCardShare: 0.2 } }).rule, "control");
    assert.equal(drawCard(seeded(1), { ...input, config }).card?.id, "one");
    assert.equal(drawCard(seeded(1), { ...input, bank: [{ ...card("late", "vary"), when: { minAttempts: 9 } }], config }).rule, "none_applicable");
    let control = 0;
    const random = seeded(7);
    for (let k = 0; k < 2000; k++) if (drawCard(random, { ...input, config: { ...config, noCardShare: 0.2 } }).rule === "control") control += 1;
    assert.ok(control > 330 && control < 470, `${control} of 2000`);
  });

  it("leaves out the families other provers hold on the subgoal while another is left", () => {
    const bank = [card("a", "vary"), card("b", "specialize")];
    const input = { bank, context: context(), history: [], model: "faux/prover", partial: 0.5, config };
    for (let k = 0; k < 20; k++) assert.equal(drawCard(seeded(k), { ...input, taken: new Set(["vary"]) }).card?.family, "specialize");
    assert.ok(drawCard(seeded(3), { ...input, taken: new Set(["vary", "specialize"]) }).card !== undefined, "every family taken: any may be drawn");
  });

  it("prefers the family and the card that proved in the bucket, and counts another model's sessions for less", () => {
    const bank = [card("good", "vary"), card("plain", "specialize"), card("sibling", "vary")];
    const history = [...Array.from({ length: 12 }, () => attempt("good", "vary", true)), ...Array.from({ length: 12 }, () => attempt("plain", "specialize", false))];
    const input = { bank, context: context(), taken: new Set<string>(), history, model: "faux/prover", partial: 0.5, config };
    const random = seeded(11);
    const picks: Record<string, number> = {};
    for (let k = 0; k < 200; k++) {
      const id = drawCard(random, input).card?.id ?? "none";
      picks[id] = (picks[id] ?? 0) + 1;
    }
    assert.ok((picks.good ?? 0) > 120, JSON.stringify(picks));
    assert.ok((picks.sibling ?? 0) > 0, "a new card of a family that works starts from its family's prior and is tried");
    assert.ok((picks.plain ?? 0) < 15, JSON.stringify(picks));
    const recorded = drawCard(seeded(2), input);
    assert.deepEqual(Object.keys(recorded.draws?.heuristicFamily ?? {}).sort(), ["specialize", "vary"]);
  });

  it("stops drawing a card whose measured effect against the control is negative (PE2's effect, M5's rule)", () => {
    const bank = [card("bad", "vary"), card("fine", "specialize")];
    const losing = [...Array.from({ length: 10 }, () => attempt("bad", "vary", false)), ...Array.from({ length: 10 }, () => attempt("none", "", true))];
    const input = { bank, context: context(), taken: new Set<string>(), model: "faux/prover", partial: 0.5, config };
    const effect = cardEffect("bad", losing);
    assert.deepEqual([effect.with.attempts, effect.without.attempts, effect.pNegative > 0.9], [10, 10, true]);
    for (let k = 0; k < 20; k++) {
      const drawn = drawCard(seeded(k), { ...input, history: losing });
      assert.equal(drawn.card?.id, "fine");
      assert.deepEqual(drawn.deactivated, ["bad"]);
    }
    assert.equal(drawCard(seeded(1), { ...input, history: losing.slice(3) }).deactivated, undefined, "too few observations: the card stays");
    assert.equal(drawCard(seeded(1), { ...input, bank: [card("bad", "vary")], history: losing }).rule, "none_applicable");
  });

  it("compares a card only with control sessions that could have been given it, and records what the control could have had", () => {
    const losing = [...Array.from({ length: 10 }, () => attempt("bad", "vary", false)), ...Array.from({ length: 10 }, () => attempt("none", "", true))];
    const elsewhere = losing.map((a) => (a.settings?.heuristic === "none" ? ({ ...a, settings: { ...a.settings, heuristicEligible: ["other"] } } as Attempt) : a));
    assert.equal(cardEffect("bad", losing).without.attempts, 10);
    assert.equal(cardEffect("bad", elsewhere).without.attempts, 0, "a control that could not have had the card is not its control");
    const control = drawCard(() => 0, { bank: [card("one", "vary"), card("two", "specialize")], context: context(), taken: new Set(), history: [], model: "faux/prover", partial: 0.5, config: { ...config, noCardShare: 0.5 } });
    assert.deepEqual([control.rule, control.eligible], ["control", ["one", "two"]]);
  });

  it("gives provers distinct cards when every family is taken, and repeats a card only when none is left", () => {
    const bank = [card("v1", "vary"), card("v2", "vary"), card("s1", "specialize")];
    const input = { bank, context: context(), history: [], model: "faux/prover", partial: 0.5, config, taken: new Set(["vary", "specialize"]) };
    for (let k = 0; k < 20; k++) assert.equal(drawCard(seeded(k), { ...input, takenCards: new Set(["v1", "s1"]) }).card?.id, "v2");
    assert.ok(drawCard(seeded(5), { ...input, takenCards: new Set(["v1", "v2", "s1"]) }).card !== undefined, "every card taken: any may be drawn");
  });

  it("reads its options, and refuses the bank together with the directives", () => {
    assert.equal(heuristicsConfigOf({ heuristics: null }), undefined);
    assert.deepEqual(heuristicsConfigOf({ heuristics: true }), { cards: "all", noCardShare: 0.2, crossModelWeight: 0.5, familyPriorWeight: 2, minObservations: 8 });
    assert.throws(() => heuristicsConfigOf({ heuristics: true, cardMinObservations: 0 }), /cardMinObservations is a whole number from 1/);
    assert.deepEqual(heuristicsConfigOf({ heuristics: ["a", "a"] })?.cards, ["a"]);
    assert.throws(() => heuristicsConfigOf({ heuristics: [] }), /non-empty list/);
    assert.throws(() => heuristicsConfigOf({ heuristics: true, noCardShare: 2 }), /noCardShare is a number from 0 to 1/);
    assert.throws(() => heuristicsConfigOf({ heuristics: true, familyPriorWeight: 9 }), /from 0 to 8/);
    assert.throws(() => runBank({}, { ...config, cards: ["nope"] }), /does not have: nope/);
    assert.equal(runBank({}, config).length, builtinBank().length);
  });

  it("writes a pack's card as text from outside the run", () => {
    const section = heuristicSection(card("p.one", "vary", "strategy", "pack:p"));
    assert.equal(section.title, "Heuristic for this session");
    assert.match(section.text, /\[begin text of pack:p\]\n> Ask of p.one\?\n\[end text of pack:p\]/);
    assert.doesNotMatch(heuristicSection(card("b", "vary")).text, /begin text/);
  });
});

/** A run's memory, one claim, and the fleet's hooks with the bank on. */
async function world(options: JsonObject, registry: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mh-fleet-h-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
  const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) (h : 0 < n) : 3 ∣ n ^ 3 - n", origin: "test" });
  const controller = new AbortController();
  const fleet = createFleet();
  const problem = (): ProblemContext =>
    ({ line: "fleet", runId: "run_1", problemId: "prob_1", claimId, domain: ["msc:11"], memory: memory.withActor("line:fleet"), registry, signal: controller.signal, options: { ...FLEET_OPTIONS, epsilon: 0, widen: false, ...options } }) as unknown as ProblemContext;
  const session = (prover: string, n: number, settings?: JsonObject): SessionContext =>
    ({ ...problem(), prover, session: n, sessions: 99, attemptId: `att_${prover}_${n}`, model: "faux/prover", regions: { aux: "", proof: "" }, target: { statement: "(n : ℕ) (h : 0 < n) : 3 ∣ n ^ 3 - n" }, ...(settings !== undefined ? { settings } : {}) }) as unknown as SessionContext;
  return { memory, journal, claimId, fleet, problem, session };
}

describe("the bank in the fleet's hooks", () => {
  it("records the card, its family, its bucket and how it was drawn, and briefs the session with it", async () => {
    const w = await world({ heuristics: true, noCardShare: 0, seed: 4 });
    const decision = await w.fleet.hooks.beforeSession?.(w.session("p1", 1));
    const settings = decision?.settings ?? {};
    assert.equal(settings.heuristicBucket, "msc:11|forall_nat+inequality");
    assert.equal(settings.heuristicRule, "thompson");
    const chosen = builtinBank().find((c) => c.id === settings.heuristic);
    assert.ok(chosen !== undefined, String(settings.heuristic));
    assert.equal(settings.heuristicFamily, chosen.family);
    const [record] = allocations(w.memory, w.claimId);
    assert.ok(record?.data.settingDraws?.heuristic !== undefined && record.data.settingDraws.heuristicFamily !== undefined);
    const sections = (await w.fleet.hooks.briefingSections?.(w.session("p1", 1, settings))) ?? [];
    assert.equal(sections[0]?.title, "Heuristic for this session");
    assert.ok(sections[0]?.text.endsWith(chosen.ask));
  });

  it("gives the control no card and no section, and refuses the bank with the directives", async () => {
    const w = await world({ heuristics: true, noCardShare: 1 });
    const decision = await w.fleet.hooks.beforeSession?.(w.session("p1", 1));
    assert.equal(decision?.settings?.heuristic, "none");
    assert.equal(decision?.settings?.heuristicRule, "control");
    assert.equal(decision?.settings?.heuristicFamily, undefined);
    assert.equal(await w.fleet.hooks.briefingSections?.(w.session("p1", 1, decision?.settings ?? {})), undefined);
    const both = await world({ heuristics: true, directives: true });
    await assert.rejects(async () => both.fleet.hooks.beforeSession?.(both.session("p1", 1)), /heuristics replaces directives/);
  });

  it("draws a pack's card from the registry the run was built with", async () => {
    const packCard: HeuristicCard = { id: "pack_p.only", version: 1, family: "vary", level: "strategy", ask: "Which parameter would you vary first, and why?", tradition: "test", source: "test" };
    const w = await world({ heuristics: ["pack_p.only"], noCardShare: 0, strategies: false }, { packs: [{ manifest: { name: "p" }, heuristics: [packCard] }] });
    const decision = await w.fleet.hooks.beforeSession?.(w.session("p1", 1));
    assert.equal(decision?.settings?.heuristic, "pack_p.only");
    const sections = (await w.fleet.hooks.briefingSections?.(w.session("p1", 1, decision?.settings ?? {}))) ?? [];
    assert.match(sections[0]?.text ?? "", /\[begin text of pack:p\]/);
  });

  it("reports a card id the bank does not have before any prover starts", async () => {
    const w = await world({ heuristics: ["nope"] });
    await assert.rejects(async () => w.fleet.hooks.beforeProvers?.(w.problem()), /does not have: nope/);
    const fine = await world({ heuristics: true });
    await fine.fleet.hooks.beforeProvers?.(fine.problem());
  });

  it("leaves the attempt's settings as they were when the bank is off", async () => {
    const w = await world({ seed: 4 });
    const decision = await w.fleet.hooks.beforeSession?.(w.session("p1", 1));
    assert.equal(decision?.settings?.heuristic, undefined);
    await w.fleet.hooks.afterAttempt?.(w.problem(), { attemptId: "att_p1_1", prover: "p1", session: 1 } as unknown as FinishedAttempt);
  });
});
