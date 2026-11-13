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
function scripted(answer: string | Error, backend: "llm" | "off" = "llm", journal?: Journal): { decide: Decide; asked: DecideRequest[] } {
  const asked: DecideRequest[] = [];
  return {
    asked,
    decide: {
      backendFor: () => backend,
      async decide(request): Promise<Decision> {
        asked.push(request);
        if (answer instanceof Error) throw answer;
        // What `decide` does before it answers: the decision is in the journal.
        journal?.emit(
          "decision.made",
          { decisionId: "dec_1", key: `k${asked.length}`, line: "gate", problemId: "P1", claimId: "clm_1", site: request.site, backend: "llm", requested: "llm", model: "m", type: "choice", labels: ["launch", "skip"], requestHash: "r", stateHash: "s", answer, probabilities: { launch: answer === "launch" ? 1 : 0, skip: answer === "skip" ? 1 : 0 }, costUsd: 0, modelCallIds: [] },
          "orchestrator",
        );
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
      const { decide, asked } = scripted("skip", "llm", journal);
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

describe("the gate's configuration", () => {
  it("is checked before a run starts", async () => {
    const { checkConfig, DEFAULT_CONFIG } = await import("../src/index.ts");
    const config = { ...DEFAULT_CONFIG, selection: {}, model: "p/m" };
    assert.deepEqual(checkConfig({ ...config, gate: {} }), []);
    assert.match(checkConfig({ ...config, gate: { floor: 2 } }).join(), /gate: floor must be from 0 to 1/);
  });
});

/** A gate that sees a turn counter and a rung, to look at its stages. */
function gateOf(journal: Journal, turn: { n: number | undefined }, settings = gateSettings({ floor: 0 }), rung = { n: 0 }): BudgetGate {
  return new BudgetGate({
    settings,
    journal,
    problemId: "P1",
    claimId: "clm_1",
    ledger: new Ledger(5).child(5),
    seed: "unit",
    rung: () => rung.n,
    turn: () => turn.n,
    attemptIds: () => [],
    log: () => {},
  });
}

describe("a problem the gate stopped", () => {
  it("is stopped for the turn it was stopped in, and looked at again in a later turn, at a higher rung, or with a new budget", async () => {
    const journal = open();
    try {
      const turn = { n: 1 as number | undefined };
      const rung = { n: 0 };
      const gate = gateOf(journal, turn, undefined, rung);
      assert.equal(gate.stage, "start");
      gate.probe();
      assert.equal(gate.stage, "probing");
      const stopped = await gate.widen(2);
      assert.deepEqual([stopped.action, stopped.by], ["skip", "progress"]);
      assert.equal(journal.projection.gates()[1]?.data.turn, 1);
      assert.equal(gate.stage, "stopped", "within the turn, the stop stands: a resume of the same turn does not ask again");
      turn.n = 2;
      assert.equal(gate.stage, "probing", "the next turn, after the team's answer, asks again");
      turn.n = 1;
      rung.n = 1;
      assert.equal(gate.stage, "probing", "a ladder escalation changes what the problem can do");
      rung.n = 0;
      assert.equal(gate.stage, "stopped");
      // A run with no turns keeps a stop for good.
      const plain = gateOf(journal, { n: undefined });
      assert.equal(plain.stage, "probing", "rows written under a turn are another situation from one with no turn");
    } finally {
      journal.close();
    }
  });

  it("takes a second look with the draws of a new round: the floor has another chance", async () => {
    const journal = open();
    try {
      const turn = { n: 1 as number | undefined };
      const gate = gateOf(journal, turn, gateSettings({ floor: 1 }));
      gate.probe();
      // A floor of 1 lets everything through, even with no progress: the first look already widens.
      const first = await gate.widen(2);
      assert.deepEqual([first.action, first.by], ["widen", "floor"]);
      const row = journal.projection.gates()[1]?.data;
      assert.deepEqual([row?.floorFraction, typeof row?.floorDraw], [1, "number"], "the floor's draw and fraction are journaled");
    } finally {
      journal.close();
    }
  });
});

describe("the gate's draws", () => {
  async function pSuccessBySession(order: string[]): Promise<Record<string, number | undefined>> {
    const journal = open();
    try {
      const gate = gateOf(journal, { n: undefined }, gateSettings({ floor: 0 }));
      for (const prover of order) await gate.session({ prover, session: 2 });
      return Object.fromEntries(journal.projection.gates().map((g) => [g.data.prover ?? "", g.data.pSuccess]));
    } finally {
      journal.close();
    }
  }

  it("do not depend on the order the provers ask in: the key is the request, not the row it lands on", async () => {
    const a = await pSuccessBySession(["p1", "p2", "p3"]);
    const b = await pSuccessBySession(["p3", "p1", "p2"]);
    assert.deepEqual(a, b);
    assert.equal(new Set(Object.values(a)).size, 3, "and different requests draw differently");
  });

  it("are the same for the same request, however many answers the problem already holds", async () => {
    const journal = open();
    try {
      const gate = gateOf(journal, { n: undefined }, gateSettings({ floor: 0 }));
      await gate.session({ prover: "p9", session: 2 });
      await gate.session({ prover: "p1", session: 2 });
      await gate.session({ prover: "p9", session: 2 });
      const [first, , again] = journal.projection.gates().map((g) => g.data.pSuccess);
      assert.equal(first, again);
    } finally {
      journal.close();
    }
  });
});

describe("what a launch is asked", () => {
  it("is refused when the chance a line gives is not a probability, and nothing is written", async () => {
    const journal = open();
    try {
      const gate = gateOf(journal, { n: undefined });
      for (const pSuccess of [1.5, -0.1, Number.NaN]) {
        await assert.rejects(gate.ask({ site: "task", estimateUsd: 0.1, pSuccess }), /the chance of success of a launch is from 0 to 1/);
      }
      assert.deepEqual(journal.projection.gates(), []);
      assert.equal((await gate.ask({ site: "task", estimateUsd: 0.1, pSuccess: 1 })).action, "launch");
    } finally {
      journal.close();
    }
  });

  it("prices a task by its sessions alone: the chance of success is in the rule's threshold, not in the price", () => {
    const journal = open();
    try {
      const gate = gateOf(journal, { n: undefined });
      assert.equal(gate.taskUsd(3), gate.sessionUsd() * 3);
      assert.equal(gate.taskUsd(0), gate.sessionUsd(), "at least one session");
    } finally {
      journal.close();
    }
  });
});

describe("an accepted informal proof at the widening", () => {
  function gateInformal(journal: Journal, accepted: boolean): BudgetGate {
    return new BudgetGate({ settings: gateSettings({ floor: 0 }), journal, problemId: "P1", claimId: "clm_1", ledger: new Ledger(5).child(5), seed: "unit", rung: () => 0, attemptIds: () => [], informalAccepted: () => accepted, log: () => {} });
  }

  it("counts as progress once: the problem widens, and a second look does not count it again", async () => {
    const journal = open();
    try {
      const gate = gateInformal(journal, true);
      gate.probe();
      const first = await gate.widen(2);
      assert.equal(first.action, "widen");
      assert.match(first.reason, /an informal proof was accepted \(not checked by Lean\)/);
      assert.match(journal.projection.gates()[1]?.data.reason ?? "", /an informal proof was accepted/);
      // A second probe (a later turn) and judgement: the marker is in the journal, so it is not counted again.
      gate.probe();
      const second = await gate.widen(2);
      assert.deepEqual([second.action, second.by], ["skip", "progress"]);
    } finally {
      journal.close();
    }
  });

  it("changes nothing without an accepted proof", async () => {
    const journal = open();
    try {
      const gate = gateInformal(journal, false);
      gate.probe();
      const stopped = await gate.widen(2);
      assert.deepEqual([stopped.action, stopped.by], ["skip", "progress"]);
    } finally {
      journal.close();
    }
  });
});
