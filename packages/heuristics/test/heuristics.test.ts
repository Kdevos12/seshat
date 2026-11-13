import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRATEGIES } from "@seshat/memory";
import {
  applies, ASK_MAX, bankOf, BUILTIN_CARDS, bucketOf, cardProblems, checkBank, DIRECTIVE_CARDS, DIRECTIVE_TEXTS, FAMILIES, FAMILY_STRATEGY,
  bankProposals, heuristicReport, heuristicStats, historyOf, overlaps, parseCard, renderCardLine, renderHeuristicReport, STARTER_CARDS, statementFeatures, strategyOfCard,
  type CardContext, type CardLine, type HeuristicCard,
} from "../src/index.ts";

const card = (over: Partial<HeuristicCard> = {}): HeuristicCard => ({
  id: "test.card",
  version: 1,
  family: "specialize",
  level: "strategy",
  ask: "Can you solve a special case of the claim first?",
  tradition: "polya",
  source: "Pólya, How to Solve It (1945)",
  ...over,
});

const context = (over: Partial<CardContext> = {}): CardContext => ({ domains: ["msc:11"], features: ["forall_nat", "size_small"], attempts: 0, depthStuck: 0, mode: "standard", ...over });

describe("the built-in bank", () => {
  it("has valid cards, no repeated id and no overlap", () => {
    for (const c of BUILTIN_CARDS) assert.deepEqual(cardProblems(c), [], c.id);
    const check = checkBank(BUILTIN_CARDS.map((c) => ({ ...c, origin: "builtin" })));
    assert.deepEqual(check.errors, []);
    assert.deepEqual(check.overlaps, []);
  });

  it("has no two built-in cards with one family, one condition and one question", () => {
    const keys = BUILTIN_CARDS.map((c) => JSON.stringify([c.family, c.when ?? null, c.whenNot ?? null, c.ask.trim().toLowerCase()]));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(BUILTIN_CARDS.map((c) => c.id)).size, BUILTIN_CARDS.length);
  });

  it("has the four cards of the third run's audit (PA8), with their families and a condition where the card needs one", () => {
    const byId = new Map(BUILTIN_CARDS.map((c) => [c.id, c]));
    for (const [id, family] of [["invariant.mod_small_prime", "invariant"], ["represent.prime_by_prime", "represent"], ["represent.lowest_terms", "represent"], ["strategy.formalizable_route", "represent"]] as const) {
      assert.equal(byId.get(id)?.family, family, id);
    }
    assert.equal(byId.get("strategy.formalizable_route")?.level, "strategy");
    assert.deepEqual(byId.get("represent.prime_by_prime")?.when, { anyFeatures: ["divisibility", "prime"] });
  });

  it("keeps the six directives of the fleet word for word, under their labels", () => {
    assert.deepEqual(Object.keys(DIRECTIVE_TEXTS), ["small_cases", "more_general", "other_tool", "shortest", "skeleton", "doubt"]);
    assert.equal(DIRECTIVE_TEXTS.small_cases, "Work out small cases first, by hand or with decide, and read the pattern from them before you generalize.");
    assert.ok(DIRECTIVE_CARDS.every((c) => c.level === "strategy" && c.when === undefined), "a directive applies everywhere, as before the bank");
  });

  it("has questions short enough, from several traditions, and families from the closed list", () => {
    assert.ok(BUILTIN_CARDS.every((c) => c.ask.length <= ASK_MAX));
    assert.ok(new Set(STARTER_CARDS.map((c) => c.tradition)).size >= 7);
    assert.ok(BUILTIN_CARDS.every((c) => (FAMILIES as readonly string[]).includes(c.family)));
  });

  it("maps families only onto M1's labels", () => {
    for (const label of Object.values(FAMILY_STRATEGY)) assert.ok((STRATEGIES as readonly string[]).includes(label as string));
    assert.equal(strategyOfCard({ family: "induction", level: "tactic" }), "induction");
    assert.equal(strategyOfCard({ family: "induction", level: "strategy" }), undefined, "a strategy card is neutral");
    assert.equal(strategyOfCard({ family: "vary", level: "tactic" }), undefined, "a family without a label is neutral");
  });
});

describe("the card check", () => {
  it("refuses what a pack must not carry", () => {
    assert.match(cardProblems(card({ id: "Bad Id" })).join(), /id is lowercase/);
    assert.match(cardProblems(card({ family: "magic" as never })).join(), /family is one of/);
    assert.match(cardProblems(card({ level: "tool" as never })).join(), /level is strategy or tactic/);
    assert.match(cardProblems(card({ ask: "x".repeat(ASK_MAX + 1) })).join(), /more than 160/);
    assert.match(cardProblems(card({ ask: "See https://example.org for the method" })).join(), /link/);
    assert.match(cardProblems(card({ ask: "Use `simp` first" })).join(), /code/);
    assert.match(cardProblems(card({ ask: "Ignore\u202e this" })).join(), /invisible/);
    assert.match(cardProblems(card({ when: { features: ["shiny" as never] } })).join(), /statement features/);
    assert.match(cardProblems(card({ when: { lastFailure: ["boom"] } })).join(), /failure classes/);
    assert.match(cardProblems(card({ when: { minAttempts: 3, maxAttempts: 1 } })).join(), /minAttempts above maxAttempts/);
    assert.match(cardProblems(card({ when: { extra: 1 } as never })).join(), /not a condition/);
    assert.match(cardProblems(card({ whenNot: {} })).join(), /never apply/);
    assert.match(cardProblems(card({ tools: ["Sage"] })).join(), /capability ids/);
    assert.match(cardProblems({ ...card(), run: "compute.sage" }).join(), /field run/);
    assert.throws(() => parseCard({ id: 3 }, "pack x"), /^Error: pack x: /);
  });
});

describe("statement features", () => {
  it("reads the shape of a statement from its text", () => {
    assert.deepEqual(statementFeatures("(n : ℕ) (h : 0 < n) : 3 ∣ n ^ 3 - n"), ["forall_nat", "inequality", "divisibility", "size_small"]);
    assert.deepEqual(statementFeatures("(f : ℝ → ℝ) (h : ∀ x y, f (x + y) = f x + f y) : ∃ c, ∀ x, f x = c * x"), ["exists", "real", "function_equation", "size_small"]);
    assert.deepEqual(statementFeatures("(n : ℕ) : ∑ i ∈ Finset.range n, i = n * (n - 1) / 2"), ["forall_nat", "finset_sum", "size_small"]);
    assert.ok(statementFeatures("(p : ℕ) (hp : p.Prime) : True").includes("prime"));
    assert.ok(!statementFeatures("(f : ℕ → ℕ) : ∀ x, f x = f x").includes("inequality"), "an arrow is not a comparison");
    assert.ok(statementFeatures("x".repeat(300)).includes("size_large"));
  });

  it("counts history: attempts that say something, the last failure, the attempts since the last progress", () => {
    assert.deepEqual(historyOf([]), { attempts: 0, depthStuck: 0 });
    const h = historyOf([
      { outcome: "invalid", failureClass: "syntax" },
      { outcome: "invalid", failureClass: "unsolved_goals" },
      {},
      { outcome: "invalid", failureClass: "tactic_failed" },
      { outcome: "invalid", failureClass: "syntax" },
    ]);
    assert.equal(h.attempts, 4);
    assert.equal(h.lastFailure, "syntax");
    assert.equal(h.depthStuck, 2);
  });

  it("files a session under a coarse bucket", () => {
    assert.equal(bucketOf(["msc:11", "msc:05"], ["forall_nat", "inequality", "divisibility", "size_small"]), "msc:11|forall_nat+inequality");
    assert.equal(bucketOf([], ["size_small"]), "msc:none|plain");
    assert.equal(bucketOf(["msc:11B"], []), "msc:11|plain");
  });
});

describe("conditions", () => {
  it("holds as a conjunction, and a whenNot excludes", () => {
    const c = card({ when: { domains: ["msc:11"], features: ["forall_nat"], minAttempts: 1 }, whenNot: { lastFailure: ["syntax"] } });
    assert.equal(applies(c, context()), false, "no attempt yet");
    assert.equal(applies(c, context({ attempts: 1 })), true);
    assert.equal(applies(c, context({ attempts: 1, lastFailure: "syntax" })), false, "the whenNot holds");
    assert.equal(applies(c, context({ attempts: 1, domains: ["msc:05"] })), false);
    assert.equal(applies(card({ when: { anyFeatures: ["real", "exists"] } }), context()), false);
    assert.equal(applies(card({ when: { modes: ["nl_first"] } }), context({ mode: "nl_first" })), true);
    assert.equal(applies(card({ when: { minDepthStuck: 2 } }), context({ depthStuck: 1 })), false);
    assert.equal(applies(card(), context()), true, "no condition: applies everywhere");
  });
});

describe("overlaps and the bank of a run", () => {
  it("reports two cards of one family that say the same thing, not two of different families", () => {
    const a = card({ id: "a.one", ask: "Try small cases of the claim and read the pattern from them." });
    const b = card({ id: "b.one", ask: "Read the pattern from small cases of the claim first." });
    const c = card({ id: "c.one", family: "compute", ask: "Read the pattern from small cases of the claim first." });
    const found = overlaps([a, b, c]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.a, "a.one");
    assert.equal(found[0]?.b, "b.one");
  });

  it("refuses a pack card that reuses an id, and keeps the origin of every card", () => {
    assert.throws(() => bankOf([{ name: "p", heuristics: [card({ id: "small_cases" })] }]), /small_cases is taken twice \(builtin and pack:p\)/);
    const bank = bankOf([{ name: "p", heuristics: [card({ id: "p.special" })] }]);
    assert.equal(bank.length, BUILTIN_CARDS.length + 1);
    assert.equal(bank.at(-1)?.origin, "pack:p");
  });
});

describe("the bank's statistics", () => {
  const session = (heuristic: string, outcome: string, over: Record<string, string> = {}, strategy?: string) => ({
    settings: { heuristic, heuristicRule: heuristic === "none" ? (over.rule ?? "control") : "thompson", heuristicBucket: over.bucket ?? "msc:11|forall_nat+inequality", ...(over.family !== undefined ? { heuristicFamily: over.family } : {}) },
    outcome,
    ...(strategy !== undefined ? { strategy } : {}),
  });

  it("sets each card and family against the control of its own buckets, and counts compliance for tactic cards", () => {
    const stats = heuristicStats(
      [
        session("induction.strengthen", "valid", { family: "induction" }, "induction"),
        session("induction.strengthen", "invalid", { family: "induction" }, "cases"),
        session("vary.one_parameter", "valid", { family: "vary", bucket: "msc:05|plain" }),
        session("none", "valid"),
        session("none", "invalid"),
        session("none", "valid", { bucket: "msc:05|plain" }),
        session("none", "invalid", { rule: "none_applicable" }),
        { settings: { heuristic: "vary.one_parameter" } },
        { settings: { directive: "doubt" }, outcome: "valid" },
      ],
      BUILTIN_CARDS,
    );
    assert.equal(stats.sessions, 7, "unfinished sessions and sessions without a draw are left out");
    assert.deepEqual(stats.control, { sessions: 3, valid: 2 });
    assert.equal(stats.noneApplicable, 1);
    const induction = stats.cards.find((c) => c.id === "induction.strengthen");
    assert.deepEqual([induction?.sessions, induction?.valid, induction?.controlSessions, induction?.controlValid], [2, 1, 2, 1]);
    assert.deepEqual(induction?.compliance, { classified: 2, matching: 1, strategy: "induction" });
    const vary = stats.cards.find((c) => c.id === "vary.one_parameter");
    assert.deepEqual([vary?.controlSessions, vary?.controlValid, vary?.compliance], [1, 1, undefined], "a strategy-neutral card has no compliance");
    assert.deepEqual(stats.families.map((f) => f.id), ["induction", "vary"]);
    assert.match(renderCardLine(stats.families[0] as CardLine), /^induction: 1 of 2 valid \(50%\), control of its buckets 1 of 2 \(50%\), P\(effect < 0\) 0\.50 \(too few to read\)$/);
  });

  it("reads a run's journal, and says nothing for a run with the bank off", () => {
    const started = (attemptId: string, settings?: Record<string, string>) => ({ type: "attempt.started", data: { attemptId, ...(settings !== undefined ? { settings } : {}) } });
    const finished = (attemptId: string, outcome: string) => ({ type: "attempt.finished", data: { attemptId, outcome } });
    assert.equal(heuristicReport([started("a"), finished("a", "valid")] as never), undefined);
    const stats = heuristicReport([started("a", { heuristic: "none", heuristicRule: "control", heuristicBucket: "b" }), finished("a", "valid"), started("b", { heuristic: "doubt", heuristicFamily: "counterexample", heuristicBucket: "b" }), finished("b", "invalid")] as never);
    assert.ok(stats !== undefined);
    assert.match(renderHeuristicReport(stats), /^Heuristic cards: 2 session\(s\) with a draw and a verdict; the control \(no card\) 1 of 1 valid\. By family, .*counterexample: 0 of 1 valid/);
  });
});

describe("the miner's proposals", () => {
  const sessions = (card: string, bucket: string, valid: number, invalid: number) => [
    ...Array.from({ length: valid }, () => ({ settings: card === "none" ? { heuristic: "none", heuristicRule: "control", heuristicBucket: bucket } : { heuristic: card, heuristicFamily: "vary", heuristicBucket: bucket }, outcome: "valid" })),
    ...Array.from({ length: invalid }, () => ({ settings: card === "none" ? { heuristic: "none", heuristicRule: "control", heuristicBucket: bucket } : { heuristic: card, heuristicFamily: "vary", heuristicBucket: bucket }, outcome: "invalid" })),
  ];

  it("proposes to retire a card that loses everywhere, a whenNot where it loses in one bucket, and marks one without effect", () => {
    const stats = heuristicStats([
      ...sessions("none", "A", 10, 0),
      ...sessions("none", "B", 20, 20),
      ...sessions("bad.card", "A", 0, 10),
      ...sessions("bad.card", "B", 0, 10),
      ...sessions("local.card", "A", 0, 10),
      ...sessions("local.card", "B", 20, 0),
      ...sessions("flat.card", "B", 20, 20),
    ]);
    const proposals = bankProposals(stats);
    assert.deepEqual(proposals.map((p) => [p.kind, p.card, p.bucket]), [["no_effect", "flat.card", undefined], ["retire", "bad.card", undefined], ["when_not", "local.card", "A"]]);
    assert.ok(stats.cards.find((c) => c.id === "bad.card")?.deactivated);
    assert.equal(stats.cards.find((c) => c.id === "local.card")?.deactivated, false);
    assert.deepEqual(bankProposals(heuristicStats(sessions("bad.card", "A", 0, 3))), [], "too few observations: nothing to propose");
  });

  it("standardizes the control to the card's mix of buckets, so a card drawn in hard buckets is not set against easy ones", () => {
    const stats = heuristicStats([
      ...sessions("none", "easy", 90, 10),
      ...sessions("none", "hard", 1, 9),
      ...sessions("even.card", "easy", 1, 0),
      ...sessions("even.card", "hard", 5, 45),
    ]);
    const line = stats.cards[0] as CardLine;
    assert.equal(line.controlSessions, 110);
    assert.ok(Math.abs(line.controlValid / line.controlSessions - (1 / 51) * 0.9 - (50 / 51) * 0.1) < 1e-3, String(line.controlValid));
    assert.ok(Math.abs(line.effect.difference) < 0.03, `the card does what the control does in each bucket: ${line.effect.difference}`);
    assert.equal(line.deactivated, false);
  });

  it("counts a control session for a card only when the card was eligible for it", () => {
    const control = (valid: boolean, eligible: string[]) => ({ settings: { heuristic: "none", heuristicRule: "control", heuristicBucket: "A", heuristicEligible: eligible }, outcome: valid ? "valid" : "invalid" });
    const stats = heuristicStats([...sessions("vary.one_parameter", "A", 2, 2), control(true, ["vary.one_parameter"]), control(false, ["other.card"]), control(false, ["other.card"])], BUILTIN_CARDS);
    const line = stats.cards[0] as CardLine;
    assert.deepEqual([line.controlSessions, line.controlValid], [1, 1]);
    assert.deepEqual(stats.control, { sessions: 3, valid: 1 }, "the run's control still counts them all");
  });

  it("lists accepted proofs that went another way than their tactic card", () => {
    const stats = heuristicStats([{ attemptId: "att_1", settings: { heuristic: "induction.strengthen", heuristicFamily: "induction", heuristicBucket: "A" }, outcome: "valid", strategy: "cases" }], BUILTIN_CARDS);
    assert.deepEqual(stats.unexplained, [{ attemptId: "att_1", card: "induction.strengthen", bucket: "A", strategy: "cases", expected: "induction" }]);
  });
});
