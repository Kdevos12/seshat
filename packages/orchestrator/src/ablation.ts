import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProblemEntry } from "@seshat/bench";
import { BlobStore, hashJson, type Json, readEvents } from "@seshat/core";
import { cegisCounter } from "@seshat/induction";
import { type DecideSettings, checkDecideSettings } from "@seshat/decide";
import type { GateSettings } from "@seshat/scheduler";
import { ablationLines, isAblationName, type JsonObject, LINE_ORDER, type LineRegistry, resolveLines, SUSPENDED_LINES } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { LINES } from "./lines.ts";
import { type LabeledDecision, labelDecisions, reliability, type SiteReliability } from "./reliability.ts";
import { type RunLabel, runLabel } from "./run-label.ts";
import { signTest } from "./probe.ts";
import { refusalLine } from "./provider-errors.ts";
import { type Protocol, pairedProtocol } from "./protocol.ts";
import { measureRun, type RunMeasures } from "./measures.ts";
import { buildReport, type RunReport } from "./report.ts";
import { checkConfig, RunSetupError, runBench, type RunConfig, type RunOptions, type RunResult } from "./run.ts";
import { openForAnswers } from "./team.ts";
import { ablationRefusal } from "./turns.ts";
import { PACKET_MODES, type PacketMode } from "./session.ts";

/**
 * One configuration of an ablation table: what a run enables and sets, besides what every arm shares (the model, the budget, the
 * provers and sessions, the problems and the draw seed). The cumulative configurations of plan section 6 are arms that differ by
 * their lines; the experiments (documentation/ablate.md, "Experiments") are arms that differ by one option.
 */
export interface Arm {
  name: string;
  description: string;
  lines: string[];
  lineOptions?: Record<string, JsonObject>;
  packetMode?: PacketMode;
  decide?: DecideSettings;
  /** The budget gate of this arm (documentation/scheduler.md, "The budget gate"): its settings, `false` for none even when the table has one. Absent: the table's. */
  gate?: GateSettings | false;
  /** Another model than the table's. */
  model?: string;
  /** Direct capabilities besides `lean_check` (the table's, when absent). */
  tools?: string[];
  /** A candidate prompt in place of the merged one (`harness optimize-prompts` measures its candidates as arms; documentation/prompts.md). */
  prompts?: RunConfig["prompts"];
  /**
   * Other `RunConfig` fields of this arm, laid over the table's after everything above (additive; `lines`, `lineOptions`, `gate` and `tools`
   * have their own fields). The `solve-defaults` experiment puts the set's flags, the intake, `autoTool` and `leanSearch` here.
   */
  config?: Partial<Omit<RunConfig, "lines" | "lineOptions" | "gate" | "tools">>;
  /** The arm this one is compared with. Default: the arm before it in the table. */
  versus?: string;
}

/** The cumulative configurations: M0, then each line added in plan section 7's order, the suspended ones left out (Ruling 20). */
export function cumulativeNames(): string[] {
  return ["M0", ...LINE_ORDER.filter((id) => !SUSPENDED_LINES.has(id))];
}

/** The arms of the cumulative configurations named, or all of them. */
export function cumulativeArms(names: readonly string[] = cumulativeNames()): Arm[] {
  return names.map((name) => {
    if (!isAblationName(name)) throw new RunSetupError(`${JSON.stringify(name)} is not a cumulative configuration; they are M0 and the lines ${LINE_ORDER.filter((id) => !SUSPENDED_LINES.has(id)).join(", ")}`);
    return { name, description: name === "M0" ? "the baseline: lean_check only" : `M0 with every line up to ${name}, in plan section 7's order`, lines: ablationLines(name) };
  });
}

/** The run configuration of an arm: the table's, with the arm's lines and settings. */
export function armConfig(base: RunConfig, arm: Arm): RunConfig {
  const { lines: _lines, lineOptions: _options, packetMode: _mode, decide: _decide, tools: _tools, prompts: _prompts, gate: baseGate, ...shared } = base;
  const gate = arm.gate === undefined ? baseGate : arm.gate === false ? undefined : arm.gate;
  return {
    ...shared,
    ...(arm.config ?? {}),
    ...(arm.model !== undefined ? { model: arm.model } : {}),
    tools: arm.tools ?? base.tools,
    ...(arm.lines.length > 0 ? { lines: arm.lines } : {}),
    ...(arm.lineOptions !== undefined && Object.keys(arm.lineOptions).length > 0 ? { lineOptions: arm.lineOptions } : {}),
    ...(arm.packetMode !== undefined ? { packetMode: arm.packetMode } : {}),
    ...(arm.decide !== undefined ? { decide: arm.decide } : {}),
    ...(arm.prompts !== undefined ? { prompts: arm.prompts } : {}),
    ...(gate !== undefined ? { gate } : {}),
  };
}

/**
 * What stops an ablation before it spends anything: a turn limit or a human breakpoint (documentation/human.md: a turn boundary
 * changes what the models see, so the arms would no longer differ by their lines alone), a configuration a run would refuse, a
 * suspended or unknown line, an option a line does not have, two arms with one name.
 */
export function ablationProblems(base: RunConfig, arms: readonly Arm[], implemented: LineRegistry = LINES, options: { baseline?: string; target?: number } = {}): string[] {
  const problems: string[] = [];
  const refusal = ablationRefusal({ consortium: base.consortium });
  if (refusal !== undefined) problems.push(refusal);
  if (base.offpeak !== undefined) problems.push("--offpeak makes an arm wait for cheap hours, so the arms would no longer run under the same conditions: it cannot go with an ablation");
  const names = new Set<string>();
  for (const arm of arms) {
    if (names.has(arm.name)) problems.push(`two arms are named ${arm.name}`);
    names.add(arm.name);
    const resolved = resolveLines(arm.lines, implemented, arm.lineOptions ?? {});
    problems.push(...resolved.problems.map((p) => `arm ${arm.name}: ${p}`));
    problems.push(...checkConfig(armConfig(base, arm)).map((p) => `arm ${arm.name}: ${p}`));
    if (arm.packetMode !== undefined && !PACKET_MODES.includes(arm.packetMode)) problems.push(`arm ${arm.name}: unknown packet mode ${String(arm.packetMode)}`);
    problems.push(...checkDecideSettings(arm.decide).map((p) => `arm ${arm.name}: ${p}`));
  }
  if (options.target !== undefined && !(Number.isFinite(options.target) && options.target > 0)) problems.push(`--target is a ratio above 0, got ${options.target}`);
  if (options.baseline !== undefined && !names.has(options.baseline)) problems.push(`the baseline arm ${options.baseline} is not in the table`);
  for (const arm of arms) if (arm.versus !== undefined && !names.has(arm.versus)) problems.push(`arm ${arm.name} is compared with ${arm.versus}, which is not in the table`);
  return problems;
}

/** The problems of one difficulty tier, for one arm. */
export interface Tier {
  problems: number;
  solved: number;
  usd: number;
  usdPerSolve?: number;
}

/** How an arm compares with the arm it is set against (plan section 6: a mechanism that does not beat the line before it leaves or is simplified). */
export interface Comparison {
  against: string;
  /** Problems solved by this arm and not by the other, and the other way round (the pairs that a difference in totals hides). */
  onlyThis: string[];
  onlyThat: string[];
  deltaSolved: number;
  /** The problems both arms finished, which every number of the comparison is over. */
  common: number;
  /** The one-sided sign test of the larger of the two sets of problems in the pairs. */
  pSolves: number;
  /** `beats`: more problems solved, or as many and fewer dollars per solve; `not comparable`: the arms did not finish the same problems. */
  verdict: "beats" | "does not beat" | "not comparable";
  reason: string;
}

export interface ArmResult {
  arm: Arm;
  dir: string;
  runId: string;
  stopped?: string;
  measures: RunMeasures;
  decisions: LabeledDecision[];
  reliability: SiteReliability[];
  /**
   * The tiers by an outcome that no arm under comparison decides (`AblationResult.difficultyBasis`): `easy` holds the problems the basis solved,
   * `hard` the others. Absent for the basis arm itself, whose split is by construction, and when the table has no basis.
   */
  difficulty?: { easy: Tier; hard: Tier };
  comparison?: Comparison;
  /** The run on the build part of the bench, when the table splits it. */
  build?: { dir: string; runId: string; measures: RunMeasures };
}

export interface AblationResult {
  benchId: string;
  model: string;
  budget: RunConfig["budget"];
  provers: number;
  sessions: number;
  /** The problems the arms were measured on, and the ones the memory was built on when the bench was split. */
  problems: string[];
  buildProblems?: string[];
  /** Whether the model was simulated and what a real run has still to check; written into the table and the json. */
  label: RunLabel;
  /** What the difficulty tiers come from: `M0` (its row has no split), a pilot run, or absent when the table has neither. */
  difficultyBasis?: string;
  /** The paired protocol of plan change CA2 (documentation/ablate.md): intervals, dollars, the pairs against the baseline arm and the target. */
  protocol?: Protocol;
  /**
   * Set when an arm's run ended on a refusal of the model provider (a balance, a key): the arm that was refused and why, and the arms
   * that were not run. The comparison is not valid: `arms` holds only the arms that finished before it, and there is no protocol.
   */
  refusal?: { arm: string; reason: string; notRun: string[] };
  arms: ArmResult[];
}

export const SOLVED = new Set(["proved", "refuted", "candidate"]);

function tier(problems: ReadonlyArray<{ outcome: string; usd: number }>): Tier {
  const solved = problems.filter((p) => SOLVED.has(p.outcome)).length;
  const usd = problems.reduce((s, p) => s + p.usd, 0);
  return { problems: problems.length, solved, usd, ...(solved > 0 ? { usdPerSolve: usd / solved } : {}) };
}

/**
 * Splits an arm's problems by the outcomes of a basis that is not one of the arms compared: a split by the outcome of a compared arm would
 * make that arm solve every easy problem and no hard one by construction, and every other arm look worse on easy and better on hard.
 */
export function splitByDifficulty(arm: RunMeasures, basis: RunMeasures): { easy: Tier; hard: Tier } {
  const easy = new Set(basis.perProblem.filter((p) => SOLVED.has(p.outcome)).map((p) => p.problemId));
  return { easy: tier(arm.perProblem.filter((p) => easy.has(p.problemId))), hard: tier(arm.perProblem.filter((p) => !easy.has(p.problemId))) };
}

/**
 * Compares an arm with another on the problems both finished (an arm that stopped early has fewer). The sets of problems must be the same
 * for the verdict to be more than "not comparable". Paired: the problems only this arm solved against the ones only the other solved,
 * with the exact one-sided sign test of the difference; with few problems a difference of one is not evidence, so a verdict whose p is
 * above `alpha` says it is indicative only.
 */
export function compareArms(name: string, mine: Pick<RunMeasures, "perProblem">, other: { name: string; measures: Pick<RunMeasures, "perProblem"> }, alpha = 0.1): Comparison {
  const finished = (m: Pick<RunMeasures, "perProblem">) => new Map(m.perProblem.map((p) => [p.problemId, p]));
  const a = finished(mine);
  const b = finished(other.measures);
  const common = [...a.keys()].filter((id) => b.has(id)).sort();
  const sameSet = a.size === b.size && common.length === a.size;
  const isSolved = (m: Map<string, { outcome: string }>, id: string) => SOLVED.has((m.get(id) as { outcome: string }).outcome);
  const onlyThis = common.filter((id) => isSolved(a, id) && !isSolved(b, id));
  const onlyThat = common.filter((id) => !isSolved(a, id) && isSolved(b, id));
  const both = common.filter((id) => isSolved(a, id) && isSolved(b, id)).length;
  const solvedMine = both + onlyThis.length;
  const solvedOther = both + onlyThat.length;
  const spend = (m: Map<string, { usd: number }>) => common.reduce((sum, id) => sum + (m.get(id) as { usd: number }).usd, 0);
  const perSolve = (usd: number, solved: number) => (solved === 0 ? undefined : usd / solved);
  const mineUsd = perSolve(spend(a), solvedMine);
  const otherUsd = perSolve(spend(b), solvedOther);
  const dollars = (x: number | undefined) => (x === undefined ? "no solve" : `$${x.toFixed(3)} per solve`);
  const deltaSolved = solvedMine - solvedOther;
  const cheaper = mineUsd !== undefined && (otherUsd === undefined || mineUsd < otherUsd);
  const pSolves = signTest(Math.max(onlyThis.length, onlyThat.length), onlyThis.length + onlyThat.length);
  const base = { against: other.name, common: common.length, onlyThis, onlyThat, deltaSolved, pSolves };
  if (!sameSet) {
    return { ...base, verdict: "not comparable", reason: `${name} finished ${a.size} problems and ${other.name} ${b.size} (${common.length} in common): compared on the ${common.length} both finished, ${name} solves ${solvedMine} against ${solvedOther}, but a verdict on unequal sets is not given` };
  }
  const beats = deltaSolved > 0 || (deltaSolved === 0 && solvedMine > 0 && cheaper);
  const noise = deltaSolved !== 0 && !(deltaSolved > 0 && pSolves <= alpha) ? `; indicative only: ${onlyThis.length} against ${onlyThat.length} problems in the pairs, sign test p=${pSolves.toFixed(3)}` : "";
  return {
    ...base,
    verdict: beats ? "beats" : "does not beat",
    reason:
      (deltaSolved !== 0
        ? `${name} solves ${solvedMine} against ${solvedOther} of ${common.length} (${dollars(mineUsd)} against ${dollars(otherUsd)})`
        : `both solve ${solvedMine} of ${common.length}; ${dollars(mineUsd)} against ${dollars(otherUsd)}`) + noise,
  };
}

/** The counter of the counterexample set of a finished run (PD5), or undefined when its memory cannot be opened. */
export function cegisOfRun(dir: string) {
  try {
    const journal = openForAnswers(dir);
    try {
      return cegisCounter(new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }));
    } finally {
      journal.close();
    }
  } catch {
    return undefined;
  }
}

export interface AblationInput {
  /** What every run needs but the configuration and the problems: the bench's index and checkout, the models, the registry. */
  template: Omit<RunOptions, "config" | "dir" | "problems" | "runId" | "memoryFrom" | "turns">;
  config: RunConfig;
  problems: readonly ProblemEntry[];
  arms: readonly Arm[];
  dir: string;
  /** Splits the bench: each arm first runs on these problems, and then on `problems` starting from the memory the first run left (plan change PE9, item 2). */
  buildProblems?: readonly ProblemEntry[];
  /** Runs one run; default `runBench`. */
  run?: (options: RunOptions) => Promise<RunResult>;
  /** What a real run has still to check for this table (an experiment's own limits), besides what every table says. */
  notRun?: readonly string[];
  /** The outcomes of a pilot run, which the difficulty tiers come from. Default: the arm M0 when the table has one (its own row is not split). */
  pilot?: RunMeasures;
  /** The arm the protocol sets the others against (default: the first) and the ratio of problems solved per dollar it must reach (default 1.5). */
  baseline?: string;
  target?: number;
  log?: (line: string) => void;
}

/** Written in the directory of an arm when its runs have finished: what a second call of the same ablation recognises. */
const ARM_DONE = "done.json";

const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_");

/**
 * Runs the arms on the same problems at the same budget, one after the other, and measures each from its journal. The arms share the
 * draw seed (documentation/memory.md, "Randomized inclusion"), so that two arms that draw the same items draw them alike. A run
 * that stops early (the run budget, Lean down) is measured as it stands and says why.
 */
export async function runAblation(input: AblationInput): Promise<AblationResult> {
  const problems = ablationProblems(input.config, input.arms, LINES, { ...(input.baseline !== undefined ? { baseline: input.baseline } : {}), ...(input.target !== undefined ? { target: input.target } : {}) });
  if (problems.length > 0) throw new RunSetupError(`the ablation cannot start: ${problems.join("; ")}`);
  if (input.arms.length === 0) throw new RunSetupError("the ablation has no configuration to run");
  const run = input.run ?? runBench;
  const log = input.log ?? (() => undefined);
  mkdirSync(join(input.dir, "arms"), { recursive: true });
  const config: RunConfig = { ...input.config, seed: input.config.seed ?? "ablate" };
  const results: ArmResult[] = [];
  let refusal: AblationResult["refusal"];
  const identity = hashJson({ problems: input.problems.map((p) => p.id), build: input.buildProblems?.map((p) => p.id) ?? null, bench: input.template.index.benchId });
  for (const arm of input.arms) {
    const armDir = join(input.dir, "arms", slug(arm.name));
    const armRun = armConfig(config, arm);
    const marker = join(armDir, ARM_DONE);
    const fingerprint = hashJson({ identity, arm: armRun as unknown as Json });
    const measureDir = join(armDir, "measure");
    let finished: { runId: string; stopped?: string; providerRefusal?: string } | undefined;
    if (existsSync(armDir)) {
      // An arm that finished is taken as it stands, and nothing is spent on it again; a half-written one is set aside, never deleted.
      const done = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { fingerprint: string; runId: string; stopped?: string; providerRefusal?: string }) : undefined;
      if (done !== undefined && done.fingerprint === fingerprint) {
        finished = { runId: done.runId, ...(done.stopped !== undefined ? { stopped: done.stopped } : {}), ...(done.providerRefusal !== undefined ? { providerRefusal: done.providerRefusal } : {}) };
        log(`ablate: ${arm.name} finished in an earlier call: measured again from its journal, nothing spent`);
      } else if (done !== undefined) {
        throw new RunSetupError(`${armDir} holds a finished arm made with another configuration, other problems or another bench: an ablation resumes only its own; use a new directory`);
      } else {
        let n = 1;
        while (existsSync(`${armDir}.partial-${n}`)) n += 1;
        renameSync(armDir, `${armDir}.partial-${n}`);
        log(`ablate: ${arm.name} was cut off in an earlier call: its directory is set aside as ${basename(armDir)}.partial-${n} and the arm runs again`);
      }
    }
    let build: ArmResult["build"];
    let report: RunReport | undefined;
    if (finished === undefined) {
      log(`ablate: ${arm.name} (${arm.description})`);
      let memoryFrom: string | undefined;
      if (input.buildProblems !== undefined) {
        const buildDir = join(armDir, "build");
        const built = await run({ ...input.template, config: armRun, problems: input.buildProblems, dir: buildDir });
        if (built.providerRefusal !== undefined) {
          refusal = { arm: arm.name, reason: built.providerRefusal, notRun: input.arms.slice(input.arms.indexOf(arm) + 1).map((x) => x.name) };
          log(`ablate: ${refusalLine(built.providerRefusal)}; ${arm.name} and the arms after it are not run`);
          break;
        }
        memoryFrom = buildDir;
      }
      const result = await run({ ...input.template, config: armRun, problems: input.problems, dir: measureDir, ...(memoryFrom !== undefined ? { memoryFrom } : {}) });
      finished = { runId: result.runId, ...(result.stopped !== undefined ? { stopped: result.stopped } : {}), ...(result.providerRefusal !== undefined ? { providerRefusal: result.providerRefusal } : {}) };
      report = result.report;
      writeFileSync(marker, `${JSON.stringify({ fingerprint, ...finished })}\n`);
    }
    if (finished.providerRefusal !== undefined) {
      refusal = { arm: arm.name, reason: finished.providerRefusal, notRun: input.arms.slice(input.arms.indexOf(arm) + 1).map((x) => x.name) };
      log(`ablate: ${refusalLine(finished.providerRefusal)}; ${arm.name} is not measured and the arms after it are not run`);
      break;
    }
    const buildDir = join(armDir, "build");
    if (input.buildProblems !== undefined) {
      const buildEvents = readEvents(join(buildDir, "journal.jsonl"));
      build = { dir: buildDir, runId: (buildEvents[0] as { run: string }).run, measures: measureRun(buildEvents) };
    }
    const events = readEvents(join(measureDir, "journal.jsonl"));
    const cegis = cegisOfRun(measureDir);
    const measures = measureRun(events, { report: report ?? buildReport(events), ...(cegis !== undefined && cegis.dropped > 0 ? { cegis } : {}) });
    const decisions = labelDecisions(events);
    results.push({
      arm,
      dir: measureDir,
      runId: finished.runId,
      ...(finished.stopped !== undefined ? { stopped: finished.stopped } : {}),
      measures,
      decisions,
      reliability: reliability(decisions),
      ...(build !== undefined ? { build } : {}),
    });
    writeFileSync(join(input.dir, "ablation.partial.json"), `${JSON.stringify({ done: results.map((r) => ({ arm: r.arm.name, runId: r.runId, solved: r.measures.solved, usd: r.measures.usd })), remaining: input.arms.slice(results.length).map((x) => x.name) }, null, 2)}\n`);
  }
  const m0 = results.find((r) => r.arm.name === "M0");
  const basis = input.pilot ?? m0?.measures;
  const basisName = input.pilot !== undefined ? "a pilot run" : m0 !== undefined ? "M0" : undefined;
  results.forEach((r, i) => {
    if (basis !== undefined && !(input.pilot === undefined && r === m0)) r.difficulty = splitByDifficulty(r.measures, basis);
    const against = r.arm.versus !== undefined ? results.find((x) => x.arm.name === r.arm.versus) : results[i - 1];
    if (against !== undefined) r.comparison = compareArms(r.arm.name, r.measures, { name: against.arm.name, measures: against.measures });
  });
  const result: AblationResult = {
    benchId: input.template.index.benchId,
    label: runLabel(input.config.model, input.notRun),
    model: input.config.model,
    budget: input.config.budget,
    provers: input.config.provers,
    sessions: input.config.sessions,
    problems: input.problems.map((p) => p.id),
    ...(input.buildProblems !== undefined ? { buildProblems: input.buildProblems.map((p) => p.id) } : {}),
    ...(basisName !== undefined ? { difficultyBasis: basisName } : {}),
    ...(refusal === undefined ? { protocol: pairedProtocol(results.map((r) => ({ name: r.arm.name, measures: r.measures })), input.baseline, input.target) } : { refusal }),
    arms: results,
  };
  writeFileSync(join(input.dir, "ablation.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
