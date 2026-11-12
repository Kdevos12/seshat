import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProblemEntry } from "@seshat/bench";
import { ablateCommand, ablateHost, chunksCommand, commandArms, splitBench } from "../src/ablate-command.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult, RunSetupError } from "../src/index.ts";
import { consortium } from "./turns-helpers.ts";
import { scriptedRun, type ScriptedSpec } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
const problems = ["p1", "p2", "p3", "p4", "p5"].map((id) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry);
const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as Omit<RunOptions, "config" | "dir" | "problems" | "runId" | "memoryFrom" | "turns">;
const spec: ScriptedSpec = { problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }, { usd: 0.5 }] }] };

function fake(seen: RunOptions[] = []) {
  return async (o: RunOptions): Promise<RunResult> => {
    seen.push(o);
    const run = scriptedRun(spec, o.dir);
    const report = buildReport(run.events);
    return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
  };
}

describe("splitBench", () => {
  it("builds on some problems and measures on the others, deterministically", () => {
    const a = splitBench(problems, 2, "s");
    assert.equal(a.build.length, 2);
    assert.equal(a.measure.length, 3);
    assert.deepEqual([...a.build, ...a.measure].map((p) => p.id).sort(), problems.map((p) => p.id));
    assert.deepEqual(splitBench(problems, 2, "s"), a);
  });
  it("refuses a split that leaves nothing on one side", () => {
    assert.throws(() => splitBench(problems, 0, "s"), RunSetupError);
    assert.throws(() => splitBench(problems, 5, "s"), RunSetupError);
  });
});

describe("splitBench by file or stem", () => {
  const e = (path: string, fullName: string) => ({ id: `${path}#${fullName}`, path, fullName }) as unknown as ProblemEntry;
  const many = [e("A", "a1"), e("A", "a1.variants.x"), e("A", "a2"), e("B", "b1"), e("B", "b1.variants.y"), e("C", "c1"), e("D", "d1"), e("D", "d2")];

  it("never puts two problems of one file on both sides", () => {
    const s = splitBench(many, 3, "s", "file");
    const files = (ps: ProblemEntry[]) => new Set(ps.map((p) => p.path));
    for (const f of files(s.build)) assert.equal(files(s.measure).has(f), false, `file ${f} on both sides`);
    assert.ok(s.build.length >= 3);
    assert.equal(s.build.length + s.measure.length, many.length);
  });

  it("never separates a problem from its variants, though it may keep a file's other problems apart", () => {
    const s = splitBench(many, 2, "s", "stem");
    const stems = (ps: ProblemEntry[]) => new Set(ps.map((p) => `${p.path}${p.fullName.split(".variants.")[0]}`));
    for (const t of stems(s.build)) assert.equal(stems(s.measure).has(t), false, `${t} on both sides`);
  });

  it("refuses a split that leaves nothing to measure", () => {
    assert.throws(() => splitBench([e("A", "a1"), e("A", "a2"), e("A", "a3")], 1, "s", "file"), /leaves nothing to measure/);
  });
});

describe("harness ablate", () => {
  it("takes the cumulative configurations by name, or one experiment, not both", () => {
    assert.deepEqual(commandArms({ configs: ["M0", "M1"] }).map((a) => a.name), ["M0", "M1"]);
    assert.ok(commandArms({}).length > 10);
    assert.deepEqual(commandArms({ experiment: "lessons" }).map((a) => a.name), ["effect", "presence"]);
    assert.throws(() => commandArms({ experiment: "lessons", configs: ["M0"] }), RunSetupError);
    assert.throws(() => commandArms({ lines: ["M1"] }), RunSetupError);
  });

  it("runs an experiment, writes ablation.md and ablation.json, and prints the table with what was not run", async () => {
    const dir = join(tempDir("mh-ablate-cmd-"), "out");
    const printed: string[] = [];
    const seen: RunOptions[] = [];
    await ablateCommand({ template, config: base, problems, dir, experiment: "packet-mode", lines: ["M1", "M4"], run: fake(seen), print: (l) => printed.push(l) });
    assert.deepEqual(seen.map((o) => o.config.packetMode ?? "naive"), ["prefix_tail", "append_only", "recompiled", "naive"]);
    assert.ok(existsSync(join(dir, "ablation.json")) && existsSync(join(dir, "ablation.md")));
    assert.match(printed.join("\n"), /Not run: The cache ratio/);
    assert.match(readFileSync(join(dir, "ablation.md"), "utf8"), /The cache ratio is the faux provider's/, "the saved file carries the experiment's own limit");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "ablation.json"), "utf8")).label.notRun[0], "The cache ratio is the faux provider's; a provider's own cache must be read on the first real run.");
    assert.match(readFileSync(join(dir, "ablation.md"), "utf8"), /^# Ablation/);
  });

  it("measures on the bench's other part when it is split", async () => {
    const seen: RunOptions[] = [];
    await ablateCommand({ template, config: base, problems, dir: join(tempDir("mh-ablate-cmd-"), "out"), configs: ["M0"], split: 2, run: fake(seen), print: () => undefined });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.problems.length, 2);
    assert.equal(seen[1]?.problems.length, 3);
    assert.equal(seen[1]?.memoryFrom, seen[0]?.dir);
  });

  it("refuses a turn limit before anything runs (Task 17), and a directory that holds an ablation", async () => {
    const seen: RunOptions[] = [];
    const dir = join(tempDir("mh-ablate-cmd-"), "out");
    await assert.rejects(ablateCommand({ template, config: { ...base, consortium: consortium({ tokens: 100 }) }, problems, dir, configs: ["M0"], run: fake(seen), print: () => undefined }), /cannot go with an ablation/);
    assert.equal(seen.length, 0);
    await ablateCommand({ template, config: base, problems, dir, configs: ["M0"], run: fake(), print: () => undefined });
    await assert.rejects(ablateCommand({ template, config: base, problems, dir, configs: ["M0"], run: fake(), print: () => undefined }), /holds a finished ablation/);
  });
});

describe("problems out of reach (PA6)", () => {
  const tagged = problems.map((p) => (p.id === "p2" ? { ...p, reach: "small_budget_out_of_reach" as const, reachReason: "no Mathlib" } : p));
  const twoSpec: ScriptedSpec = { problems: [{ id: "p1", outcome: "proved", attempts: [{ outcome: "valid", usd: 0.4 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }, { id: "p3", outcome: "unsolved", attempts: [{ usd: 0.5 }] }, { id: "p4", outcome: "unsolved", attempts: [{ usd: 0.5 }] }, { id: "p5", outcome: "unsolved", attempts: [{ usd: 0.5 }] }] };
  const run = async (o: RunOptions): Promise<RunResult> => {
    const r = scriptedRun(twoSpec, o.dir);
    const report = buildReport(r.events);
    return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
  };

  it("reports all problems and the problems in reach apart, and pairs on the ones in reach", async () => {
    const dir = join(tempDir("mh-ablate-reach-"), "out");
    const result = await ablateCommand({ template, config: base, problems: tagged, dir, configs: ["M0", "M1"], run, print: () => undefined });
    assert.deepEqual(result.outOfReach, ["p2"]);
    assert.equal(result.protocolAll?.arms[0]?.problems, 5);
    assert.equal(result.protocol?.arms[0]?.problems, 4, "the verdicts use the problems in reach");
    const text = readFileSync(join(dir, "ablation.md"), "utf8");
    assert.match(text, /### All problems/);
    assert.match(text, /### Problems in reach/);
    assert.match(text, /The same 4 problem\(s\)/);
  });

  it("keeps the one table when nothing is tagged", async () => {
    const dir = join(tempDir("mh-ablate-reach-"), "out");
    const result = await ablateCommand({ template, config: base, problems, dir, configs: ["M0", "M1"], run, print: () => undefined });
    assert.equal(result.outOfReach, undefined);
    assert.equal(result.protocolAll, undefined);
    assert.doesNotMatch(readFileSync(join(dir, "ablation.md"), "utf8"), /### All problems/);
  });

  it("warns when the run budget is below sample x cap, and not otherwise", async () => {
    const lines: string[] = [];
    const config = { ...base, budget: { problemUsd: 1, runUsd: 3 } };
    await ablateCommand({ template, config, problems, dir: join(tempDir("mh-ablate-reach-"), "out"), configs: ["M0"], run, print: () => undefined, log: (l) => lines.push(l) });
    assert.equal(lines.filter((l) => /below 5 problem\(s\) x the cap of \$1/.test(l)).length, 1);
    const quiet: string[] = [];
    await ablateCommand({ template, config: { ...base, budget: { problemUsd: 1, runUsd: 5 } }, problems, dir: join(tempDir("mh-ablate-reach-"), "out"), configs: ["M0"], run, print: () => undefined, log: (l) => quiet.push(l) });
    assert.equal(quiet.filter((l) => /^warning/.test(l)).length, 0);
  });
});

describe("harness chunks", () => {
  it("prints the curves of a run directory and refuses one without a journal", () => {
    const dir = tempDir("mh-chunks-");
    scriptedRun(spec, dir);
    const out: string[] = [];
    chunksCommand([dir], (l) => out.push(l), { ks: [1, 3] });
    assert.match(out.join(""), /Cost to first success/);
    assert.throws(() => chunksCommand([tempDir("mh-chunks-empty-")], () => undefined), /no journal/);
    assert.throws(() => chunksCommand([], () => undefined), /needs a run directory/);
  });
});

describe("the host of the solve-defaults arms", () => {
  it("is the one solve takes, and every other experiment keeps its default", () => {
    const saved = process.env.HARNESS_HOST;
    delete process.env.HARNESS_HOST;
    const withProfile = tempDir("mh-hosts-");
    const without = tempDir("mh-hosts-");
    mkdirSync(join(withProfile, "hosts"), { recursive: true });
    writeFileSync(join(withProfile, "hosts", "sandboxed.json"), "{}");
    try {
      assert.equal(ablateHost("solve-defaults", undefined, withProfile), "sandboxed");
      assert.equal(ablateHost("solve-defaults", undefined, without), "local");
      assert.equal(ablateHost("solve-defaults", "mine", withProfile), "mine");
      assert.equal(ablateHost("ladder", undefined, withProfile), "local");
      assert.equal(ablateHost(undefined, undefined, withProfile), "local");
      process.env.HARNESS_HOST = "fromenv";
      assert.equal(ablateHost("solve-defaults", undefined, withProfile), "fromenv");
    } finally {
      if (saved === undefined) delete process.env.HARNESS_HOST;
      else process.env.HARNESS_HOST = saved;
    }
  });
});
