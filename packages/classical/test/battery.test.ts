import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, seeded } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import {
  availableTactics,
  BATTERY_RUN,
  closesWithCheapTactics,
  DEFAULT_SETTINGS,
  isUnknownTactic,
  orderByPosterior,
  Posteriors,
  probeHost,
  runBattery,
  type SolveContext,
  type SolveSettings,
  snippetFor,
  solveGoal,
  suggestion,
  TACTICS,
  tacticsFor,
} from "../src/index.ts";
import { ScriptedLean } from "./fake-lean.ts";

const GOAL = { header: "import Mathlib\nopen Nat", statement: "(n : ℕ) : n + 0 = n" };

function memory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-classical-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M10");
}

describe("snippets", () => {
  it("writes the example with the header and the tactic", () => {
    assert.equal(snippetFor(GOAL, "omega"), "import Mathlib\nopen Nat\n\nexample (n : ℕ) : n + 0 = n := by\n  omega\n");
    assert.equal(snippetFor({ header: "", statement: ": 1 = 1" }, "decide"), "example : 1 = 1 := by\n  decide\n");
  });

  it("lists only the tactics the host has", () => {
    const names = (have: string[]) => availableTactics({ have: new Set(have) }).map((t) => t.name);
    assert.ok(!names([]).includes("hammer") && !names([]).includes("canonical") && !names([]).includes("polyrith"));
    assert.ok(names(["hammer", "canonical", "polyrith"]).includes("hammer"));
    for (const core of ["decide", "norm_num", "simp", "omega", "linarith", "nlinarith", "positivity", "ring", "aesop", "grind", "exact?"]) assert.ok(names([]).includes(core), core);
  });

  it("reads Try this suggestions and parse errors", () => {
    const ok = { id: "x", status: "valid" as const, messages: [{ severity: "info" as const, pos: { line: 4, column: 2 }, text: "Try this: exact Nat.add_zero n" }], sorries: [], timeMs: 3 };
    assert.equal(suggestion(ok), "exact Nat.add_zero n");
    const bad = { id: "x", status: "lean_error" as const, messages: [{ severity: "error" as const, pos: { line: 4, column: 2 }, text: "<input>:4:2: unknown tactic" }], sorries: [], timeMs: 3 };
    assert.ok(isUnknownTactic(bad));
    assert.ok(!isUnknownTactic({ ...bad, messages: [{ severity: "error", pos: { line: 4, column: 2 }, text: "unsolved goals" }] }));
  });
});

describe("the posteriors", () => {
  it("are rebuilt from the battery_run nodes of the memory", () => {
    const m = memory();
    m.recordNode({
      kind: BATTERY_RUN,
      data: {
        statement: "s",
        domains: ["presburger"],
        cpuMs: 10,
        budgetSec: 60,
        tries: [
          { tactic: "omega", domain: "presburger", outcome: "success", timeMs: 5 },
          { tactic: "simp", domain: "presburger", outcome: "failed", timeMs: 5 },
          { tactic: "simp", domain: "presburger", outcome: "timeout", timeMs: 5 },
          { tactic: "grind", domain: "presburger", outcome: "aborted", timeMs: 1 },
          { tactic: "ring", domain: "presburger", outcome: "error", timeMs: 1 },
        ],
      },
    });
    const p = Posteriors.from(m);
    assert.deepEqual(p.counts("presburger", "omega"), { wins: 1, losses: 0 });
    assert.deepEqual(p.counts("presburger", "simp"), { wins: 0, losses: 2 });
    assert.deepEqual(p.counts("presburger", "grind"), { wins: 0, losses: 0 }, "an aborted try tells nothing");
    assert.deepEqual(p.counts("presburger", "ring"), { wins: 0, losses: 0 }, "a Lean that did not answer tells nothing");
    assert.deepEqual(p.beta("presburger", "omega"), { alpha: 4, beta: 1 }, "the router's prior plus the counts");
  });

  it("order the tactics: the router's prior first, then what the journal learned", () => {
    const tactics = availableTactics({ have: new Set() });
    const fresh = orderByPosterior(tactics, "presburger", new Posteriors(), { mode: "mean" }).map((t) => t.name);
    assert.equal(fresh[0], "omega");
    const p = new Posteriors();
    for (let i = 0; i < 6; i++) p.observe({ tactic: "omega", domain: "presburger", outcome: "failed", timeMs: 1 });
    for (let i = 0; i < 5; i++) p.observe({ tactic: "aesop", domain: "presburger", outcome: "success", timeMs: 1 });
    const learned = orderByPosterior(tactics, "presburger", p, { mode: "mean" }).map((t) => t.name);
    assert.equal(learned[0], "aesop");
    assert.ok(learned.indexOf("omega") > learned.indexOf("simp"), "omega, failing six times in a row, falls behind");
  });

  it("order by Thompson draws that replay from the seed", () => {
    const tactics = availableTactics({ have: new Set() });
    const a = orderByPosterior(tactics, "general", new Posteriors(), { random: seeded(7) }).map((t) => t.name);
    const b = orderByPosterior(tactics, "general", new Posteriors(), { random: seeded(7) }).map((t) => t.name);
    const c = orderByPosterior(tactics, "general", new Posteriors(), { random: seeded(8) }).map((t) => t.name);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
});

describe("the battery", () => {
  const base = { goal: GOAL, domain: "presburger", posteriors: new Posteriors(), order: { mode: "mean" as const } };

  it("stops at the first success and aborts the others", async () => {
    const lean = new ScriptedLean({ omega: { ok: true, delayMs: 5 }, simp: { delayMs: 2000 }, norm_num: { delayMs: 2000 }, decide: { delayMs: 2000 } });
    const started = Date.now();
    const result = await runBattery({ ...base, checker: lean, tactics: tacticsFor({ have: new Set() }, { hammerCutoffs: [] }), cpuBudgetSec: 60, parallel: 4 });
    assert.equal(result.winner?.tactic, "omega");
    assert.ok(Date.now() - started < 1500, "the slow tries were cut short");
    assert.ok(result.tries.some((t) => t.outcome === "aborted"));
    assert.ok(result.skipped.length > 0, "tactics behind the winner were never started");
    assert.ok(lean.calls.length < availableTactics({ have: new Set() }).length, "the tactics behind the winner never reached Lean");
  });

  it("runs at most `parallel` checks at once, in the posterior order", async () => {
    const lean = new ScriptedLean({ grind: { ok: true, delayMs: 30 } });
    const result = await runBattery({ ...base, checker: lean, tactics: availableTactics({ have: new Set() }), cpuBudgetSec: 600, parallel: 2 });
    assert.equal(result.winner?.tactic, "grind");
    assert.ok(lean.maxInflight <= 2);
    const order = lean.calls.map((c) => c.tactic);
    assert.deepEqual(order.slice(0, 2), ["omega", "simp"], "the first two of the router's list for presburger start first");
  });

  it("submits the suggestion Lean printed, not the search tactic", async () => {
    const lean = new ScriptedLean({ "exact?": { ok: true, suggests: "exact Nat.add_zero n" } });
    const result = await runBattery({ ...base, checker: lean, tactics: availableTactics({ have: new Set() }), cpuBudgetSec: 60 });
    assert.deepEqual(result.winner, { tactic: "exact?", proof: "exact Nat.add_zero n" });
  });

  it("keeps to the CPU budget", async () => {
    const lean = new ScriptedLean(Object.fromEntries(TACTICS.map((t) => [t.script, { delayMs: 5, timeMs: 4000 }])));
    const result = await runBattery({ ...base, checker: lean, tactics: availableTactics({ have: new Set() }), cpuBudgetSec: 10, parallel: 1 });
    assert.equal(result.winner, undefined);
    assert.ok(result.budgetExhausted);
    assert.ok(result.cpuMs <= 12000 && result.tries.length <= 3, `${result.tries.length} tries, ${result.cpuMs} ms`);
    assert.ok(result.skipped.length > 0);
  });

  it("stops when the caller's signal aborts", async () => {
    const lean = new ScriptedLean(Object.fromEntries(TACTICS.map((t) => [t.script, { delayMs: 3000 }])));
    const stop = new AbortController();
    const running = runBattery({ ...base, checker: lean, tactics: availableTactics({ have: new Set() }), cpuBudgetSec: 600, signal: stop.signal });
    setTimeout(() => stop.abort(), 30);
    const result = await running;
    assert.equal(result.winner, undefined);
    assert.ok(result.tries.every((t) => t.outcome === "aborted"));
  });
});

describe("the host probe", () => {
  it("reads which optional tactics the host's Lean has", async () => {
    const lean = new ScriptedLean({ hammer: { unknown: true }, canonical: { ok: true }, polyrith: { unknown: true }, bv_decide: { ok: true } });
    const probe = await probeHost(lean, {});
    assert.deepEqual([...probe.have].sort(), ["bv_decide", "canonical"]);
    assert.deepEqual(probe.missing.sort(), ["hammer", "polyrith"]);
    assert.equal(probe.unreachable, undefined);
  });

  it("takes the packages the host profile names as present without asking", async () => {
    const lean = new ScriptedLean({ hammer: { unknown: true } });
    const probe = await probeHost(lean, { known: ["hammer"] });
    assert.ok(probe.have.has("hammer"));
    assert.ok(!lean.calls.some((c) => c.tactic.startsWith("hammer")));
  });
});

describe("the non-triviality test", () => {
  it("is true when a cheap tactic closes the goal, with no line on", async () => {
    const lean = new ScriptedLean({ omega: { ok: true } });
    const r = await closesWithCheapTactics(lean, GOAL);
    assert.deepEqual([r.trivial, r.tactic], [true, "omega"]);
  });

  it("does not try the expensive tactics", async () => {
    const lean = new ScriptedLean({ aesop: { ok: true }, grind: { ok: true }, hammer: { ok: true } });
    const r = await closesWithCheapTactics(lean, GOAL, { host: { have: new Set(["hammer"]) } });
    assert.equal(r.trivial, false);
    const tried = new Set(lean.calls.map((c) => c.tactic));
    for (const t of ["aesop", "grind", "hammer", "nlinarith", "exact?"]) assert.ok(!tried.has(t), t);
  });
});

describe("solving a claim", () => {
  async function context(lean: ScriptedLean, validate: (r: ValidateRequest) => ValidateResult, settings: Partial<SolveSettings> = {}): Promise<SolveContext & { requests: ValidateRequest[]; claimId: string }> {
    const requests: ValidateRequest[] = [];
    const store = memory();
    const { claimId } = await store.ensureClaim({ statement: GOAL.statement, header: GOAL.header, origin: "test" });
    return {
      requests,
      claimId,
      checker: lean,
      memory: store,
      validate: async (r) => {
        requests.push(r);
        return validate(r);
      },
      host: { have: new Set() },
      settings: { ...DEFAULT_SETTINGS, order: "mean", ...settings },
      random: seeded(1),
      signal: new AbortController().signal,
      log: () => {},
    };
  }
  const valid: ValidateResult = { verdict: "valid", status: "computed", reasons: [], validationId: "val_1" };

  it("submits the winning tactic through validate and records the run", async () => {
    const lean = new ScriptedLean({ omega: { ok: true } });
    const ctx = await context(lean, () => valid);
    const out = await solveGoal(ctx, { ...GOAL, claimId: ctx.claimId });
    assert.ok(out.settled);
    assert.deepEqual(ctx.requests, [{ claimId: ctx.claimId, proof: "omega" }]);
    const node = ctx.memory.nodes(BATTERY_RUN, { claimId: ctx.claimId })[0];
    assert.ok(node);
    const data = node.data as { solved?: { tactic: string }; submission?: { validationId?: string }; domains: string[] };
    assert.equal(data.solved?.tactic, "omega");
    assert.equal(data.submission?.validationId, "val_1");
    assert.equal(data.domains[0], "presburger");
  });

  it("goes on with another tactic when validate refuses a proof", async () => {
    const lean = new ScriptedLean({ omega: { ok: true }, simp: { ok: true, delayMs: 10 } });
    const ctx = await context(lean, (r) => (r.proof === "omega" ? { verdict: "invalid", status: "open", reasons: ["statement changed"] } : valid), { parallel: 1 });
    const out = await solveGoal(ctx, { ...GOAL, claimId: ctx.claimId });
    assert.ok(out.settled);
    assert.deepEqual(ctx.requests.map((r) => r.proof), ["omega", "simp"]);
    assert.equal(out.winner?.tactic, "simp");
  });

  it("gives the goal up after the allowed refusals, and settles nothing", async () => {
    const lean = new ScriptedLean({ omega: { ok: true }, simp: { ok: true }, norm_num: { ok: true } });
    const ctx = await context(lean, () => ({ verdict: "invalid", status: "open", reasons: ["no"] }), { parallel: 1, maxSubmissions: 2 });
    const out = await solveGoal(ctx, { ...GOAL, claimId: ctx.claimId });
    assert.equal(out.settled, false);
    assert.equal(ctx.requests.length, 3);
  });

  it("records a failed run too, so that the next run learns from it", async () => {
    const lean = new ScriptedLean({});
    const ctx = await context(lean, () => valid);
    const out = await solveGoal(ctx, { ...GOAL, claimId: ctx.claimId });
    assert.equal(out.settled, false);
    assert.deepEqual(ctx.requests, []);
    const p = Posteriors.from(ctx.memory);
    assert.ok(p.counts("presburger", "omega").losses === 1);
  });

  it("tries the hammer at each cutoff when the host has it", () => {
    const names = tacticsFor({ have: new Set(["hammer"]) }, { hammerCutoffs: [16, 64] }).map((t) => t.name);
    assert.deepEqual(names.filter((n) => n.startsWith("hammer")), ["hammer", "hammer@16", "hammer@64"]);
  });
});
