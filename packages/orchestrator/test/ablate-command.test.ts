import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProblemEntry } from "@seshat/bench";
import { ablateCommand, chunksCommand, commandArms, splitBench } from "../src/ablate-command.ts";
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
