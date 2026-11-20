import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Attempt } from "@seshat/memory";
import { allocations, excludedAfterStall, repeatStopped } from "../src/index.ts";
import { world } from "./world.ts";

const options = { modes: ["standard", "nl_first"], thinking: ["low", "high"], seed: 5, switchOnStall: true };

/** The finding M6's repeat rule records when it stops a session. */
function repeatFinding(w: Awaited<ReturnType<typeof world>>, attemptId: string) {
  w.memory.recordNode({ kind: "drift", claimId: w.claimId, data: { kind: "repeated_failure", action: "stopped_session", detail: "the same failure four times", attemptId, prover: "p1", session: 1 } });
}

describe("restarting in another mode after a Lean stall", () => {
  it("leaves out the mode and the thinking level of an attempt M6's repeat rule stopped, and records it", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const w = await world({ ...options, seed });
      const id = w.put(w.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p1");
      repeatFinding(w, id);
      const settings = (await w.fleet.hooks.beforeSession?.(w.session(2)))?.settings;
      assert.equal(settings?.mode, "standard");
      assert.equal(settings?.thinking, "low");
      assert.deepEqual(allocations(w.memory, w.claimId).at(-1)?.data.excluded, { mode: "nl_first", thinking: "high" });
    }
  });

  it("does nothing for an attempt that did not stall, with the option off, or for another prover's attempt", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const w = await world({ ...options, seed });
      w.put(w.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p1");
      const settings = (await w.fleet.hooks.beforeSession?.(w.session(2)))?.settings;
      // A session drawn for nl_first without a model runs as a standard one and records the draw as `drawnMode`.
      seen.add(`${settings?.drawnMode ?? settings?.mode}/${settings?.thinking}`);
      assert.equal(allocations(w.memory, w.claimId).at(-1)?.data.excluded, undefined);
    }
    assert.ok([...seen].some((v) => v.startsWith("nl_first")) && [...seen].some((v) => v.endsWith("high")), [...seen].join());
    const off = await world({ ...options, switchOnStall: false, seed: 1 });
    repeatFinding(off, off.put(off.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p1"));
    await off.fleet.hooks.beforeSession?.(off.session(2));
    assert.equal(allocations(off.memory, off.claimId).at(-1)?.data.excluded, undefined);
    const other = await world({ ...options, seed: 1 });
    repeatFinding(other, other.put(other.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p2"));
    await other.fleet.hooks.beforeSession?.(other.session(2));
    assert.equal(allocations(other.memory, other.claimId).at(-1)?.data.excluded, undefined);
  });

  it("leaves out the values of the last attempt when the claim stagnates", async () => {
    const w = await world({ ...options, seed: 2 });
    for (let k = 0; k < 3; k++) w.put(w.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p1");
    const settings = (await w.fleet.hooks.beforeSession?.(w.session(4)))?.settings;
    assert.equal(settings?.mode, "standard");
    assert.equal(settings?.thinking, "low");
  });

  it("never leaves out every value", async () => {
    const w = await world({ ...options, modes: ["standard"], thinking: ["high"], seed: 2 });
    repeatFinding(w, w.put(w.claimId, { mode: "standard", thinking: "high" }, "invalid", "p1"));
    const settings = (await w.fleet.hooks.beforeSession?.(w.session(2)))?.settings;
    assert.equal(settings?.mode, "standard");
    assert.equal(settings?.thinking, "high");
    assert.equal(allocations(w.memory, w.claimId).at(-1)?.data.excluded, undefined);
  });
});

describe("the readings of a stall", () => {
  it("finds the attempts the repeat rule stopped among the drift findings, and only those", () => {
    const node = (data: object) => ({ data }) as never;
    const ids = repeatStopped([
      node({ kind: "repeated_failure", action: "stopped_session", attemptId: "a1" }),
      node({ kind: "repeated_failure", action: "noted", attemptId: "a2" }),
      node({ kind: "session_loop", action: "stopped_session", attemptId: "a3" }),
    ]);
    assert.deepEqual([...ids], ["a1"]);
  });

  it("takes the last finished attempt of the prover", () => {
    const at = (attemptId: string, prover: string, seq: number, settings: object): Attempt =>
      ({ attemptId, claimId: "c", prover, iteration: seq, model: "m", role: "prove", startedSeq: seq, finishedSeq: seq + 1, outcome: "invalid", settings }) as unknown as Attempt;
    const attempts = [at("a1", "p1", 1, { mode: "standard" }), at("a2", "p1", 5, { mode: "nl_first", thinking: "low" }), at("a3", "p2", 9, { mode: "standard" })];
    assert.deepEqual(excludedAfterStall(attempts, "p1", new Set(["a2"]), false), { mode: "nl_first", thinking: "low" });
    assert.equal(excludedAfterStall(attempts, "p1", new Set(["a1"]), false), undefined, "an earlier attempt's stall is over");
    assert.equal(excludedAfterStall(attempts, "p9", new Set(["a2"]), true), undefined, "no attempt of the prover");
  });
});

describe("with bucketPrior and switchOnStall absent", () => {
  it("draws and records what the options set to false do, whatever the bucket and the stalls hold: the claim's own attempts alone", async () => {
    const base = { modes: ["standard", "nl_first"], thinking: ["low", "high"] };
    for (let seed = 1; seed <= 8; seed++) {
      const run = async (extra: object) => {
        const w = await world({ ...base, seed, ...extra });
        // A history that both options would read: the bucket's other claim favours one value, and the claim's own attempt was stopped by the repeat rule.
        for (let k = 0; k < 4; k++) w.put(w.otherClaim, { mode: "nl_first", thinking: "high" }, "valid");
        repeatFinding(w, w.put(w.claimId, { mode: "nl_first", thinking: "high" }, "invalid", "p1"));
        const settings = (await w.fleet.hooks.beforeSession?.(w.session(2)))?.settings;
        return { settings, allocation: allocations(w.memory, w.claimId).at(-1)?.data };
      };
      const absent = await run({});
      const off = await run({ bucketPrior: false, switchOnStall: false });
      assert.deepEqual(absent, off, `seed ${seed}`);
      assert.equal(absent.allocation?.excluded, undefined);
    }
  });
});
