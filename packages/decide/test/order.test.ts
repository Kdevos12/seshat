import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInterrupted } from "@seshat/lines";
import { decideOrderer, ForbiddenDecisionError, keepOrder, type OrderCandidate, scriptedOrderer } from "../src/index.ts";
import { Paused, rig, scriptedLlm, verdict } from "./helpers.ts";

const c = (id: string, source: OrderCandidate["source"] = "battery"): OrderCandidate => ({ id, text: `try ${id}`, source });
const list = [c("simp"), c("omega", "mined"), c("rfl"), c("aesop", "aesop")];
const ids = (o: { candidates: OrderCandidate[] }) => o.candidates.map((x) => x.id);

describe("the orderer of prove.search", () => {
  it("sorts by the decision's probabilities, ties in the order given", async () => {
    const { decide } = rig({ config: { backend: "faux" }, external: { output: { answer: "omega", probabilities: { simp: 0.1, omega: 0.5, rfl: 0.1, aesop: 0.3 }, backend: "faux", model: "faux", costUsd: 0 }, modelCallIds: [] } });
    const out = await decideOrderer(decide).order("goal", list);
    assert.deepEqual(ids(out), ["omega", "aesop", "simp", "rfl"]);
    assert.equal(out.by, "decision");
  });

  it("separates only the top candidate with the run's model and one vote", async () => {
    const { decide } = rig({ llm: scriptedLlm([verdict("rfl")]) });
    assert.deepEqual(ids(await decideOrderer(decide).order("goal", list)), ["rfl", "simp", "omega", "aesop"]);
  });

  it("never orders a candidate a model proposed: its own rank is free and stays", async () => {
    const { decide, recorded } = rig({ llm: scriptedLlm([verdict("simp")]) });
    const mixed = [c("simp"), { id: "llm1", text: "by the model", source: "llm" as never }];
    await assert.rejects(decideOrderer(decide).order("goal", mixed), ForbiddenDecisionError);
    await assert.rejects(keepOrder.order("goal", mixed), ForbiddenDecisionError);
    assert.equal(recorded.length, 0);
  });

  it("keeps the order when the site is off, with fewer than two candidates, or when the decision fails", async () => {
    const off = rig({ config: { sites: { "prove.search.order": "off" } } });
    assert.deepEqual(ids(await decideOrderer(off.decide).order("goal", list)), ids({ candidates: list }));
    const one = rig({});
    assert.equal((await decideOrderer(one.decide).order("goal", [c("simp")])).by, "kept");
    const failing = rig({ llm: scriptedLlm([]) });
    const out = await decideOrderer(failing.decide).order("goal", list);
    assert.deepEqual([out.by, ids(out)], ["kept", ["simp", "omega", "rfl", "aesop"]]);
  });

  it("lets a pause through", async () => {
    const { decide } = rig({ interrupted: () => new Paused() });
    await assert.rejects(decideOrderer(decide).order("goal", list), (error) => isInterrupted(error));
  });

  it("ranks the first 255 and keeps the rest after them", async () => {
    const many = Array.from({ length: 300 }, (_, i) => c(`t${i}`));
    const { decide } = rig({ llm: scriptedLlm([verdict("t200")]) });
    const out = await decideOrderer(decide).order("goal", many);
    assert.equal(out.candidates.length, 300);
    assert.deepEqual([out.candidates[0]?.id, out.candidates[255]?.id, out.candidates[299]?.id], ["t200", "t255", "t299"]);
  });

  it("has a double for the search's own tests", async () => {
    const double = scriptedOrderer(["rfl", "aesop"]);
    assert.deepEqual(ids(await double.order("goal", list)), ["rfl", "aesop", "simp", "omega"]);
    assert.deepEqual(double.asked, [{ state: "goal", ids: ["simp", "omega", "rfl", "aesop"] }]);
  });
});
