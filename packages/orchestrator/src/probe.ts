import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ProblemEntry, sample } from "@seshat/bench";
import { EventLog, type EventType, type HarnessEvent, loadMemoryChain, type Json, readEvents } from "@seshat/core";
import { labelLines, type RunLabel, runLabel } from "./run-label.ts";
import { measureRun, type RunMeasures } from "./measures.ts";
import { RunSetupError, runBench, type RunConfig, type RunOptions, type RunResult } from "./run.ts";

/**
 * The entrenchment probe and the diversity metrics (plan change PE9, documentation/ablate.md, "The probe"): a fixed set of problems
 * that never built the memory is rerun every K runs twice, with the memory the program has and with the verified facts alone, and an
 * alarm says when the memory does worse than none beyond noise.
 */

export const DEFAULT_PROBE_SIZE = 20;

/** True on the runs that carry a probe: every `every`-th run, counting from 1. `every` of 0 or less: never. */
export function probeDue(runIndex: number, every: number): boolean {
  return Number.isInteger(every) && every > 0 && Number.isInteger(runIndex) && runIndex > 0 && runIndex % every === 0;
}

/**
 * The probe set: the ids in `fixed` (a file the team keeps, `--probe-set FILE`) or a seeded sample of `size`, from the bench's
 * problems that the memory was not built on. A fixed id that is not in the bench, or that built the memory, is refused: the set must stay fixed.
 */
export function chooseProbeSet(problems: readonly ProblemEntry[], options: { size?: number; seed?: string; fixed?: readonly string[]; builtOn?: readonly string[] } = {}): ProblemEntry[] {
  const built = new Set(options.builtOn ?? []);
  if (options.fixed !== undefined) {
    const byId = new Map(problems.map((p) => [p.id, p]));
    const missing = options.fixed.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new RunSetupError(`the probe set names problems that are not in the bench: ${missing.join(", ")}`);
    const used = options.fixed.filter((id) => built.has(id));
    if (used.length > 0) throw new RunSetupError(`the probe set names problems the memory was built on: ${used.join(", ")}`);
    return options.fixed.map((id) => byId.get(id) as ProblemEntry);
  }
  const size = options.size ?? DEFAULT_PROBE_SIZE;
  if (!Number.isInteger(size) || size < 1) throw new RunSetupError(`--probe-size must be a whole number of at least 1, got ${size}`);
  const pool = problems.filter((p) => !built.has(p.id));
  if (pool.length < size) throw new RunSetupError(`the probe needs ${size} problems that built nothing, the bench has ${pool.length}`);
  return sample(pool, size, `${options.seed ?? "probe"}\nprobe`);
}

/** Event types that carry a learned, unverified record, or only the account of how a run went: left out of the verified-only memory. */
const DROPPED = new Set<EventType>([
  "run.finished", "run.resumed", "problem.finished", "attempt.started", "attempt.finished", "attempt.charged", "model_call.finished", "lesson.recorded",
  "turn.started", "turn.ended", "turn.deferred", "task.created", "task.assigned", "task.status_changed", "task.routed", "ladder.escalated",
  "memory.epoch_opened", "decision.made", "budget.gated", "pack.installed", "pack.removed",
]);
/** Fields that name a record of a dropped event. */
const REFERENCES = ["attemptId", "taskId", "provenance", "drawn", "included", "withheld"];

/**
 * Re-emits a run's memory with the verified facts alone: the claims, the Lean validations and the tool runs behind them, the edges Lean
 * checked, and the nodes no mechanism learned from outcomes. Withheld: the attempts, the lessons, every record that carries a provenance
 * stamp (Global Constraint 16), the decisions, and a status Lean did not set. The journal is chained again; `outDir` can be given to
 * `memoryFrom`. A run that itself started on earlier journals is flattened: their events come first.
 */
export function verifiedOnlyMemory(srcDir: string, outDir: string): { events: number; dropped: number } {
  if (existsSync(join(outDir, "journal.jsonl"))) throw new RunSetupError(`${outDir} holds a journal already`);
  const chain = loadMemoryChain(srcDir, undefined);
  const events: HarnessEvent[] = chain.segments.flatMap((s, i) => (i === 0 ? [...s.events] : s.events.filter((e) => e.type !== "run.started")));
  const first = events[0];
  if (first === undefined || first.type !== "run.started") throw new RunSetupError(`${srcDir} holds no run`);
  const runId = `verified-${first.data.runId}`;
  const keptEdges = new Set<string>();
  const keptNodes = new Set<string>();
  const kept: Array<{ type: EventType; data: Record<string, unknown>; actor: string }> = [];
  let dropped = 0;
  for (const e of events) {
    const data: Record<string, unknown> = { ...(e.data as unknown as Record<string, unknown>) };
    let keep = !DROPPED.has(e.type);
    if (e.type === "run.started") {
      data.runId = runId;
      delete data.memoryFrom;
    } else if (e.type === "claim.status_changed") {
      keep = e.data.to === "open" || (e.data.validationId !== undefined && ["computed", "proved", "refuted", "retracted"].includes(e.data.to));
    } else if (e.type === "edge.added") {
      keep = e.data.status === "lean_checked" && e.data.validationId !== undefined;
      if (keep) keptEdges.add(e.data.edgeId);
    } else if (e.type === "edge.status_changed") {
      keep = keptEdges.has(e.data.edgeId);
    } else if (e.type === "node.recorded") {
      keep = e.data.provenance === undefined;
      if (keep) keptNodes.add(e.data.nodeId);
    } else if (e.type === "node.updated") {
      keep = keptNodes.has(e.data.nodeId);
    }
    if (!keep) {
      dropped += 1;
      continue;
    }
    for (const field of REFERENCES) delete data[field];
    kept.push({ type: e.type, data, actor: e.actor });
  }
  mkdirSync(outDir, { recursive: true });
  const log = EventLog.open(join(outDir, "journal.jsonl"), { run: runId });
  try {
    for (const k of kept) (log.append as (type: EventType, data: unknown, actor: string) => unknown)(k.type, k.data as Json, k.actor);
  } finally {
    log.close();
  }
  for (const dir of chain.blobDirs) if (existsSync(dir)) cpSync(dir, join(outDir, "blobs"), { recursive: true });
  return { events: kept.length, dropped };
}

/** The exact one-sided sign test: the probability of `wins` or more out of `n` fair coin tosses. */
export function signTest(wins: number, n: number): number {
  if (n === 0) return 1;
  let p = 0;
  let c = 1;
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) c = (c * (n - k + 1)) / k;
    if (k >= wins) p += c;
  }
  return p / 2 ** n;
}

export interface ProbeAlarm {
  /** Memory-on solved fewer problems than memory-off, beyond noise. */
  solves: boolean;
  /** Memory-on spent more on the problems, beyond noise. */
  cost: boolean;
  reasons: string[];
}

export interface ProbeVerdict {
  problems: number;
  on: { solved: number; usd: number };
  off: { solved: number; usd: number };
  /** Problems solved with the memory only, and without it only. */
  onlyOn: string[];
  onlyOff: string[];
  /** Problems on which the memory cost more, and less (ties left out). */
  costlier: number;
  cheaper: number;
  /** One-sided sign tests: the chance of a gap this size or larger with a memory that does nothing. */
  pSolves: number;
  pCost: number;
  alpha: number;
  alarm: ProbeAlarm;
}

/** Compares the memory-on and memory-off runs of the probe: paired by problem, with sign tests. `alpha` (default 0.1) is what "beyond noise" means. */
export function compareProbe(on: RunMeasures, off: RunMeasures, alpha = 0.1): ProbeVerdict {
  const solved = (m: RunMeasures) => new Set(m.perProblem.filter((p) => ["proved", "refuted", "candidate"].includes(p.outcome)).map((p) => p.problemId));
  const a = solved(on);
  const b = solved(off);
  const onlyOn = [...a].filter((id) => !b.has(id)).sort();
  const onlyOff = [...b].filter((id) => !a.has(id)).sort();
  const spend = new Map(off.perProblem.map((p) => [p.problemId, p.usd]));
  let costlier = 0;
  let cheaper = 0;
  for (const p of on.perProblem) {
    const other = spend.get(p.problemId);
    if (other === undefined || Math.abs(other - p.usd) < 1e-9) continue;
    if (p.usd > other) costlier += 1;
    else cheaper += 1;
  }
  const pSolves = signTest(onlyOff.length, onlyOff.length + onlyOn.length);
  const pCost = signTest(costlier, costlier + cheaper);
  const alarm: ProbeAlarm = {
    solves: onlyOff.length > onlyOn.length && pSolves <= alpha,
    cost: costlier > cheaper && on.usd > off.usd && pCost <= alpha,
    reasons: [],
  };
  if (alarm.solves) alarm.reasons.push(`with the memory ${on.solved} solved against ${off.solved} without; ${onlyOff.length} problems only without it, ${onlyOn.length} only with it (p=${pSolves.toFixed(3)})`);
  if (alarm.cost) alarm.reasons.push(`the memory cost more on ${costlier} problems and less on ${cheaper} ($${on.usd.toFixed(3)} against $${off.usd.toFixed(3)}, p=${pCost.toFixed(3)})`);
  return { problems: on.problems, on: { solved: on.solved, usd: on.usd }, off: { solved: off.solved, usd: off.usd }, onlyOn, onlyOff, costlier, cheaper, pSolves, pCost, alpha, alarm };
}

export interface ProbeInput {
  /** The run (a directory) whose memory is tested: its journal and the ones it was started on. */
  memoryDir: string;
  template: Omit<RunOptions, "config" | "dir" | "problems" | "runId" | "memoryFrom" | "turns">;
  config: RunConfig;
  problems: readonly ProblemEntry[];
  /** Where the probe writes: `on/`, `off/`, `verified/` and `probe.json`. */
  dir: string;
  alpha?: number;
  run?: (options: RunOptions) => Promise<RunResult>;
}

export interface ProbeResult {
  probeSet: string[];
  memoryDir: string;
  /** The verified-only memory: the events kept and the ones withheld. */
  verified: { events: number; dropped: number };
  on: RunMeasures;
  off: RunMeasures;
  verdict: ProbeVerdict;
  label: RunLabel;
}

/** Runs the probe set with the memory of `memoryDir` and with its verified facts alone, and writes `probe.json`. */
export async function runProbe(input: ProbeInput): Promise<ProbeResult> {
  const run = input.run ?? runBench;
  const verifiedDir = join(input.dir, "verified");
  const verified = verifiedOnlyMemory(input.memoryDir, verifiedDir);
  const config: RunConfig = { ...input.config, seed: input.config.seed ?? "probe" };
  const arm = async (name: string, memoryFrom: string): Promise<RunMeasures> => {
    const dir = join(input.dir, name);
    const result = await run({ ...input.template, config, problems: input.problems, dir, memoryFrom });
    return measureRun(readEvents(join(dir, "journal.jsonl")), { report: result.report });
  };
  const on = await arm("on", input.memoryDir);
  const off = await arm("off", verifiedDir);
  const result: ProbeResult = { probeSet: input.problems.map((p) => p.id), memoryDir: input.memoryDir, verified, on, off, verdict: compareProbe(on, off, input.alpha), label: runLabel(config.model, ["The alarm's power is low at 20 problems: it needs four problems lost to the memory at alpha 0.1, so the absence of an alarm is not a clean bill."]) };
  writeFileSync(join(input.dir, "probe.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** The probe as markdown, for `harness report` (the alarm first when there is one). */
export function renderProbe(result: ProbeResult): string {
  const v = result.verdict;
  const out = [
    "## Memory probe",
    "",
    ...labelLines(result.label ?? runLabel("")),
    ...(v.alarm.solves || v.alarm.cost ? [`ALARM: the memory does worse than none beyond noise (alpha ${v.alpha}): ${v.alarm.reasons.join("; ")}.`, ""] : [`No alarm: the memory does not do worse than none beyond noise (alpha ${v.alpha}).`, ""]),
    `${v.problems} probe problem(s), none of which built the memory. Verified-only memory: ${result.verified.events} events kept, ${result.verified.dropped} withheld (attempts, lessons, stamped records, decisions).`,
    "",
    "| Memory | Solved | Spend ($) |",
    "|---|---|---|",
    `| on | ${v.on.solved}/${v.problems} | ${v.on.usd.toFixed(3)} |`,
    `| off (verified facts only) | ${v.off.solved}/${v.problems} | ${v.off.usd.toFixed(3)} |`,
    "",
    `Only with the memory: ${v.onlyOn.length}; only without: ${v.onlyOff.length}. Costlier with the memory on ${v.costlier} problems, cheaper on ${v.cheaper}.`,
    "",
  ];
  return out.join("\n");
}

export interface OverTimeRow {
  run: string;
  solved: number;
  problems: number;
  strategies: number;
  sources: number;
  /** The share of the budget spent on strategies never tried on that claim group. */
  novelShare: number;
  /** The share of proofs that use a library lemma or schema. */
  reuseShare: number;
}

/** The diversity metrics over a series of runs, in the order given (PE9 item 3). */
export function overTime(dirs: readonly string[]): OverTimeRow[] {
  return dirs.map((dir) => {
    const m = measureRun(readEvents(join(dir, "journal.jsonl")));
    return {
      run: dir,
      solved: m.solved,
      problems: m.problems,
      strategies: m.mechanisms.strategies,
      sources: m.mechanisms.sources,
      novelShare: m.novelStrategy.share,
      reuseShare: m.reuse.total === 0 ? 0 : m.reuse.count / m.reuse.total,
    };
  });
}

/** The ids of the problems the runs of a memory chain were given: what built the memory, which the probe must not use. */
export function problemsBuilt(dir: string): string[] {
  const ids = new Set<string>();
  for (const s of loadMemoryChain(dir, undefined).segments) for (const e of s.events) if (e.type === "problem.registered") ids.add(e.data.problemId);
  return [...ids].sort();
}

/** The place of a run in its memory chain, from 1: the run that starts on nothing is the first. */
export function runIndexOf(memoryFrom: string | undefined): number {
  return memoryFrom === undefined ? 1 : loadMemoryChain(memoryFrom, undefined).segments.length + 1;
}

/** Where a run's probe is written: a sibling of the run directory, so that a finished run, which other runs pin, is never added to. */
export function probeDirOf(runDir: string): string {
  const full = resolve(runDir);
  return join(dirname(full), `${basename(full)}.probe`);
}

/** The file that freezes a probe set the first time one is drawn. */
export const PROBE_SET_FILE = "set.txt";

/**
 * The probe set of a memory chain, frozen (PE9: a fixed set): the first probe draws it and writes it to `set.txt` beside its results; a later
 * probe of the same chain reads the newest `set.txt` among the probes of the chain's runs. A frozen set that names a problem the memory
 * was built on is refused, never redrawn. `fixed` (`--probe-set FILE`) wins over a drawn set.
 */
export function frozenProbeSet(memoryDir: string, out: string, problems: readonly ProblemEntry[], options: { size?: number; seed?: string; fixed?: readonly string[] } = {}): ProblemEntry[] {
  const built = problemsBuilt(memoryDir);
  if (options.fixed !== undefined) return chooseProbeSet(problems, { fixed: options.fixed, builtOn: built });
  const dirs = [out, ...loadMemoryChain(memoryDir, undefined).segments.map((s) => probeDirOf(s.dir))].reverse();
  for (const dir of dirs) {
    const file = join(dir, PROBE_SET_FILE);
    if (!existsSync(file)) continue;
    const ids = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return chooseProbeSet(problems, { fixed: ids, builtOn: built });
  }
  const set = chooseProbeSet(problems, { ...(options.size !== undefined ? { size: options.size } : {}), ...(options.seed !== undefined ? { seed: options.seed } : {}), builtOn: built });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, PROBE_SET_FILE), `${set.map((p) => p.id).join("\n")}\n`);
  return set;
}

/** The lines and options a run was started with, from its `run.started`: the probe tests the memory under them. */
export function linesOfRun(dir: string): { lines: string[]; lineOptions: Record<string, Record<string, Json>> } {
  const first = readEvents(join(dir, "journal.jsonl"))[0];
  const config = first?.type === "run.started" ? (first.data.config as { lines?: Array<{ id: string; options?: Record<string, Json> }> } | null) : null;
  const lines = config?.lines ?? [];
  return { lines: lines.map((l) => l.id), lineOptions: Object.fromEntries(lines.filter((l) => l.options !== undefined && Object.keys(l.options).length > 0).map((l) => [l.id, l.options as Record<string, Json>])) };
}
