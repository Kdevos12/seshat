import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@seshat/core";
import { ofType } from "./m0-helpers.ts";
import { campaignConfig, failing, simulatedCampaign } from "./campaign-helpers.ts";
import { applies, currentMode, decidePlateau, frontierTerms, modeOfTurn, PLATEAU_MODES, type PlateauContext, reformulations, spiralOf, stepsSinceGrowth, type TurnScore } from "../src/index.ts";

let n = 0;
const ev = (type: string, data: Record<string, unknown>): HarnessEvent => ({ v: 1, seq: n++, id: `e${n}`, ts: "2026-11-17T00:00:00Z", run: "r", actor: "orchestrator", type, data }) as unknown as HarnessEvent;
const ended = (turn: number): HarnessEvent => ev("turn.ended", { runId: "r", turn });
const full: PlateauContext = { statement: "(n : ℕ) : ∃ m, m ≤ n + 2 ∧ 3 ∣ m * 6", lines: ["M18", "M11", "M16"], private: false, literature: true };

/** Plays a campaign whose frontier never grows: after each turn the rule decides, and the decision is journaled as the supervisor does. */
function flat(ctx: PlateauContext, turns: number, window = 0.5, grow: readonly number[] = []): { events: HarnessEvent[]; stoppedAt: number | undefined; changes: Array<{ turn: number; mode: string; reason: string; skipped: Array<{ mode: string; why: string }>; step: number }> } {
  n = 0;
  const events: HarnessEvent[] = [];
  const scores: TurnScore[] = [];
  const changes: ReturnType<typeof flat>["changes"] = [];
  let stoppedAt: number | undefined;
  for (let t = 1; t <= turns; t++) {
    events.push(ev("turn.started", { runId: "r", turn: t }));
    events.push(ended(t));
    scores.push({ turn: t, score: 1 + grow.filter((g) => g <= t).length, usd: 0.3 });
    if (spiralOf(events, scores) !== undefined) {
      stoppedAt = t;
      break;
    }
    const change = decidePlateau({ events, scores, plateauUsd: window, ctx });
    if (change === undefined) continue;
    const data = { runId: "r", turn: t, mode: change.mode, reason: change.reason, ...(change.skipped.length > 0 ? { skipped: change.skipped } : {}), step: change.step };
    events.push(ev("campaign.mode_changed", data));
    changes.push({ turn: t, mode: change.mode, reason: change.reason, skipped: change.skipped, step: change.step });
  }
  return { events, changes, stoppedAt };
}

describe("plateau modes", () => {
  it("walks the five modes in order on a flat frontier, each change with its reason, and starts again after the fifth", () => {
    const { changes } = flat({ ...full, statement: "(n : ℕ) : ∃ m, m ≤ n + 2 ∧ 3 ∣ m * 6" }, 8);
    assert.deepEqual(changes.slice(0, 6).map((c) => c.mode), [...PLATEAU_MODES, "specialise"]);
    assert.match(changes[0]?.reason as string, /has not grown over \$0\.6000 of spend/);
    assert.match(changes[1]?.reason as string, /specialise added nothing to the frontier in turn 4/);
    assert.deepEqual(changes.map((c) => c.step).slice(0, 6), [1, 2, 3, 4, 5, 6]);
  });

  it("waits for the window of spend before the first change", () => {
    const { changes } = flat(full, 5, 1.0);
    assert.equal(changes[0]?.turn, 5, "the frontier grew in turn 1, then $0.3 a turn: the window of $1 passes after turn 5");
  });

  it("keeps the mode while the frontier grows, and moves on when a turn in it adds nothing", () => {
    n = 0;
    const events = [ev("turn.started", { turn: 1 }), ended(1), ev("campaign.mode_changed", { runId: "r", turn: 1, mode: "test", reason: "x", step: 1 }), ev("turn.started", { turn: 2 }), ended(2)];
    assert.equal(currentMode(events), "test");
    assert.equal(modeOfTurn(events, 2), "test");
    assert.equal(modeOfTurn(events, 1), undefined);
    const grown: TurnScore[] = [{ turn: 1, score: 1, usd: 0.3 }, { turn: 2, score: 4, usd: 0.3 }];
    assert.equal(decidePlateau({ events, scores: grown, plateauUsd: 0.1, ctx: full }), undefined, "growth keeps the run on the mode");
    const flatScores: TurnScore[] = [{ turn: 1, score: 1, usd: 0.3 }, { turn: 2, score: 1, usd: 0.3 }];
    assert.equal(decidePlateau({ events, scores: flatScores, plateauUsd: 0.1, ctx: full })?.mode, "construct");
    assert.equal(stepsSinceGrowth(events, grown), 0, "growth starts the count again");
  });

  it("skips a mode that does not apply, and says why", () => {
    const ctx: PlateauContext = { statement: "(n : ℕ) : n + 0 = n", lines: [], private: true, literature: false };
    assert.equal(applies("specialise", ctx).ok, false);
    assert.match((applies("construct", ctx) as { why: string }).why, /M16 is not enabled/);
    assert.match((applies("read", ctx) as { why: string }).why, /private/);
    assert.match((applies("read", { ...ctx, private: false }) as { why: string }).why, /did not agree/);
    assert.equal(applies("test", ctx).ok, true);
    assert.equal(applies("reformulate", ctx).ok, false, "no numeral of 2 or more");
    assert.equal(applies("construct", { ...ctx, lines: ["M16"] }).ok, false, "M16 is on but the statement is neither an existence nor a bound");
    assert.equal(applies("construct", { ...ctx, lines: ["M16"], statement: ": ∃ k, k * k = 49" }).ok, true);
    n = 0;
    const events = [ev("turn.started", { turn: 1 }), ended(1)];
    const change = decidePlateau({ events, scores: [{ turn: 1, score: 0, usd: 1 }], plateauUsd: 0.5, ctx });
    assert.equal(change?.mode, "test");
    assert.deepEqual(change?.skipped.map((s) => s.mode), ["specialise"]);
    const after = decidePlateau({ events: [...events, ev("campaign.mode_changed", { turn: 1, mode: "test", reason: "", step: 2 })], scores: [{ turn: 1, score: 0, usd: 1 }, { turn: 2, score: 0, usd: 1 }], plateauUsd: 0.5, ctx });
    assert.equal(after?.mode, "test", "construct, read and reformulate do not apply: the cycle comes back to test");
    assert.deepEqual(after?.skipped.map((s) => s.mode), ["construct", "read", "reformulate", "specialise"]);
  });

  it("never changes what a mode may not: a reformulation is a Lean statement, a generalization of a numeral", () => {
    assert.deepEqual(reformulations("(n : ℕ) : n * 2 = n + n"), ["(n : ℕ) (m : ℕ) : n * m = n + n"]);
    assert.deepEqual(reformulations(": 7 * 3 = 21"), ["(m : ℕ) : 7 * 3 = m", "(m : ℕ) : m * 3 = 21", "(m : ℕ) : 7 * m = 21"]);
    assert.deepEqual(reformulations(": 1 + 1 = 2").length, 1);
    assert.deepEqual(reformulations("not a statement"), []);
    assert.deepEqual(frontierTerms([{ kind: "subclaim", statement: "aux_lemma", evidence: false }, { kind: "evidence", statement: "plausible", evidence: true }, { kind: "case", statement: "aux_lemma", evidence: false }]), ["aux_lemma"]);
  });
});

describe("plateau modes in a campaign", () => {
  it("changes mode on a flat frontier with the reason journaled, never touches the signed statement or a status, and ends in a spiral after two cycles", async () => {
    const run = await simulatedCampaign({
      config: campaignConfig({ turnUsd: 0.03, allowance: 20, over: { campaign: { spiralTurns: 1000, plateauUsd: 0.05 } } }),
      responses: () => failing(80),
    });
    assert.equal(run.end.reason, "spiral");
    assert.match(run.end.detail, /two full cycles/);
    const changes = ofType(run.events, "campaign.mode_changed").filter((e) => e.data.mode !== "cold_restart");
    assert.ok(changes.length >= 2, `modes changed ${changes.length} times`);
    for (const c of changes) assert.match(c.data.reason, /frontier|added nothing/);
    assert.ok(changes.every((c) => PLATEAU_MODES.includes(c.data.mode as never)));
    assert.ok(changes.some((c) => (c.data.skipped ?? []).length > 0), "a mode that did not apply was skipped with its reason");
    const last = changes.at(-1);
    assert.ok((last?.data.step ?? 0) >= 10 - 5, "the steps count the skipped modes");
    // No mode moved the claim: the statement and the status are the run's.
    assert.equal(ofType(run.events, "claim.status_changed").length, 0);
    assert.equal(ofType(run.events, "statement.signed").length <= 1, true);
    const stopped = ofType(run.events, "campaign.stopped");
    assert.equal(stopped.at(-1)?.data.reason, "spiral");
    const digest = readFileSync(join(run.dir, "campaign", "digest.md"), "utf8");
    assert.match(digest, /stopped \(spiral\)/);
    assert.match(digest, /Out of reach at this budget; here is what is established/);
    assert.match(digest, /## Frontier/);
    assert.match(readFileSync(join(run.dir, "RESULT.md"), "utf8"), /Out of reach at this budget; here is what is established/);
    // The signed statement and the claim are the run's own: no mode rewrote them.
    const claims = ofType(run.events, "claim.created");
    assert.equal(claims.filter((c) => c.data.origin === "campaign.reformulate" && c.data.status !== "open").length, 0);
    const target = claims[0]?.data;
    assert.ok(claims.filter((c) => c.data.origin === "campaign.reformulate").every((c) => c.data.statement !== target?.statement && c.data.claimId !== target?.claimId));
    assert.equal(ofType(run.events, "statement.signed").length, 0, "no mode signs or re-signs a statement");
  });

  it("does not stop when the frontier grows in the second cycle", () => {
    const ctx = full;
    const flatRun = flat(ctx, 40, 0.5);
    assert.ok(flatRun.stoppedAt !== undefined, "two flat cycles stop the campaign");
    const stop = flatRun.stoppedAt as number;
    // Growth in the second cycle, two turns before the guard would have fired: the count starts again and the campaign goes on.
    const grown = flat(ctx, stop + 3, 0.5, [stop - 2]);
    assert.equal(grown.stoppedAt, undefined);
    assert.ok(grown.changes.length >= flatRun.changes.length - 1);
  });
});
