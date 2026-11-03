import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProblemEntry } from "@seshat/bench";
import { Journal, loadMemoryChain, readEvents } from "@seshat/core";
import { measureRun } from "../src/measures.ts";
import { buildReport, DEFAULT_CONFIG, type RunConfig, type RunOptions, type RunResult, RunSetupError } from "../src/index.ts";
import { frozenProbeSet, linesOfRun, probeDirOf, runIndexOf, chooseProbeSet, compareProbe, overTime, probeDue, renderProbe, runProbe, signTest, verifiedOnlyMemory } from "../src/probe.ts";
import { scriptedRun, type ScriptedSpec } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
const entry = (id: string) => ({ id, path: "Bench.lean" }) as unknown as ProblemEntry;
const bench = Array.from({ length: 30 }, (_, i) => entry(`b${i}`));

describe("when the probe runs", () => {
  it("is due every K-th run, and never without a K", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].filter((n) => probeDue(n, 3)), [3, 6]);
    assert.equal(probeDue(3, 0), false);
    assert.equal(probeDue(0, 3), false);
  });
});

describe("the probe set", () => {
  it("is a seeded sample of problems that built nothing, 20 by default", () => {
    const built = bench.slice(0, 8).map((p) => p.id);
    const set = chooseProbeSet(bench, { builtOn: built });
    assert.equal(set.length, 20);
    assert.equal(set.some((p) => built.includes(p.id)), false);
    assert.deepEqual(chooseProbeSet(bench, { builtOn: built }), set);
  });
  it("is a fixed list when a file gives one, refused when it names a problem that built the memory or is not in the bench", () => {
    assert.deepEqual(chooseProbeSet(bench, { fixed: ["b3", "b1"] }).map((p) => p.id), ["b3", "b1"]);
    assert.throws(() => chooseProbeSet(bench, { fixed: ["b3"], builtOn: ["b3"] }), /memory was built on/);
    assert.throws(() => chooseProbeSet(bench, { fixed: ["zz"] }), /not in the bench/);
    assert.throws(() => chooseProbeSet(bench, { size: 25, builtOn: bench.slice(0, 8).map((p) => p.id) }), RunSetupError);
  });
});

const source: ScriptedSpec = {
  problems: [{ id: "p1", outcome: "candidate", attempts: [{ outcome: "valid", usd: 0.4, library: true }, { usd: 0.3 }] }, { id: "p2", outcome: "unsolved", attempts: [{ usd: 0.5 }] }],
  claims: [{ id: "c1", origin: "line:M12", status: "computed", validBy: "line:M10" }],
  nodes: [{ kind: "note", data: { text: "a fact" } }, { kind: "schema", data: { text: "learned" }, learned: true }],
};

describe("verifiedOnlyMemory", () => {
  it("keeps the claims, validations and unstamped nodes, and withholds attempts, stamped records and decisions", () => {
    const src = tempDir("mh-probe-src-");
    scriptedRun(source, src);
    const out = join(tempDir("mh-probe-out-"), "v");
    const r = verifiedOnlyMemory(src, out);
    assert.ok(r.dropped > 0 && r.events > 0);
    const kept = readEvents(join(out, "journal.jsonl"));
    const types = new Set(kept.map((e) => e.type));
    for (const t of ["attempt.started", "attempt.finished", "lesson.recorded", "decision.made", "run.finished", "problem.finished"] as const) assert.equal(types.has(t), false, t);
    assert.ok(types.has("claim.created") && types.has("validation.finished"));
    const nodes = kept.filter((e) => e.type === "node.recorded").map((e) => (e.type === "node.recorded" ? e.data.kind : ""));
    assert.ok(nodes.includes("note"));
    assert.equal(nodes.includes("schema"), false);
    assert.ok(kept.some((e) => e.type === "claim.status_changed" && e.data.to === "computed"), "a status Lean set stays");
  });

  it("leaves a journal a run can start on, and refuses to write over one", () => {
    const src = tempDir("mh-probe-src-");
    scriptedRun(source, src);
    const out = join(tempDir("mh-probe-out-"), "v");
    verifiedOnlyMemory(src, out);
    const chain = loadMemoryChain(out, undefined);
    assert.equal(chain.segments.length, 1);
    const journal = Journal.open(tempDir("mh-probe-run-"), "run_next", { memory: chain });
    assert.ok(journal.projection.claim(readEvents(join(out, "journal.jsonl")).find((e) => e.type === "claim.created")?.data.claimId as string));
    journal.close();
    assert.throws(() => verifiedOnlyMemory(src, out), /holds a journal already/);
  });
});

describe("the alarm", () => {
  const measures = (spec: ScriptedSpec) => measureRun(scriptedRun(spec).events);
  const p = (id: string, outcome: "proved" | "unsolved", usd: number): ScriptedSpec["problems"][number] => ({ id, outcome, attempts: [{ outcome: outcome === "proved" ? "valid" : "invalid", usd }] });
  const ids = Array.from({ length: 12 }, (_, i) => `q${i}`);

  it("computes the one-sided sign test exactly", () => {
    assert.equal(signTest(0, 0), 1);
    assert.equal(signTest(5, 5), 1 / 32);
    assert.equal(signTest(0, 4), 1);
  });

  it("rings when the memory solves clearly fewer problems, and not for a gap inside the noise", () => {
    const off = measures({ problems: ids.map((id) => p(id, "proved", 0.1)) });
    const worse = measures({ problems: ids.map((id, i) => p(id, i < 4 ? "unsolved" : "proved", 0.1)) });
    const v = compareProbe(worse, off);
    assert.equal(v.alarm.solves, true);
    assert.equal(v.onlyOff.length, 4);
    const slightly = measures({ problems: ids.map((id, i) => p(id, i < 1 ? "unsolved" : "proved", 0.1)) });
    assert.equal(compareProbe(slightly, off).alarm.solves, false);
  });

  it("rings when the memory costs more on most problems, and stays quiet when it costs less", () => {
    const off = measures({ problems: ids.map((id) => p(id, "proved", 0.1)) });
    const dearer = measures({ problems: ids.map((id) => p(id, "proved", 0.3)) });
    assert.equal(compareProbe(dearer, off).alarm.cost, true);
    const cheaper = measures({ problems: ids.map((id) => p(id, "proved", 0.05)) });
    const v = compareProbe(cheaper, off);
    assert.deepEqual([v.alarm.cost, v.alarm.solves], [false, false]);
    assert.match(renderProbe({ probeSet: ids, memoryDir: "m", verified: { events: 3, dropped: 2 }, on: cheaper, off, verdict: v }), /No alarm/);
    assert.match(renderProbe({ probeSet: ids, memoryDir: "m", verified: { events: 3, dropped: 2 }, on: dearer, off, verdict: compareProbe(dearer, off) }), /ALARM/);
  });
});

describe("runProbe", () => {
  it("runs the probe set twice from the memory and from its verified facts, and writes probe.json", async () => {
    const src = tempDir("mh-probe-src-");
    scriptedRun(source, src);
    const seen: RunOptions[] = [];
    const run = async (o: RunOptions): Promise<RunResult> => {
      seen.push(o);
      const r = scriptedRun({ problems: [{ id: "q1", outcome: "unsolved", attempts: [{ usd: 0.2 }] }] }, o.dir);
      const report = buildReport(r.events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
    const dir = tempDir("mh-probe-dir-");
    const template = { index: { benchId: "scripted" }, checkout: "/nowhere", models: {} } as unknown as Omit<RunOptions, "config" | "dir" | "problems" | "runId" | "memoryFrom" | "turns">;
    const result = await runProbe({ memoryDir: src, template, config: base, problems: [entry("q1")], dir, run });
    assert.deepEqual(seen.map((o) => [o.dir.split("/").at(-1), o.memoryFrom === src ? "memory" : "verified"]), [["on", "memory"], ["off", "verified"]]);
    assert.equal(seen[0]?.config.seed, seen[1]?.config.seed);
    assert.equal(result.verdict.problems, 1);
    assert.ok(readEvents(join(dir, "verified", "journal.jsonl")).length > 0);
  });
});

describe("over time", () => {
  it("gives the diversity of each run in a series", () => {
    const a = tempDir("mh-time-a-");
    const b = tempDir("mh-time-b-");
    scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ outcome: "valid", strategy: "induction" }] }] }, a);
    scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ outcome: "valid", strategy: "cases", library: true }] }, { id: "p2", outcome: "candidate", attempts: [{ outcome: "valid", strategy: "simp" }] }] }, b);
    const rows = overTime([a, b]);
    assert.deepEqual(rows.map((r) => r.run), [a, b]);
    assert.equal(rows[1]?.solved, 2);
    assert.ok((rows[1]?.strategies ?? 0) >= (rows[0]?.strategies ?? 0));
  });
});

describe("the probe beside the run, frozen and under the run's lines", () => {
  it("is written beside the run directory, never inside it", () => {
    assert.equal(probeDirOf("/runs/r1"), "/runs/r1.probe");
    assert.equal(probeDirOf("/runs/r1/"), "/runs/r1.probe");
  });

  it("draws the set once and reuses it for the next run of the chain, refusing it if the memory has since been built on it", () => {
    const first = tempDir("mh-frozen-a-");
    scriptedRun({ problems: [{ id: "b0", outcome: "unsolved", attempts: [{ usd: 0.1 }] }] }, first);
    const out1 = probeDirOf(first);
    const set1 = frozenProbeSet(first, out1, bench, { size: 5, seed: "s" });
    assert.equal(set1.length, 5);
    // The next run starts on the first one, whose problems differ: the pool shrinks, the set does not move.
    const second = tempDir("mh-frozen-b-");
    scriptedRun({ problems: [{ id: "b1", outcome: "unsolved", attempts: [{ usd: 0.1 }] }] }, second);
    assert.deepEqual(frozenProbeSet(first, out1, bench, { size: 5, seed: "other" }).map((p) => p.id), set1.map((p) => p.id));
    const taken = set1[0]?.id as string;
    const third = tempDir("mh-frozen-c-");
    scriptedRun({ problems: [{ id: taken, outcome: "unsolved", attempts: [{ usd: 0.1 }] }] }, third);
    assert.throws(() => frozenProbeSet(third, probeDirOf(third), bench, { fixed: [taken] }), /memory was built on/);
  });

  it("reads the lines and options a run was started with, and counts a run's place in its chain", () => {
    const dir = tempDir("mh-lines-");
    scriptedRun({ lines: ["M1", "M10"], problems: [{ id: "p1", outcome: "unsolved", attempts: [{ usd: 0.1 }] }] }, dir);
    assert.deepEqual(linesOfRun(dir).lines, ["M1", "M10"]);
    assert.equal(runIndexOf(undefined), 1);
    assert.equal(runIndexOf(dir), 2);
  });
});
