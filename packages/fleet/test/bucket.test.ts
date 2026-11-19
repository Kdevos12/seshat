import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deactivatedValues, sampleSettings, seeded, settingKeyOf, type SettingsBucket, valueMeans, withPrior } from "../src/index.ts";
import { failedAt, proved } from "./helpers.ts";

const thinking = (level: string) => ({ settings: { thinking: level } });
const rule = { minObservations: 4 };
const many = (n: number, make: () => ReturnType<typeof proved>) => Array.from({ length: n }, make);
/** A bucket where `low` proves and `high` fails. */
const lowWins = [...many(6, () => proved(undefined, thinking("low"))), ...many(6, () => failedAt("unsolved_goals", undefined, thinking("high")))];
const bucketOf = (history: SettingsBucket["history"], priorWeight = 2): SettingsBucket => ({ history, priorWeight, rule });
const config = { thinking: ["low", "high"] };

describe("the bucket module", () => {
  it("the prior adds weight pseudo-sessions at the mean to a posterior, and to the flat one when nothing is known", () => {
    assert.deepEqual(withPrior(undefined, { mean: 0.75, weight: 4 }), { alpha: 4, beta: 2 });
    assert.deepEqual(withPrior({ alpha: 2, beta: 3 }, { mean: 0.5, weight: 2 }), { alpha: 3, beta: 4 });
  });

  it("the means of a keyed setting are those of its values seen in the history", () => {
    const means = valueMeans(lowWins, (a) => settingKeyOf(a, "thinking"), 0.5);
    assert.ok((means.get("low") ?? 0) > 0.8 && (means.get("high") ?? 1) < 0.5);
    assert.equal(means.has("medium"), false);
  });

  it("a value is turned off by the rule against the other values, and never every value", () => {
    const key = (a: (typeof lowWins)[number]) => settingKeyOf(a, "thinking");
    assert.deepEqual(deactivatedValues(["low", "high"], lowWins, key, rule), ["high"]);
    assert.deepEqual(deactivatedValues(["low", "high"], lowWins.slice(0, 6), key, rule), [], "too few observations of the other");
    // Each of the two is worse than the other: the rule would turn both off, so none is.
    const both = [...many(6, () => proved(undefined, thinking("low"))), ...many(6, () => failedAt("x", undefined, thinking("high")))];
    assert.ok(deactivatedValues(["low", "high"], both, key, rule).length < 2);
  });
});

describe("sampleSettings with the bucket prior", () => {
  it("draws the value with the good bucket mean more often from an empty claim history", () => {
    const count = { low: 0, high: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      // A weight high enough that the prior is what decides, with nothing deactivated (too few observations).
      const picked = sampleSettings(seeded(seed), config, [], 0.5, undefined, undefined, bucketOf(lowWins.slice(0, 3).concat(lowWins.slice(6, 9)), 6)).settings.thinking;
      count[picked as "low" | "high"] += 1;
    }
    assert.ok(count.low > count.high + 40, JSON.stringify(count));
  });

  it("does not draw a value deactivated in the bucket while another is left", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const out = sampleSettings(seeded(seed), config, [], 0.5, undefined, undefined, bucketOf(lowWins));
      assert.equal(out.settings.thinking, "low");
      assert.deepEqual(Object.keys(out.draws.thinking ?? {}), ["low"]);
    }
  });

  it("with a single value, nothing is deactivated", () => {
    const out = sampleSettings(seeded(1), { thinking: ["high"] }, [], 0.5, undefined, undefined, bucketOf(lowWins));
    assert.equal(out.settings.thinking, "high");
  });

  it("without a bucket the output is the one of every seed before: same settings and same draws", () => {
    const full = { thinking: ["low", "medium", "high"], modes: ["standard", "nl_first"] as ("standard" | "nl_first")[], temperature: { values: [0.2, 0.8] } };
    const claim = [proved(undefined, thinking("low")), failedAt("x", undefined, thinking("high"))];
    for (let seed = 1; seed <= 30; seed++) {
      assert.deepEqual(sampleSettings(seeded(seed), full, claim, 0.5, undefined, undefined, undefined), sampleSettings(seeded(seed), full, claim, 0.5));
    }
  });
});
