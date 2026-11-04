import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, statementIdV0 } from "@seshat/core";
import { type Decide, type DecideRequest, type Decision, InterruptedError } from "@seshat/lines";
import { gateSettings } from "@seshat/scheduler";
import { BudgetGate, Ledger } from "../src/index.ts";

function open(): Journal {
  const journal = Journal.open(mkdtempSync(join(tmpdir(), "mh-gate-unit-")), "run_1");
  journal.emit("claim.created", { claimId: "clm_1", statementId: statementIdV0(": True"), statement: ": True", origin: "test", status: "open" }, "test");
  journal.emit("problem.registered", { problemId: "P1", claimId: "clm_1", target: "T", source: { repo: "r", rev: "x", path: "p", line: 1 }, domain: [] }, "orchestrator");
  return journal;
}

/** A decide that answers `answer` and keeps what it was asked. */
function scripted(answer: string | Error, backend: "llm" | "off" = "llm"): { decide: Decide; asked: DecideRequest[] } {
  const asked: DecideRequest[] = [];
  return {
    asked,
    decide: {
      backendFor: () => backend,
      async decide(request): Promise<Decision> {
        asked.push(request);
        if (answer instanceof Error) throw answer;
        return { answer, probabilities: { launch: answer === "launch" ? 1 : 0, skip: answer === "skip" ? 1 : 0 }, backend: "llm", requested: "llm", model: "m", costUsd: 0, decisionId: "dec_1", replayed: false };
      },
    },
  };
}

function gateWith(journal: Journal, decide?: Decide, log: string[] = []): BudgetGate {
  return new BudgetGate({
    settings: gateSettings({ floor: 0 }),
    journal,
    problemId: "P1",
    claimId: "clm_1",
    ledger: new Ledger(5).child(5),
    seed: "unit",
    rung: () => 0,
    attemptIds: () => [],
    ...(decide !== undefined ? { decide } : {}),
    log: (text) => log.push(text),
  });
}

describe("the budget gate where the rule has no numbers", () => {
  it("asks decide at budget.line for a tie, with the threshold in the state, and takes its answer", async () => {
    const journal = open();
    try {
      const { decide, asked } = scripted("skip");
      // The line gives its own chance of success, 0.1: the threshold is 0.25 x 5 x 0.1 = 0.125, and 0.13 is a tie.
      const answer = await gateWith(journal, decide).ask({ site: "task", estimateUsd: 0.13, pSuccess: 0.1, taskId: "tsk_1" });
      assert.equal(asked.length, 1);
      assert.equal(asked[0]?.site, "budget.line");
      assert.equal(asked[0]?.use, "order");
      assert.match(asked[0]?.state ?? "", /why estimate within the margin of the threshold\n.*\nestimate 0\.1300 dollars\nremaining 5\.0000 of 5\.0000 dollars\nthreshold 0\.1250 dollars/s);
      assert.equal(answer.action, "skip");
      assert.equal(answer.by, "decide");
      const [row] = journal.projection.gates({ problemId: "P1" });
      assert.deepEqual([row?.site, row?.action, row?.by, row?.data.decisionId, row?.data.taskId], ["task", "skip", "decide", "dec_1", "tsk_1"]);
    } finally {
      journal.close();
    }
  });

  it("asks nothing where the site is off, and keeps the rule's own answer", async () => {
    const journal = open();
    try {
      const { decide, asked } = scripted("launch", "off");
      const answer = await gateWith(journal, decide).ask({ site: "task", estimateUsd: 0.13, pSuccess: 0.1 });
      assert.deepEqual(asked, []);
      assert.deepEqual([answer.action, answer.by], ["skip", "rule"], "0.13 is over 0.125");
    } finally {
      journal.close();
    }
  });

  it("keeps the rule's answer when decide fails, and says so; an interruption passes through", async () => {
    const journal = open();
    try {
      const log: string[] = [];
      const answer = await gateWith(journal, scripted(new Error("no key")).decide, log).ask({ site: "task", estimateUsd: 0.12, pSuccess: 0.1 });
      assert.deepEqual([answer.action, answer.by], ["launch", "rule"]);
      assert.ok(log.some((line) => /budget\.line could not answer \(no key\); the rule's answer stands/.test(line)), log.join("\n"));
      await assert.rejects(gateWith(journal, scripted(new InterruptedError("the turn is over")).decide).ask({ site: "task", estimateUsd: 0.12, pSuccess: 0.1 }), /turn is over/);
    } finally {
      journal.close();
    }
  });

  it("has no decide in the rule-only arm: a cold start is the rule on the flat prior's draw", async () => {
    const journal = open();
    try {
      const answer = await gateWith(journal).ask({ site: "session", estimateUsd: 0.05 });
      assert.equal(answer.by, "rule");
      const [row] = journal.projection.gates();
      assert.match(row?.data.reason ?? "", /no posterior: the flat prior's draw/);
      assert.ok(row?.data.pSuccess !== undefined && row.data.pSuccess >= 0 && row.data.pSuccess <= 1);
    } finally {
      journal.close();
    }
  });

  it("refuses an estimate that is not a number of dollars", async () => {
    const journal = open();
    try {
      await assert.rejects(gateWith(journal).ask({ site: "judge", estimateUsd: -1 }), /non-negative number of dollars/);
      await assert.rejects(gateWith(journal).ask({ site: "judge", estimateUsd: Number.NaN }), /non-negative number of dollars/);
    } finally {
      journal.close();
    }
  });
});
