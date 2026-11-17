import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { check } from "./m0-helpers.ts";
import { campaignConfig, failing, simulatedCampaign } from "./campaign-helpers.ts";
import type { HarnessEvent } from "@seshat/core";
import { activities, byActivity, deadEndStore, type DeadEnd, mergeDelta, parseReflection, renderDossier, toRetire } from "../src/index.ts";

let n = 0;
const ev = (type: string, data: Record<string, unknown>): HarnessEvent => ({ v: 1, seq: n++, id: `e${n}`, ts: "2026-11-17T00:00:00Z", run: "r", actor: "orchestrator", type, data }) as unknown as HarnessEvent;
const session = (id: string, over: Record<string, unknown>): HarnessEvent[] => [
  ev("attempt.started", { attemptId: id, claimId: "c", prover: "p1", iteration: 1, model: "m" }),
  ev("attempt.finished", { attemptId: id, outcome: "invalid", failureClass: "unsolved_goals", failureDetail: "unsolved goals  at   case succ", ...over }),
];

describe("the dossier's dead-end store", () => {
  it("shows a dead end once however often it repeats, merging by normalised detail and statement", () => {
    n = 0;
    const events = [...session("a1", {}), ...session("a2", { failureDetail: "unsolved goals at case succ" }), ...session("a3", { restart: { reason: "stuck", class: "unsolved_goals" } })];
    const { items } = deadEndStore(events, [{ statement: "p  and q", detail: "refuted by Lean", seq: 1 }, { statement: "p and q", detail: "refuted by Lean", seq: 2 }]);
    assert.equal(items.filter((i) => i.source !== "refuted").length, 1);
    const attempt = items.find((i) => i.source !== "refuted") as DeadEnd;
    assert.equal(attempt.count, 3);
    assert.equal(attempt.source, "stuck");
    assert.equal(items.filter((i) => i.source === "refuted").length, 1);
    assert.equal(items.find((i) => i.source === "refuted")?.count, 2);
  });

  it("is deterministic and bounded by tokens, with the statement always shown", () => {
    n = 0;
    const events = Array.from({ length: 30 }, (_, i) => session(`a${i}`, { failureDetail: `error number ${i} in some goal` })).flat();
    const { items } = deadEndStore(events, []);
    const act = activities(events, items, []);
    const input = { statement: "theorem t : 1 = 1", frontier: ["Established so far (0 entries):"], items: byActivity(items, act), activity: act, unverified: [{ title: "Lesson", text: "x".repeat(4000) }], tokens: 300 };
    const a = renderDossier(input);
    assert.equal(a, renderDossier(input));
    assert.match(a, /Statement \(signed\): theorem t : 1 = 1/);
    assert.match(a, /less active dead end/);
    assert.doesNotMatch(a, /xxxx/, "an unverified section that does not fit is left out");
    assert.match(a, /and 1 unverified note\(s\) not shown/, "and says so");
    assert.ok(a.length < 300 * 4 + 400);
  });

  it("retires the least active half past the bound and keeps the most active", () => {
    n = 0;
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 6; i++) events.push(...session(`a${i}`, { failureDetail: `goal ${i}` }));
    // The frontier grows during the next session, so the six items it was shown are followed; later sessions fail on goal 5 again (recalled).
    const grown = [...events, ev("attempt.started", { attemptId: "g", claimId: "c", prover: "p1", iteration: 1, model: "m" })];
    const growthSeq = n;
    grown.push(ev("attempt.finished", { attemptId: "g", outcome: "no_submission" }));
    const { items } = deadEndStore(grown, []);
    const act = activities(grown, items, [growthSeq - 0.5]);
    // Make goal 5 the most active.
    const more = [...grown, ...session("h", { failureDetail: "goal 5" })];
    const store = deadEndStore(more, []).items;
    const act2 = activities(more, store, [growthSeq - 0.5]);
    assert.ok((act2.get(store.find((i) => i.evidence === "goal 5")?.key as string)?.recalled ?? 0) >= 1);
    assert.deepEqual(toRetire(store, act2, 6), []);
    const retired = toRetire(store, act2, 2);
    assert.equal(retired.length, 2, "half of the four past the bound");
    const keys = new Set(retired.map((r) => r.key));
    assert.ok(!keys.has(store.find((i) => i.evidence === "goal 5")?.key as string), "the most active stays");
    assert.ok(act.size > 0);
    // A retired item is out of view but stays in the journal.
    const after = deadEndStore([...more, ev("campaign.dossier", { runId: "r", turn: 1, retired })], []);
    assert.equal(after.items.length, store.length - 2);
    assert.equal(after.retired.size, 2);
  });

  it("merges a reflection's items as deltas and drops a malformed one", () => {
    const kept = parseReflection('```json\n[{"approach":"strong induction on n","why":"the step needs the claim at n minus two"},{"approach":"ok"},{"approach":"call `simp`","why":"x"},"bad"]\n```');
    assert.equal(kept.kept.length, 1);
    assert.equal(kept.dropped, 3);
    assert.deepEqual(parseReflection("I think we should try harder"), { kept: [], dropped: 1 });
    assert.deepEqual(parseReflection('{"approach":"a","why":"b"}'), { kept: [], dropped: 1 });
    n = 0;
    const events = [...session("a1", {}), ev("campaign.dossier", { runId: "r", turn: 1, added: kept.kept }), ev("campaign.dossier", { runId: "r", turn: 2, added: kept.kept })];
    const { items } = deadEndStore(events, []);
    const reflected = items.filter((i) => i.source === "reflected");
    assert.equal(reflected.length, 1);
    assert.equal(reflected[0]?.count, 2);
    assert.equal(items.length, 2, "the attempt's own item is untouched");
    const store = new Map<string, DeadEnd>();
    mergeDelta(store, reflected[0] as DeadEnd);
    assert.equal(store.size, 1);
  });
});

describe("the dossier in a campaign", () => {
  it("is the briefing of a later session: the statement, the frontier and the dead end once", async () => {
    const seen: string[] = [];
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 0.12 }),
      responses: (turn) => (turn >= 2 ? [(c: TranscriptContext) => { seen.push(JSON.stringify(c.messages)); return check("bad"); }, ...failing()] : failing()),
    });
    assert.ok(run.turns.length >= 2);
    const first = seen[0] as string;
    assert.match(first, /Dossier of the campaign/);
    assert.match(first, /Statement \(signed\)/);
    assert.equal((first.match(/Dead ends and failed approaches/g) ?? []).length, 1);
  });
});
