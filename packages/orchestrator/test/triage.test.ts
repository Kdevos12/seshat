import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, statementIdV0 } from "@seshat/core";
import { gateSettings } from "@seshat/scheduler";
import { armConfig } from "../src/ablation.ts";
import { BudgetGate, Ledger, LONG_STATEMENT_CHARS, MAX_PROOF_CHARS, recordTriage, SHORT_PROOF_CHARS, triageOfNodes, triageProblem, type TriageResult, TRIAGE_KIND } from "../src/index.ts";
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
