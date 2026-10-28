import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seeded } from "@seshat/core";
import { leafPrice, PRIOR_SESSION_USD, priceBook, taskWeight } from "../src/index.ts";

describe("prices", () => {
  it("starts from a flat posterior and a guessed cost, then follows the sessions", () => {
    const flat = priceBook([]);
    assert.deepEqual(flat.rate, { alpha: 1, beta: 1 });
    assert.equal(flat.sessionUsd, PRIOR_SESSION_USD);
    const book = priceBook([{ ok: true, usd: 0.02 }, { ok: false, usd: 0.04 }, { ok: false, usd: 0.06 }]);
    assert.deepEqual(book.rate, { alpha: 2, beta: 3 });
    assert.ok(Math.abs(book.sessionUsd - 0.04) < 1e-12);
  });

  it("draws the rate from the run's seeded source: the same seed prices the same, another seed differently", () => {
    const book = priceBook([{ ok: false, usd: 0.05 }, { ok: true, usd: 0.05 }]);
    const a = leafPrice(book, seeded(7), 8);
    assert.equal(leafPrice(book, seeded(7), 8), a);
    assert.notEqual(leafPrice(book, seeded(8), 8), a);
  });

  it("never prices more than the task's sessions cost, and a hopeless rate is capped", () => {
    const hopeless = priceBook(Array.from({ length: 50 }, () => ({ ok: false, usd: 0.1 })));
    const price = leafPrice(hopeless, seeded(1), 4);
    assert.ok(price <= 0.1 * 4 + 1e-12);
  });

  it("weighs a task by its price over one plus the value of its lemma", () => {
    assert.equal(taskWeight(2, 0), 2);
    assert.equal(taskWeight(2, 1), 1);
    assert.equal(taskWeight(2, -5), 2);
  });
});
