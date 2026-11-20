import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocations } from "../src/index.ts";
import { BUCKET, world } from "./world.ts";

describe("the bucket prior in the fleet", () => {
  it("records the bucket with no cards, only when the option is on", async () => {
    const on = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 1 });
    assert.equal((await on.fleet.hooks.beforeSession?.(on.session(1)))?.settings?.heuristicBucket, BUCKET);
    const off = await world({ thinking: ["low", "high"], seed: 1 });
    assert.equal((await off.fleet.hooks.beforeSession?.(off.session(1)))?.settings?.heuristicBucket, undefined);
  });

  it("does not draw a thinking level the bucket shows to hurt, on a claim with no history of its own", async () => {
    const w = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 3 });
    for (let k = 0; k < 8; k++) {
      w.put(w.otherClaim, { thinking: "low", heuristicBucket: BUCKET }, "valid");
      w.put(w.otherClaim, { thinking: "high", heuristicBucket: BUCKET }, "invalid");
    }
    for (let n = 1; n <= 5; n++) assert.equal((await w.fleet.hooks.beforeSession?.(w.session(n)))?.settings?.thinking, "low");
    // The bucket's history is the bucket's only: attempts recorded under another bucket say nothing.
    const alone = await world({ bucketPrior: true, thinking: ["low", "high"], seed: 3 });
    for (let k = 0; k < 8; k++) {
      alone.put(alone.otherClaim, { thinking: "low", heuristicBucket: "elsewhere" }, "valid");
      alone.put(alone.otherClaim, { thinking: "high", heuristicBucket: "elsewhere" }, "invalid");
    }
    const seen = new Set<unknown>();
    for (let n = 1; n <= 40; n++) seen.add((await alone.fleet.hooks.beforeSession?.(alone.session(n)))?.settings?.thinking);
    assert.equal(seen.size, 2);
    assert.ok(allocations(w.memory, w.claimId).length === 5);
  });
});
