import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLD_START_SITE, coldStartPriors, MAX_COLD_START_WEIGHT, pseudoCounts, withPrior } from "../src/index.ts";
import { rig, scriptedLlm, verdict } from "./helpers.ts";

describe("cold-start priors", () => {
  it("turn a distribution into pseudo-counts of weight 2 by default", () => {
    assert.deepEqual(pseudoCounts({ induction: 1, cases: 0, algebra: 0.25 }), {
      induction: { alpha: 3, beta: 1 },
      cases: { alpha: 1, beta: 3 },
      algebra: { alpha: 1.5, beta: 2.5 },
    });
    assert.deepEqual(pseudoCounts({ a: 1 }, 0), { a: { alpha: 1, beta: 1 } });
    assert.throws(() => pseudoCounts({ a: 1 }, MAX_COLD_START_WEIGHT + 1), RangeError);
  });

  it("are outweighed by the journal's attempts after a few of them", () => {
    const favoured = pseudoCounts({ a: 1, b: 0 });
    let a = withPrior({ alpha: 1, beta: 1 }, favoured.a);
    let b = withPrior({ alpha: 1, beta: 1 }, favoured.b);
    assert.ok((a?.alpha ?? 0) / ((a?.alpha ?? 0) + (a?.beta ?? 1)) > 0.7);
    // Four failures of a and four successes of b: the prior no longer decides.
    a = { alpha: (a?.alpha ?? 0), beta: (a?.beta ?? 0) + 4 };
    b = { alpha: (b?.alpha ?? 0) + 4, beta: (b?.beta ?? 0) };
    const mean = (x: { alpha: number; beta: number } | undefined) => (x?.alpha ?? 0) / ((x?.alpha ?? 0) + (x?.beta ?? 1));
    assert.ok(mean(b) > mean(a));
    assert.equal(withPrior(undefined, undefined), undefined);
    assert.deepEqual(withPrior(undefined, { alpha: 2, beta: 1 }), { alpha: 2, beta: 1 });
  });

  it("come from a choice over the families at the fleet's site", async () => {
    const { decide, recorded } = rig({ llm: scriptedLlm([verdict("cases")]) });
    const priors = await coldStartPriors(decide, { statement: "(n : ℕ) : n + 0 = n", families: ["induction", "cases", "algebra"] });
    assert.deepEqual(priors?.cases, { alpha: 3, beta: 1 });
    assert.equal(recorded[0]?.site, COLD_START_SITE);
    assert.equal(await coldStartPriors(decide, { statement: "s", families: ["only"] }), undefined);
    const off = rig({ config: { sites: { [COLD_START_SITE]: "off" } } });
    assert.equal(await coldStartPriors(off.decide, { statement: "s", families: ["a", "b"] }), undefined);
    const failing = rig({ llm: scriptedLlm([]) });
    assert.equal(await coldStartPriors(failing.decide, { statement: "s", families: ["a", "b"] }), undefined, "a failure leaves the flat prior");
  });
});
