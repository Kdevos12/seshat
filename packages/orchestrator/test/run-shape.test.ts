import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { type ProblemEntry } from "@seshat/bench";
import { readEvents } from "@seshat/core";
import { certifyingRegistry, check, DemoLean, demoResume, demoRun, fauxModels, killedAt, ofType, say, tempDir } from "./m0-helpers.ts";
import { certifier } from "./resume-helpers.ts";
import { consortium } from "./turns-helpers.ts";
import { armConfig, cumulativeArms, runAblation } from "../src/ablation.ts";
import {
  buildReport,
  checkConfig,
  DEFAULT_CONFIG,
  normalizeLimits,
  readRecordedRun,
  renderRunReport,
  resolveSteps,
  type RunConfig,
  type RunOptions,
  RunSetupError,
  runShape,
  shapeProblems,
  solve,
  type SolveOptions,
  studentConfig,
} from "../src/index.ts";

/** The two axes of a run (plan change LH9, documentation/runs.md): `horizon` and `human`, derived and recorded; `steps`, the new name of `turns`. No Lean, model or network. */
const SIGNATURE = "(n : ℕ) : n + 0 = n";
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const exec = promisify(execFile);
const startedOf = (events: ReturnType<typeof readEvents>) => ofType(events, "run.started")[0]?.data;

function solveOptions(defaults: "v1" | "v2", over: Partial<SolveOptions> = {}): SolveOptions {
  const { models, faux, name } = fauxModels();
  faux.setResponses([check("exact trivial_proof")]);
  const c = certifier();
  const lean = new DemoLean();
  return { statement: SIGNATURE, dir: join(tempDir("mh-shape-"), "run"), models, model: name, maxUsd: 2, user: "alice", defaults, registry: certifyingRegistry(c.certifier)(lean), certifier: c.certifier, checker: lean, confirm: async () => true, ...over };
}

describe("the axes of a run", () => {
  it("derives human from the consortium turns and horizon as episode", () => {
    assert.deepEqual(runShape({}), { horizon: "episode", human: "none" });
    assert.deepEqual(runShape({ consortium: consortium() }), { horizon: "episode", human: "consortium" });
    assert.deepEqual(runShape({ human: "none" }), { horizon: "episode", human: "none" });
  });

  it("refuses a campaign without turns, digest without campaign, and an axis that contradicts the run", () => {
    assert.match(shapeProblems({ horizon: "campaign" }).join(";"), /campaign works in turns/);
    assert.match(shapeProblems({ human: "digest" }).join(";"), /digest goes with horizon campaign/);
    assert.match(shapeProblems({ human: "none", consortium: consortium() }).join(";"), /contradicts/);
    assert.match(shapeProblems({ human: "consortium" }).join(";"), /needs consortium turns/);
    assert.deepEqual(shapeProblems({ horizon: "episode", human: "consortium", consortium: consortium() }), []);
  });
});

describe("what a run records", () => {
  it("records episode and none for a run without consortium turns, and shows it in the log and the report", async () => {
    const log: string[] = [];
    const run = await demoRun({ responses: [check("exact trivial_proof")], log: (l) => log.push(l) });
    const started = startedOf(run.events);
    assert.deepEqual([started?.horizon, started?.human], ["episode", "none"]);
    assert.ok(log.includes("shape: horizon episode, human none"));
    const config = (started?.config ?? {}) as Record<string, unknown>;
    assert.equal("horizon" in config || "human" in config, false, "the recorded configuration is what it was");
    const report = buildReport(run.events);
    assert.deepEqual([report.horizon, report.human], ["episode", "none"]);
    assert.match(renderRunReport(report), /Horizon episode, human none\./);
  });

  it("records episode and consortium for a run with consortium turns", async () => {
    const run = await demoRun({ responses: [check("exact trivial_proof")], config: { consortium: consortium({ usd: 100 }) } });
    const started = startedOf(run.events);
    assert.deepEqual([started?.horizon, started?.human], ["episode", "consortium"]);
    assert.match(renderRunReport(buildReport(run.events)), /Horizon episode, human consortium\./);
  });

  it("records an axis that was given, and a resume keeps it", async () => {
    const run = await demoRun({ responses: [check("bad"), check("exact trivial_proof")], config: { horizon: "episode", human: "none", sessions: 3 } });
    assert.deepEqual([startedOf(run.events)?.horizon, startedOf(run.events)?.human], ["episode", "none"]);
    const recorded = readRecordedRun(run.dir);
    assert.deepEqual([recorded.config.horizon, recorded.config.human], ["episode", "none"]);
  });

  it("reads a journal that has no axes: nothing is shown, nothing fails", async () => {
    const run = await demoRun({ responses: [check("exact trivial_proof")] });
    const events = run.events.map((e) => {
      if (e.type !== "run.started") return e;
      const { horizon: _h, human: _u, ...rest } = e.data;
      return { ...e, data: rest };
    });
    const report = buildReport(events as typeof run.events);
    assert.equal(report.horizon, undefined);
    assert.doesNotMatch(renderRunReport(report), /Horizon/);
  });

  it("fails at the start for campaign and digest, before anything is written or spent", async () => {
    for (const [config, pattern] of [[{ horizon: "campaign" }, /campaign works in turns/], [{ human: "digest" }, /digest goes with horizon campaign/], [{ human: "none", consortium: consortium() }, /contradicts/]] as const) {
      const dir = join(tempDir(), "run");
      await assert.rejects(demoRun({ responses: [], config: config as Partial<RunConfig>, dir }), (error: unknown) => error instanceof RunSetupError && pattern.test(error.message));
    }
  });

  it("records none for every arm of an ablation", async () => {
    const seen: RunOptions[] = [];
    const problems = [{ id: "p1", path: "Bench.lean" } as unknown as ProblemEntry];
    const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
    await runAblation({
      template: { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as RunOptions,
      config: base,
      problems,
      arms: cumulativeArms(["M0", "M1"]),
      dir: tempDir("mh-shape-ablate-"),
      run: async (o) => {
        seen.push(o);
        throw new Error("stop after the configuration is seen");
      },
    }).catch(() => undefined);
    assert.ok(seen.length >= 1);
    for (const o of seen) assert.deepEqual(runShape(o.config), { horizon: "episode", human: "none" });
    assert.equal(armConfig(base, cumulativeArms(["M0", "M1"])[1] as never).consortium, undefined);
  });
});

describe("solve and its sets", () => {
  for (const defaults of ["v1", "v2"] as const) {
    it(`records episode and consortium for ${defaults}, and its configuration has neither key`, async () => {
      const config = studentConfig({ selection: { ids: ["p"] }, model: "faux/m", maxUsd: 2, defaults });
      assert.equal("horizon" in config || "human" in config, false);
      assert.deepEqual(runShape(config), { horizon: "episode", human: "consortium" });
      const run = await solve(solveOptions(defaults));
      const started = startedOf(readEvents(join(run.dir, "journal.jsonl")));
      assert.deepEqual([started?.horizon, started?.human], ["episode", "consortium"]);
      const recorded = (started?.config ?? {}) as Record<string, unknown>;
      assert.equal("horizon" in recorded || "human" in recorded, false);
    });
  }

  it("refuses --human none, and digest without campaign, with solve", async () => {
    await assert.rejects(solve(solveOptions("v1", { base: { human: "none" } })), /contradicts/);
    await assert.rejects(solve(solveOptions("v1", { base: { human: "digest" } })), /digest goes with horizon campaign/);
  });
});

describe("the command line", () => {
  const base = ["run", "--model", "faux/prover", "--checkout", "/nonexistent", "--sample", "1"];
  const harness = async (args: string[]): Promise<{ code: number; stderr: string }> => {
    try {
      await exec(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HARNESS_HOST: "" } });
      return { code: 0, stderr: "" };
    } catch (error) {
      const e = error as { code: number; stderr: string };
      return { code: e.code, stderr: e.stderr };
    }
  };

  it("takes only the words of the axes, and a bare --human is still consortium mode", async () => {
    assert.match((await harness([...base, "--human", "sometimes"])).stderr, /--human must be one of none, consortium, digest/);
    assert.match((await harness([...base, "--horizon", "forever"])).stderr, /--horizon must be one of episode, campaign/);
    // `--human` before another flag is the old switch: it reaches the ablation refusal as before.
    assert.match((await harness([...base, "--ablation", "M1", "--human"])).stderr, /a turn limit or --human cannot go with an ablation/);
    assert.match((await harness([...base, "--ablation", "M1", "--human", "consortium"])).stderr, /a turn limit or --human cannot go with an ablation/);
  });
});

describe("steps, the new name of turns", () => {
  it("gives one value for --steps, --turns, or both when equal, and refuses two", () => {
    assert.equal(resolveSteps(5, undefined), 5);
    assert.equal(resolveSteps(undefined, 5), 5);
    assert.equal(resolveSteps(5, 5), 5);
    assert.equal(resolveSteps(undefined, undefined), undefined);
    assert.throws(() => resolveSteps(5, 6), (e: unknown) => e instanceof RunSetupError && /steps \(5\) and turns \(6\)/.test(e.message));
  });

  it("builds the same limits from limits.steps and limits.turns, and refuses two different ones", () => {
    const limits = { contextTokens: 120_000 };
    assert.deepEqual(normalizeLimits({ ...limits, steps: 5 } as RunConfig["limits"]), normalizeLimits({ ...limits, turns: 5 }));
    assert.deepEqual(normalizeLimits({ ...limits, steps: 5, turns: 5 }), { turns: 5, contextTokens: 120_000 });
    const config: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/m", limits: { turns: 5, steps: 6, contextTokens: 120_000 } };
    assert.match(checkConfig(config).join(";"), /limits\.steps \(6\) and limits\.turns \(5\)/);
    assert.deepEqual(checkConfig({ ...config, limits: { turns: 5, steps: 5, contextTokens: 120_000 } }), []);
  });

  it("refuses --steps and --turns that differ, at the command line, and accepts the same number", async () => {
    const base = ["run", "--model", "faux/prover", "--checkout", "/nonexistent", "--sample", "1"];
    const run = async (args: string[]): Promise<string> => {
      try {
        await exec(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...base, ...args], { env: { ...process.env, HARNESS_HOST: "" } });
        return "";
      } catch (error) {
        return (error as { stderr: string }).stderr;
      }
    };
    assert.match(await run(["--steps", "5", "--turns", "6"]), /--steps \(5\) and --turns \(6\)|steps \(5\) and turns \(6\)/);
    assert.doesNotMatch(await run(["--steps", "5", "--turns", "5"]), /steps \(5\)/);
  });

  it("runs on limits.steps and records turns, as the journal always has", async () => {
    const run = await demoRun({ responses: [check("bad"), check("bad"), check("bad")], config: { limits: { steps: 2, contextTokens: 120_000 } as RunConfig["limits"] } });
    const started = startedOf(run.events);
    assert.deepEqual((started?.config as { limits: unknown }).limits, { turns: 2, contextTokens: 120_000 });
    assert.deepEqual(JSON.parse(readFileSync(join(run.dir, "config.json"), "utf8")).limits, { turns: 2, contextTokens: 120_000 });
  });

  it("resumes a journal that records turns", async () => {
    const whole = await demoRun({ responses: [check("bad"), say("NOTES: bad is not a lemma."), check("exact trivial_proof")], config: { sessions: 3, limits: { turns: 7, contextTokens: 120_000 } } });
    const cut = whole.events.findIndex((e) => e.type === "attempt.started" && ofType(whole.events, "attempt.started").indexOf(e) === 1);
    const dir = killedAt(whole.dir, cut);
    assert.equal(readRecordedRun(dir).config.limits.turns, 7);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")] });
    assert.equal(resumed.result.problems[0]?.outcome, whole.result.problems[0]?.outcome);
  });
});
