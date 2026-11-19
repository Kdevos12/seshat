import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, newId, statementIdV0 } from "@seshat/core";
import type { GrowthPoint } from "@seshat/memory";
import { gateSettings } from "@seshat/scheduler";
import { armConfig } from "../src/ablation.ts";
import { BudgetGate, DEFAULT_LONG_TRIAGE_USD, Ledger, LONG_STATEMENT_CHARS, longProofConfigProblems, MAX_PROOF_CHARS, recordTriage, SHORT_PROOF_CHARS, triageOfNodes, triageProblem, type TriageResult, TRIAGE_KIND } from "../src/index.ts";
import { experimentArms } from "../src/experiments.ts";
import { DEFAULT_CONFIG } from "../src/run.ts";
import { DEFAULTS_SETS } from "../src/student.ts";

const proof = (chars: number) => "1. Take n.\n".padEnd(chars, "x");
const accepted = (text: string, facts: string[] = [], hits: string[] = []) => ({ accepted: true, text, facts, hits });

describe("triageProblem (PA14)", () => {
  it("invests in a short accepted proof whose facts are all found", () => {
    const r = triageProblem({ informal: accepted(proof(1500), ["Nat.add_comm", "Nat.mul_comm"], ["Nat.add_comm", "Nat.mul_comm"]), plausible: "no_counterexample", statementChars: 80, budgetUsd: 0.2 });
    assert.equal(r.class, "invest");
  });

  it("makes a short try of a middle-sized proof, a missing fact, a long statement or a probable counterexample", () => {
    assert.equal(triageProblem({ informal: accepted(proof(SHORT_PROOF_CHARS + 10)) }).class, "short");
    assert.equal(triageProblem({ informal: accepted(proof(500), ["a", "b", "c"], ["x", "y"]) }).class, "short");
    assert.equal(triageProblem({ informal: accepted(proof(500)), statementChars: LONG_STATEMENT_CHARS + 1 }).class, "short");
    assert.equal(triageProblem({ informal: accepted(proof(500)), plausible: "counterexample" }).class, "short");
    assert.equal(triageProblem({ informal: accepted(proof(500)), firstCases: { rows: 8, differs: true } }).class, "short");
  });

  it("skips when the proof is missing, long or mostly unfound, and the budget is small; else a short try", () => {
    const cases = [
      { informal: undefined },
      { informal: { accepted: false, text: proof(500), facts: [], hits: [] } },
      { informal: accepted(proof(MAX_PROOF_CHARS + 1)) },
      { informal: accepted(proof(500), ["a", "b", "c"], ["x"]) },
      { informal: accepted(Array.from({ length: 13 }, (_, i) => `${i + 1}. step`).join("\n")) },
    ];
    for (const c of cases) {
      assert.equal(triageProblem({ ...c, budgetUsd: 0.5 }).class, "skip", JSON.stringify(c).slice(0, 60));
      assert.equal(triageProblem({ ...c, budgetUsd: 5 }).class, "short");
      assert.equal(triageProblem(c).class, "short", "an unknown budget is not small");
    }
  });

  it("does not judge facts that no search looked up, and says why for every class", () => {
    const r = triageProblem({ informal: accepted(proof(500), ["a"]), searched: false });
    assert.equal(r.class, "short");
    assert.ok(r.reasons.length > 0);
    assert.ok(triageProblem({ informal: undefined, budgetUsd: 0.1 }).reasons.some((x) => /no informal proof/.test(x)));
  });

  it("long: only under longProof, for an accepted proof over the short limits whose facts are found, with room in the allowance", () => {
    const longProof = { longUsd: DEFAULT_LONG_TRIAGE_USD };
    const tooLong = accepted(proof(MAX_PROOF_CHARS + 1), ["a", "b"], ["a", "b"]);
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 5, ...longProof }).class, "long");
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 1, ...longProof }).class, "long", "the allowance may be the setting itself");
    assert.equal(triageProblem({ informal: accepted(Array.from({ length: 13 }, (_, i) => `${i + 1}. step`).join("\n")), ...longProof }).class, "long", "many steps, an unknown allowance");
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 5 }).class, "short", "without longProof nothing changes");
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 0.5 }).class, "skip");
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 0.5, ...longProof }).class, "skip", "under the setting: as before");
    assert.equal(triageProblem({ informal: tooLong, budgetUsd: 5, longUsd: 8 }).class, "short");
    // Not long: half the facts are missing, no lookup, an unaccepted proof.
    assert.equal(triageProblem({ informal: accepted(proof(MAX_PROOF_CHARS + 1), ["a", "b", "c"], ["x"]), budgetUsd: 5, ...longProof }).class, "short");
    assert.equal(triageProblem({ informal: accepted(proof(MAX_PROOF_CHARS + 1), ["a"], []), searched: false, budgetUsd: 5, ...longProof }).class, "short");
    assert.equal(triageProblem({ informal: { accepted: false, text: proof(MAX_PROOF_CHARS + 1), facts: [], hits: [] }, budgetUsd: 5, ...longProof }).class, "short");
    // A proof within the short limits is not long: the class only rescues what `skip` would have taken.
    assert.equal(triageProblem({ informal: accepted(proof(1500)), budgetUsd: 5, ...longProof }).class, "invest");
  });

  it("checks the longProof setting", () => {
    assert.deepEqual(longProofConfigProblems(undefined, false), []);
    assert.deepEqual(longProofConfigProblems({}, true), []);
    assert.equal(longProofConfigProblems({}, false).length, 1, "it goes with triage");
    assert.equal(longProofConfigProblems({ triageUsd: 0, dryChecks: 0, other: 1 }, true).length, 3);
  });

  it("is journaled as a node and read back", () => {
    const journal = open();
    try {
      recordTriage(journal, { claimId: "clm_1", problemId: "P1", result: { class: "skip", reasons: ["r"] } });
      assert.deepEqual(triageOfNodes(journal.projection.nodes(TRIAGE_KIND, "clm_1")), { class: "skip", reasons: ["r"] });
    } finally {
      journal.close();
    }
  });
});

function open(): Journal {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-triage-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
  journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
  return journal;
}

describe("the budget gate reads the triage", () => {
  function gate(journal: Journal, triage: TriageResult | undefined, floor = 0): BudgetGate {
    return new BudgetGate({
      settings: gateSettings({ floor }),
      journal,
      problemId: "P1",
      claimId: "clm_1",
      ledger: new Ledger(5).child(5),
      seed: "unit",
      rung: () => 0,
      attemptIds: () => [],
      informalAccepted: () => true,
      ...(triage !== undefined ? { triage: () => triage } : {}),
      log: () => {},
    });
  }

  it("skip: the probe alone, with neither the informal credit nor the floor", async () => {
    const journal = open();
    try {
      const g = gate(journal, { class: "skip", reasons: ["no informal proof was accepted"] }, 1);
      g.probe();
      const answer = await g.widen(2);
      assert.deepEqual([answer.action, answer.by], ["skip", "progress"]);
      assert.match(answer.reason, /formal-cost triage says skip \(no informal proof was accepted\)/);
      assert.equal(g.shortCap(), undefined);
    } finally {
      journal.close();
    }
  });

  it("short: widens as the rule says, under a cap of three probes", async () => {
    const journal = open();
    try {
      const g = gate(journal, { class: "short", reasons: ["r"] });
      g.probe();
      assert.equal((await g.widen(2)).action, "widen");
      assert.ok(Math.abs((g.shortCap() as number) - 1.5) < 1e-9, "3 x a probe of 0.5");
    } finally {
      journal.close();
    }
  });

  it("invest and no triage: nothing changes", async () => {
    for (const triage of [{ class: "invest" as const, reasons: ["r"] }, undefined]) {
      const journal = open();
      try {
        const g = gate(journal, triage);
        g.probe();
        const answer = await g.widen(2);
        assert.equal(answer.action, "widen");
        assert.match(answer.reason, /an informal proof was accepted/);
        assert.equal(g.shortCap(), undefined);
      } finally {
        journal.close();
      }
    }
  });
});

describe("the budget gate follows the frontier for a long problem (LP4)", () => {
  /** A problem triaged `long` with a ledger of $5; `growth` is what `frontierGrowth` would say, rebuilt from the closes the test made. */
  function setup(triage: TriageResult | "none" = { class: "long", reasons: ["r"] }) {
    const journal = open();
    const attempts: string[] = [];
    const growth: GrowthPoint[] = [{ usd: 0, score: 0, seq: 0 }];
    const gate = new BudgetGate({
      settings: gateSettings({ floor: 0 }),
      journal,
      problemId: "P1",
      claimId: "clm_1",
      ledger: new Ledger(5).child(5),
      seed: "unit",
      rung: () => 0,
      attemptIds: () => attempts,
      ...(triage !== "none" ? { triage: () => triage } : {}),
      longProof: { dryChecks: 3, growth: () => growth },
      log: () => {},
    });
    /** A finished session that closed a hole (the frontier grew while it ran), or not. */
    const session = (closes: boolean) => {
      const attemptId = newId("att");
      journal.emit("attempt.started", { attemptId, claimId: "clm_1", prover: "p1", iteration: attempts.length + 1, model: "m" }, "prover:p1");
      attempts.push(attemptId);
      if (closes) {
        const seq = journal.emit("attempt.charged", { attemptId, usd: 0, inputTokens: 0, outputTokens: 0 } as never, "prover:p1").seq;
        growth.push({ usd: 0, score: (growth.at(-1) as GrowthPoint).score + 3, seq });
      }
      journal.emit("attempt.finished", { attemptId, outcome: "invalid", usd: 0.01, inputTokens: 0, outputTokens: 0, durationMs: 1, turns: 1 }, "prover:p1");
    };
    return { journal, gate, session };
  }

  it("goes on while holes close, one per session, as far as the allowance lets it", async () => {
    const { journal, gate, session } = setup();
    try {
      for (let n = 1; n <= 12; n++) {
        session(true);
        const answer = await gate.session({ prover: "p1", session: n });
        assert.deepEqual([answer.action, answer.by, answer.verdict.progress], ["launch", "progress", true], `session ${n}`);
      }
    } finally {
      journal.close();
    }
  });

  it("stops, and says why, after K finished sessions in a row that closed no hole", async () => {
    const run = setup();
    try {
      run.session(true);
      run.session(false);
      run.session(false);
      assert.equal((await run.gate.session({ prover: "p1", session: 4 })).action, "launch", "two dry sessions are under the limit of three");
      run.session(false);
      const stop = await run.gate.session({ prover: "p1", session: 5 });
      assert.deepEqual([stop.action, stop.by, stop.verdict.progress], ["skip", "progress", false]);
      assert.match(stop.reason, /last 3 finished session\(s\) closed no hole/);
      const rows = run.journal.projection.gates({ problemId: "P1" }).map((g) => `${g.data.site}:${g.data.action}:${g.data.by}`);
      assert.deepEqual(rows, ["session:launch:progress", "session:skip:progress"], "journaled like any gate stop");
    } finally {
      run.journal.close();
    }
  });

  it("starts the count again when a hole closes", async () => {
    const { journal, gate, session } = setup();
    try {
      session(false);
      session(false);
      session(true);
      session(false);
      session(false);
      assert.equal((await gate.session({ prover: "p1", session: 6 })).action, "launch");
      session(false);
      assert.equal((await gate.session({ prover: "p1", session: 7 })).action, "skip");
    } finally {
      journal.close();
    }
  });

  it("leaves a problem that is not long to the rule, as before", async () => {
    for (const triage of [{ class: "short" as const, reasons: ["r"] }, { class: "invest" as const, reasons: ["r"] }, "none" as const]) {
      const { journal, gate, session } = setup(triage);
      try {
        for (let n = 0; n < 4; n++) session(false);
        const answer = await gate.session({ prover: "p1", session: 5 });
        assert.notEqual(answer.by, "progress");
      } finally {
        journal.close();
      }
    }
  });
});

describe("the arm solve-v2-informal-triage", () => {
  const arms = experimentArms("solve-defaults", { host: { capabilities: {} } });
  const base = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", budget: { problemUsd: 1, runUsd: 1 } } as never;
  it("is solve-v2-informal plus triage, and v1 and v2 are unchanged", () => {
    const arm = arms.find((a) => a.name === "solve-v2-informal-triage");
    const informal = arms.find((a) => a.name === "solve-v2-informal");
    assert.equal(arm?.versus, "solve-v2-informal");
    const { triage, ...rest } = armConfig(base, arm as never) as { triage?: boolean };
    assert.equal(triage, true);
    assert.deepEqual(rest, armConfig(base, informal as never));
    for (const set of [DEFAULTS_SETS.v1, DEFAULTS_SETS.v2]) assert.equal((set as { triage?: unknown }).triage, undefined);
  });
});

describe("the triage in a run", () => {
  it("is journaled once per problem when asked for, and not otherwise", async () => {
    const { check, demoRun, ofType } = await import("./m0-helpers.ts");
    const on = await demoRun({ responses: [check("exact trivial_proof")], config: { triage: true } });
    const nodes = ofType(on.events, "node.recorded").filter((e) => e.data.kind === TRIAGE_KIND);
    assert.equal(nodes.length, 1);
    assert.equal((nodes[0]?.data.data as { class: string }).class === "invest", false, "no informal proof was written");
    const off = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal(ofType(off.events, "node.recorded").filter((e) => e.data.kind === TRIAGE_KIND).length, 0);
  });
});
