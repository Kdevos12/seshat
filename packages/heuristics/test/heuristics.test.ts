import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { framingProblems } from "@seshat/guards";
import { STRATEGIES } from "@seshat/memory";
import {
  applies, ASK_MAX, bankOf, BUILTIN_CARDS, bucketOf, cardProblems, checkBank, DIRECTIVE_CARDS, DIRECTIVE_TEXTS, FAMILIES, FAMILY_STRATEGY,
  historyOf, overlaps, parseCard, STARTER_CARDS, statementFeatures, strategyOfCard, type CardContext, type HeuristicCard,
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

  it("keeps the six directives of the fleet word for word, under their labels", () => {
    assert.deepEqual(Object.keys(DIRECTIVE_TEXTS), ["small_cases", "more_general", "other_tool", "shortest", "skeleton", "doubt"]);
    assert.equal(DIRECTIVE_TEXTS.small_cases, "Work out small cases first, by hand or with decide, and read the pattern from them before you generalize.");
    assert.ok(DIRECTIVE_CARDS.every((c) => c.level === "strategy" && c.when === undefined), "a directive applies everywhere, as before the bank");
  });

  it("asks for no demonstration in any card (M6's framing check finds nothing)", () => {
    for (const c of BUILTIN_CARDS) assert.deepEqual(framingProblems(c.ask), [], c.id);
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
