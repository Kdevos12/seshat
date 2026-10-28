import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InterruptedError, type ProblemContext, type TaskInfo } from "@seshat/lines";
import { createM18Line, M18_GENERATION_KIND, M18_OPTIONS, M18_SESSION_KIND, readVariants, roomFor } from "../src/index.ts";

const TARGET = "(n : ℕ) : n + 0 = n";

describe("the variants a model proposes", () => {
  it("keeps statements in signature form, easiest first, up to the limit", () => {
    const { kept, dropped } = readVariants(
      { variants: [{ kind: "small_case", statement: ": 2 + 0 = 2" }, { kind: "prime_case", statement: "(p : ℕ) (hp : p.Prime) : p + 0 = p" }, { kind: "extra_hypothesis", statement: "(n : ℕ) (h : 1 < n) : n + 0 = n" }] },
      TARGET,
      2,
    );
    assert.deepEqual(kept.map((v) => [v.kind, v.statement]), [["small_case", ": 2 + 0 = 2"], ["prime_case", "(p : ℕ) (hp : p.Prime) : p + 0 = p"]]);
    assert.deepEqual(dropped, ["over the limit"]);
  });

  it("drops the target itself, repeats, sorry, text with no colon, and anything that is not a list of statements", () => {
    const { kept, dropped } = readVariants(
      {
        variants: [
          { statement: "(n : ℕ)   : n + 0 = n" },
          { statement: ": 1 + 0 = 1" }, { statement: ":  1 + 0 =  1" },
          { statement: ": 2 + 0 = 2 := by sorry" },
          { statement: "a theorem about addition" },
          { statement: "" }, { kind: "small_case" },
          { kind: "nonsense", statement: ": 3 + 0 = 3" },
        ],
      },
      TARGET,
      9,
    );
    assert.deepEqual(kept, [{ kind: "extra_hypothesis", statement: ": 1 + 0 = 1" }, { kind: "extra_hypothesis", statement: ": 3 + 0 = 3" }]);
    assert.equal(dropped.length, 6);
    assert.deepEqual(readVariants("not an object", TARGET, 4), { kept: [], dropped: [] });
    assert.deepEqual(readVariants({ variants: "x" }, TARGET, 4), { kept: [], dropped: [] });
  });
});

/** A problem context with only what the line's hooks reach before they ask the model, and a model that is interrupted. */
function problem(nodes: Array<{ kind: string; data: object }> = [], limitUsd: number | null = 1): ProblemContext {
  const logs: string[] = [];
  const interrupted = async () => {
    throw new InterruptedError();
  };
  return {
    line: "M18", runId: "run", problemId: "prb_1", claimId: "clm_1",
    target: { theorem: "Demo.t", statement: TARGET, source: "", sketch: { prefix: "import Mathlib\n" } },
    memory: {
      nodes: (kind: string) => nodes.filter((n) => n.kind === kind).map((n, k) => ({ nodeId: `nod_${k}`, kind, data: n.data })),
      claim: () => ({ claimId: "clm_2", status: "open", statement: ": 1 + 0 = 1" }),
    },
    llm: { complete: interrupted, completeJson: interrupted },
    budget: { ...(limitUsd !== null ? { limitUsd } : {}), usd: 0, exhausted: false },
    signal: new AbortController().signal,
    options: { ...M18_OPTIONS },
    log: (text: string) => void logs.push(text),
  } as unknown as ProblemContext;
}

describe("the share of the budget", () => {
  const record = (kind: string, usd: number) => ({ kind, data: { problemId: "prb_1", usd } });

  it("allows calls while the spend is under the share, and not a call that the dearest session would pass", () => {
    const share = { share: 0.2 };
    assert.deepEqual(roomFor(problem([], 1), share), { ok: true, spent: 0, cap: 0.2 });
    assert.equal(roomFor(problem([record(M18_GENERATION_KIND, 0.1)], 1), share).ok, true);
    // 0.05 for the variants and 0.07 for a session: another session of 0.07 still fits under the cap of 0.2, and the one after it would not.
    const after = roomFor(problem([record(M18_GENERATION_KIND, 0.05), record(M18_SESSION_KIND, 0.07)], 1), share);
    assert.equal(after.ok, true);
    assert.ok(Math.abs(after.spent - 0.12) < 1e-12);
    assert.equal(roomFor(problem([record(M18_GENERATION_KIND, 0.05), record(M18_SESSION_KIND, 0.07), record(M18_SESSION_KIND, 0.07)], 1), share).ok, false);
    assert.equal(roomFor(problem([record(M18_GENERATION_KIND, 0.25)], 1), share).ok, false, "the cap is passed");
  });

  it("counts only this problem's records, has no cap without a dollar budget, and none to spend at a share of 0", () => {
    const other = { kind: M18_SESSION_KIND, data: { problemId: "prb_2", usd: 9 } };
    assert.equal(roomFor(problem([other], 1), { share: 0.2 }).spent, 0);
    assert.deepEqual(roomFor(problem([record(M18_SESSION_KIND, 50)], null), { share: 0.2 }), { ok: true, spent: 50, cap: Number.POSITIVE_INFINITY });
    assert.equal(roomFor(problem([], 1), { share: 0 }).ok, false);
  });
});

describe("an interruption", () => {
  it("passes through the request for variants and through a session, and writes nothing as an end", async () => {
    const line = createM18Line();
    await assert.rejects(line.hooks.beforeProvers?.(problem()) ?? Promise.resolve(), InterruptedError);
    const task = { taskId: "tsk_1", claimId: "clm_2", budget: { sessions: 2 } } as unknown as TaskInfo;
    await assert.rejects(line.hooks.runTask?.(problem(), task, "line:M18") ?? Promise.resolve(), InterruptedError);
  });
});
