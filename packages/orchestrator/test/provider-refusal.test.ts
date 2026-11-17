import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ProblemEntry } from "@seshat/bench";
import { runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult } from "../src/index.ts";
import { fatalProviderError, refusalLine } from "../src/provider-errors.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { demoRun, tempDir } from "./m0-helpers.ts";

const refused = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "402: Insufficient Balance" });

describe("fatalProviderError", () => {
  it("recognizes a refusal a retry cannot cure", () => {
    assert.ok(fatalProviderError("402: Insufficient Balance"));
    assert.ok(fatalProviderError("401 Unauthorized"));
    assert.ok(fatalProviderError("HTTP 403 forbidden"));
    assert.ok(fatalProviderError("Incorrect API key provided"));
    assert.equal(refusalLine("402: Insufficient Balance"), "the model provider refused the request (402: Insufficient Balance): the run stopped; nothing more was spent");
  });

  it("leaves rate limits, overload, timeouts and Lean errors alone", () => {
    assert.equal(fatalProviderError("429: Too Many Requests"), undefined);
    assert.equal(fatalProviderError("500 Internal Server Error"), undefined);
    assert.equal(fatalProviderError("503: overloaded"), undefined);
    assert.equal(fatalProviderError("request timed out"), undefined);
    assert.equal(fatalProviderError("unknown identifier 'foo'"), undefined);
    assert.equal(fatalProviderError("the model request failed"), undefined);
  });
});

describe("a run on a provider that refuses", () => {
  it("stops at the first refused request and says why", async () => {
    const lines: string[] = [];
    const { result, events, faux } = await demoRun({
      responses: Array.from({ length: 20 }, refused),
      config: { provers: 1, sessions: 4 },
      problems: 2,
      log: (l) => lines.push(l),
    });
    assert.equal(result.stopped, "provider_refused");
    assert.match(result.providerRefusal ?? "", /402/);
    assert.equal(faux.state.callCount, 1, "no further request after the refusal");
    assert.equal(result.problems.length, 1, "the second problem was not started");
    assert.equal(result.problems[0]?.outcome, "error");
    assert.match(result.problems[0]?.reason ?? "", /provider refused/);
    assert.ok(lines.some((l) => l.includes("the model provider refused the request (402: Insufficient Balance): the run stopped; nothing more was spent")));
    const finished = events.filter((e) => e.type === "run.finished");
    assert.equal(finished[0]?.data.stopped, "provider_refused");
  });
});

describe("an ablation whose second arm is refused", () => {
  const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
  const problems = ["p1", "p2"].map((id) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry);
  const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions;
  const arms = [
    { name: "M0", description: "none", lines: [] },
    { name: "M1", description: "one", lines: [] },
    { name: "M2", description: "two", lines: [] },
  ];

  it("does not run the third, says it is not valid and prints no verdict", async () => {
    const seen: string[] = [];
    const run = async (o: RunOptions): Promise<RunResult> => {
      seen.push(o.dir);
      const scripted = scriptedRun({ problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] }, o.dir);
      const report = buildReport(scripted.events);
      const second = seen.length === 2;
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report, ...(second ? { stopped: "provider_refused", providerRefusal: "402: Insufficient Balance" } : {}) };
    };
    const result = await runAblation({ template, config: base, problems, arms, dir: tempDir("mh-refusal-"), run });
    assert.equal(seen.length, 2, "the third arm did not run");
    assert.deepEqual(result.refusal, { arm: "M1", reason: "402: Insufficient Balance", notRun: ["M2"] });
    assert.deepEqual(result.arms.map((a) => a.arm.name), ["M0"], "the first arm's row is kept");
    assert.equal(result.protocol, undefined);
    const table = renderAblation(result);
    assert.match(table.split("\n").slice(0, 4).join("\n"), /not valid/);
    assert.match(table, /402: Insufficient Balance/);
    assert.doesNotMatch(table, /Paired protocol|Target (not )?met|McNemar/i);
    assert.match(table, /\| M0 /);
  });
});
