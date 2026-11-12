import { hostName } from "./implementations.ts";
import { studentHost } from "./solve-command.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProblemEntry, sample, stemOf } from "@seshat/bench";
import { readEvents, sha256Hex } from "@seshat/core";
import { type AblationInput, type AblationResult, type Arm, armConfig, cumulativeArms, cumulativeNames, runAblation } from "./ablation.ts";
import { renderAblation, renderChunks } from "./ablation-table.ts";
import { analyseChunks, attemptsByProver } from "./chunks.ts";
import { allLines, experiment, type ExperimentContext, experimentArms } from "./experiments.ts";
import { RunSetupError } from "./run.ts";
import { runLabel } from "./run-label.ts";

export const SPLIT_BY = ["none", "file", "stem"] as const;
export type SplitBy = (typeof SPLIT_BY)[number];

/**
 * Splits a bench for an ablation: about `build` problems to build the memory on, and the rest to measure on (plan change PE9, item 2).
 * With `by` "file" or "stem" the unit of the split is a file of the checkout or a problem with its variants, so that a lemma the library
 * learned on one problem is not measured on its own variant or a neighbour in the same file, which would be the optimistic measurement
 * the split exists to avoid. Units are taken in the order of a seeded hash until at least `build` problems are in the build part.
 */
export function splitBench(problems: readonly ProblemEntry[], build: number, seed: string, by: SplitBy = "none"): { build: ProblemEntry[]; measure: ProblemEntry[] } {
  if (!Number.isInteger(build) || build < 1 || build >= problems.length) throw new RunSetupError(`--split takes a number of problems to build the memory on, from 1 to ${problems.length - 1}, got ${build}`);
  if (by === "none") {
    const built = sample(problems, build, `${seed}\nsplit`);
    const ids = new Set(built.map((p) => p.id));
    return { build: built, measure: problems.filter((p) => !ids.has(p.id)) };
  }
  const key = (p: ProblemEntry): string => (by === "file" ? p.path : `${p.path}\u0000${stemOf(p.fullName)}`);
  const units = new Map<string, ProblemEntry[]>();
  for (const p of problems) units.set(key(p), [...(units.get(key(p)) ?? []), p]);
  const order = [...units.keys()].map((k) => ({ k, h: sha256Hex(`${seed}\nsplit\n${k}`) })).sort((x, y) => (x.h < y.h ? -1 : 1));
  const built: ProblemEntry[] = [];
  for (const { k } of order) {
    if (built.length >= build) break;
    built.push(...(units.get(k) as ProblemEntry[]));
  }
  const ids = new Set(built.map((p) => p.id));
  const measure = problems.filter((p) => !ids.has(p.id));
  if (measure.length === 0) throw new RunSetupError(`--split ${build} by ${by} leaves nothing to measure on: the problems fall in too few ${by === "file" ? "files" : "families of variants"}`);
  return { build: built, measure };
}

export interface AblateCommand extends Omit<AblationInput, "arms" | "buildProblems" | "problems"> {
  problems: readonly ProblemEntry[];
  /** The cumulative configurations, comma-separated names; default all of them. Ignored with an experiment. */
  configs?: readonly string[];
  experiment?: string;
  /** With an experiment: run only the arms with these names, in the experiment's order. Absent: every arm. */
  arms?: readonly string[];
  /** The lines an experiment's arms share; default every line. */
  lines?: readonly string[];
  models?: readonly string[];
  /** The host profile the arms that are what `solve` would do take their capabilities and check timeout from (`solve-defaults`). */
  host?: ExperimentContext["host"];
  /** The number of problems the memory is built on before the arms are measured on the others. */
  split?: number;
  splitBy?: SplitBy;
  print: (line: string) => void;
}

/** The arms a command asks for: the cumulative configurations, or the arms of one experiment. */
export function commandArms(command: Pick<AblateCommand, "configs" | "experiment" | "arms" | "lines" | "models" | "host">): Arm[] {
  if (command.arms !== undefined && command.experiment === undefined) throw new RunSetupError("--arms goes with --experiment");
  if (command.experiment !== undefined) {
    if (command.configs !== undefined) throw new RunSetupError("choose the configurations with --configs or an --experiment, not both");
    const all = experimentArms(command.experiment, { lines: [...(command.lines ?? allLines())], models: [...(command.models ?? [])], ...(command.host !== undefined ? { host: command.host } : {}) });
    if (command.arms === undefined) return all;
    const unknown = command.arms.filter((name) => !all.some((a) => a.name === name));
    if (unknown.length > 0) throw new RunSetupError(`unknown arm ${unknown.map((n) => JSON.stringify(n)).join(", ")} in experiment ${command.experiment}; its arms are ${all.map((a) => a.name).join(", ")}`);
    const chosen = all.filter((a) => (command.arms as readonly string[]).includes(a.name));
    // An arm whose `versus` arm is not chosen keeps running: the comparison falls back to the arm before it in the table, and to none for the first.
    return chosen.map((a) => {
      if (a.versus === undefined || chosen.some((x) => x.name === a.versus)) return a;
      const { versus: _dropped, ...rest } = a;
      return rest;
    });
  }
  if (command.lines !== undefined || command.models !== undefined) throw new RunSetupError("--lines and --models go with --experiment");
  return cumulativeArms(command.configs !== undefined && command.configs.length > 0 ? [...command.configs] : cumulativeNames());
}

/** `harness ablate`: runs the arms, writes `ablation.json` and `ablation.md` into the directory, prints the table. */
export async function ablateCommand(command: AblateCommand): Promise<AblationResult> {
  if (existsSync(join(command.dir, "ablation.json"))) throw new RunSetupError(`${command.dir} holds a finished ablation: write into a new directory (an ablation that was cut off is resumed by giving the same directory again)`);
  const arms = commandArms(command);
  // The audit's point (PA6): a run budget below sample x cap cuts the per-problem cap of the arm, so the arm is not measured at the cap it names.
  for (const arm of arms) {
    const { problemUsd, runUsd } = armConfig(command.config, arm).budget;
    if (runUsd !== undefined && runUsd < command.problems.length * problemUsd - 1e-9) {
      (command.log ?? command.print)(`warning: the run budget ($${runUsd}) is below ${command.problems.length} problem(s) x the cap of $${problemUsd} per problem for arm ${arm.name}: the run budget may cut the per-problem cap, and the arm is then not measured at the cap it names (documentation/ablate.md)`);
    }
  }
  const seed = String(command.config.seed ?? "ablate");
  const split = command.split !== undefined ? splitBench(command.problems, command.split, seed, command.splitBy) : undefined;
  mkdirSync(command.dir, { recursive: true });
  const result = await runAblation({
    ...(command.experiment !== undefined ? { notRun: [experiment(command.experiment).notRun] } : {}),
    template: command.template,
    config: command.config,
    problems: split?.measure ?? command.problems,
    ...(split !== undefined ? { buildProblems: split.build } : {}),
    arms,
    dir: command.dir,
    ...(command.run !== undefined ? { run: command.run } : {}),
    ...(command.baseline !== undefined ? { baseline: command.baseline } : {}),
    ...(command.target !== undefined ? { target: command.target } : {}),
    ...(command.pilot !== undefined ? { pilot: command.pilot } : {}),
    ...(command.log !== undefined ? { log: command.log } : {}),
  });
  const text = renderAblation(result);
  writeFileSync(join(command.dir, "ablation.md"), text);
  if (command.experiment !== undefined) command.print(`Experiment ${command.experiment} (${experiment(command.experiment).amendment}): ${experiment(command.experiment).description}\nNot run: ${experiment(command.experiment).notRun}\n`);
  command.print(text);
  return result;
}

/** `harness chunks RUN_DIR...`: the cost-to-first-success curves for K in 1, 3, 6 and 10, from the attempts the runs made. */
export function chunksCommand(dirs: readonly string[], print: (line: string) => void, options: { ks?: readonly number[]; budgetUsd?: number } = {}): void {
  if (dirs.length === 0) throw new RunSetupError("chunks needs a run directory");
  for (const dir of dirs) {
    const journal = join(dir, "journal.jsonl");
    if (!existsSync(journal)) throw new RunSetupError(`no journal in ${dir}`);
    const groups = attemptsByProver(readEvents(journal));
    if (groups.length === 0) throw new RunSetupError(`${dir} holds no attempt`);
    print(renderChunks(dir, analyseChunks(groups.map((g) => g.attempts), options), runLabel(modelOf(dir))));
  }
}

/** Reads a file of problem ids, one per line (the probe set, `--probe-set FILE`). */
export function readIdList(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** The model a run was configured with, from its `run.started`. */
function modelOf(dir: string): string {
  const first = readEvents(join(dir, "journal.jsonl"))[0];
  const config = first?.type === "run.started" ? (first.data.config as { model?: unknown } | null) : null;
  return typeof config?.model === "string" ? config.model : "";
}

/**
 * The host the arms of an ablation run on: the one named, `HARNESS_HOST`, then the default of the command (`hostName`: `local`), except for
 * `solve-defaults`, whose arms are what `solve` does and so take the host `solve` takes (`studentHost`: the isolated profile `doctor` wrote, when it exists).
 */
export function ablateHost(experiment: string | undefined, explicit: string | undefined, configDir?: string): string {
  return experiment === "solve-defaults" ? studentHost(explicit, configDir) : hostName(explicit);
}
