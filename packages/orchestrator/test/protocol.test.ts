import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ProblemEntry } from "@seshat/bench";
import { cumulativeArms, runAblation } from "../src/ablation.ts";
import { renderAblation } from "../src/ablation-table.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult } from "../src/index.ts";
import { measureRun, settledInLiterature } from "../src/measures.ts";
import { pairedProtocol } from "../src/protocol.ts";
import { type ScriptedProblem, scriptedRun, type ScriptedSpec } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const solved = (id: string, usd: number): ScriptedProblem => ({ id, outcome: "candidate", attempts: [{ outcome: "valid", usd }] });
const open = (id: string, usd: number): ScriptedProblem => ({ id, outcome: "unsolved", attempts: [{ usd }] });
const measures = (spec: ScriptedSpec) => measureRun(scriptedRun(spec).events);

describe("the paired protocol", () => {
  // Baseline: p1 solved at 0.4, the other three unsolved at 0.5 each: 1 solved for $1.90.
  const baseline = measures({ problems: [solved("p1", 0.4), open("p2", 0.5), open("p3", 0.5), open("p4", 0.5)] });

  it("gives the solved counts with Wilson intervals, the dollars, the ratios and the pairs against the baseline", () => {
    // x: p1, p2, p3 solved for $1.50 in all: 2.0 solved per dollar against 1/1.9.
    const x = measures({ problems: [solved("p1", 0.4), solved("p2", 0.3), solved("p3", 0.3), open("p4", 0.5)] });
    const protocol = pairedProtocol([{ name: "base", measures: baseline }, { name: "x", measures: x }]);
    const [b, row] = protocol.arms;
    assert.deepEqual([b?.solved, b?.problems, b?.usd], [1, 4, 1.9]);
    assert.ok(Math.abs((b?.usdPerSolved ?? 0) - 1.9) < 1e-9);
    assert.equal(b?.versus, undefined);
    // Wilson 95% of 1 in 4, computed independently: 0.0456 to 0.6993.
    assert.ok(Math.abs((b?.interval.low ?? 0) - 0.04557) < 1e-4 && Math.abs((b?.interval.high ?? 0) - 0.69934) < 1e-4);
    assert.deepEqual([row?.solved, row?.versus?.onlyThis, row?.versus?.onlyBaseline, row?.versus?.common], [3, 2, 0, 4]);
    assert.equal(row?.versus?.p, 0.5, "two discordant pairs, both one way: 2 * (1/2)^2");
    assert.ok(Math.abs((row?.versus?.ratio ?? 0) - 2 / (1 / 1.9)) < 1e-9);
    assert.equal(protocol.verdict?.met, true);
    assert.match(protocol.verdict?.line ?? "", /Target met: x gives 3\.80 times the problems solved per dollar of base/);
  });

  it("says the target is not met when the ratio is under it, and when the cheaper arm solves fewer problems", () => {
    const slight = measures({ problems: [solved("p1", 0.4), open("p2", 0.5), open("p3", 0.5), open("p4", 0.3)] });
    const under = pairedProtocol([{ name: "base", measures: baseline }, { name: "slight", measures: slight }]);
    assert.equal(under.verdict?.met, false);
    assert.match(under.verdict?.line ?? "", /Target not met.*1\.1\d times.*under the target 1\.5/);
    // Two problems solved at $2.00 (1.0 per dollar) against one solved at $0.40 (2.5 per dollar).
    const two = measures({ problems: [solved("p1", 0.5), solved("p2", 0.5), open("p3", 0.5), open("p4", 0.5)] });
    const one = measures({ problems: [solved("p1", 0.4), open("p2", 0), open("p3", 0), open("p4", 0)] });
    const fewer = pairedProtocol([{ name: "base", measures: two }, { name: "cheap", measures: one }]);
    assert.equal(fewer.verdict?.met, false);
    assert.match(fewer.verdict?.line ?? "", /2\.50 times.*cheap solves 1 against 2: fewer problems/);
    assert.equal(fewer.arms[1]?.versus?.onlyBaseline, 1);
    const target = pairedProtocol([{ name: "base", measures: baseline }, { name: "slight", measures: slight }], "base", 1.1);
    assert.equal(target.verdict?.met, true, "--target moves the line");
  });

  it("gives no verdict on arms that did not finish the same problems, nor a ratio against a baseline that solves nothing", () => {
    const short = measures({ problems: [solved("p1", 0.1), solved("p2", 0.1)] });
    const unequal = pairedProtocol([{ name: "base", measures: baseline }, { name: "short", measures: short }]);
    assert.equal(unequal.arms[1]?.versus?.comparable, false);
    assert.equal(unequal.verdict?.met, false);
    assert.match(unequal.verdict?.line ?? "", /did not finish the same problems/);
    const nothing = measures({ problems: [open("p1", 0.5), open("p2", 0.5)] });
    const vs = pairedProtocol([{ name: "base", measures: nothing }, { name: "short", measures: short }]);
    assert.equal(vs.arms[1]?.versus?.ratio, undefined);
    assert.equal(vs.verdict?.met, false);
  });

  it("carries the certified refutations and counts literature-settled statements apart", () => {
    const spec: ScriptedSpec = {
      problems: [solved("p1", 0.1), solved("p2", 0.1), open("p3", 0.1)],
      nodes: [
        { kind: "literature", data: { backend: "b", url: "u", title: "t", quote: "q", verdict: "proves", settled: true } },
        { kind: "literature", data: { backend: "b", url: "u2", title: "t", quote: "q", verdict: "unrelated", settled: false } },
      ],
    };
    // The scripted journals cannot certify a refutation, so the count is the one `outcomes` holds, set by hand.
    const m = { ...measures(spec), refuted: 1 };
    assert.equal(m.settledInLiterature, 1);
    assert.equal(measures(spec).refuted, 0);
    assert.equal(settledInLiterature(scriptedRun({ problems: [open("p1", 0.1)] }).events), 0, "zero when no such node exists");
    assert.equal(pairedProtocol([{ name: "a", measures: m }]).arms[0]?.settledInLiterature, 1);
    assert.equal(pairedProtocol([{ name: "a", measures: m }]).verdict, undefined, "a single arm has no verdict");
  });

  it("is written into the table of an ablation, with the baseline and the target of the command", async () => {
    const problems = ["p1", "p2", "p3", "p4"].map((id) => ({ id, path: "B.lean" }) as unknown as ProblemEntry);
    const specs: Record<string, ScriptedSpec> = {
      M0: { problems: [solved("p1", 0.4), open("p2", 0.5), open("p3", 0.5), open("p4", 0.5)] },
      M1: { lines: ["M1"], problems: [solved("p1", 0.4), solved("p2", 0.3), solved("p3", 0.3), open("p4", 0.5)] },
    };
    const run = async (o: RunOptions): Promise<RunResult> => {
      const spec = specs[o.config.lines?.join("+") ?? "M0"] as ScriptedSpec;
      const report = buildReport(scriptedRun(spec, o.dir).events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
    const config: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
    const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions;
    const result = await runAblation({ template, config, problems, arms: cumulativeArms(["M0", "M1"]), dir: tempDir("mh-protocol-"), run, target: 3 });
    assert.equal(result.protocol?.baseline, "M0", "the first arm by default");
    assert.equal(result.protocol?.target, 3);
    const text = renderAblation(result);
    assert.match(text, /## Paired protocol/);
    assert.match(text, /\| M0 \| 1\/4 \| 5% to 70% \| \$1\.900 \| \$1\.900 \| 0\.53 \|/);
    assert.match(text, /\| M1 \| 2 \| 0 \| 0\.5000 \| 3\.80 \|/);
    assert.match(text, /Target met: M1 gives 3\.80 times/);
    await assert.rejects(runAblation({ template, config, problems, arms: cumulativeArms(["M0"]), dir: tempDir("mh-protocol-"), run, baseline: "nope" }), /baseline arm nope is not in the table/);
  });
});
