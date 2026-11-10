import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProblemEntry, sample, stemOf } from "@seshat/bench";
import { readEvents, sha256Hex } from "@seshat/core";
import { type AblationInput, type AblationResult, type Arm, cumulativeArms, cumulativeNames, runAblation } from "./ablation.ts";
import { renderAblation, renderChunks } from "./ablation-table.ts";
import { analyseChunks, attemptsByProver } from "./chunks.ts";
import { allLines, experiment, experimentArms } from "./experiments.ts";
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
  /** The lines an experiment's arms share; default every line. */
  lines?: readonly string[];
  models?: readonly string[];
  /** The number of problems the memory is built on before the arms are measured on the others. */
  split?: number;
  splitBy?: SplitBy;
  print: (line: string) => void;
}

/** The arms a command asks for: the cumulative configurations, or the arms of one experiment. */
export function commandArms(command: Pick<AblateCommand, "configs" | "experiment" | "lines" | "models">): Arm[] {
  if (command.experiment !== undefined) {
    if (command.configs !== undefined) throw new RunSetupError("choose the configurations with --configs or an --experiment, not both");
    return experimentArms(command.experiment, { lines: [...(command.lines ?? allLines())], models: [...(command.models ?? [])] });
  }
  if (command.lines !== undefined || command.models !== undefined) throw new RunSetupError("--lines and --models go with --experiment");
  return cumulativeArms(command.configs !== undefined && command.configs.length > 0 ? [...command.configs] : cumulativeNames());
}

/** `harness ablate`: runs the arms, writes `ablation.json` and `ablation.md` into the directory, prints the table. */
export async function ablateCommand(command: AblateCommand): Promise<AblationResult> {
  if (existsSync(join(command.dir, "ablation.json"))) throw new RunSetupError(`${command.dir} holds a finished ablation: write into a new directory (an ablation that was cut off is resumed by giving the same directory again)`);
  const arms = commandArms(command);
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
