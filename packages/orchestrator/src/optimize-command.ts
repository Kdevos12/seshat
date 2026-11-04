import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type { ProblemEntry } from "@seshat/bench";
import { budgetClassOf, hashJson, type HarnessEvent, type Json, readEvents, sha256Hex } from "@seshat/core";
import { type AblationInput, runAblation } from "./ablation.ts";
import { messageCost } from "./budget.ts";
import { estimateUsd, type Evaluate, type Evaluation, optimizationSplits, optimize, type OptimizationResult, type Reflect, type Score } from "./optimize.ts";
import { patchFor, ProposalWriter, renderOptimization } from "./optimize-output.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import { type PromptTarget, promptTarget, screenPrompt, targetProblems } from "./prompt-screen.ts";
import { runLabel } from "./run-label.ts";
import { resolveModel, RunSetupError, type RunConfig } from "./run.ts";

const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_");

/** What a prover did on a problem, as text the rewriting model reads: the attempts and what Lean said last (documentation/prompts.md). */
export function feedbackOf(events: readonly HarnessEvent[], problems: readonly ProblemEntry[]): Record<string, string> {
  const claimOf = new Map<string, string>();
  for (const e of events) if (e.type === "problem.registered") claimOf.set(e.data.problemId, e.data.claimId);
  const attempts = new Map<string, { n: number; stops: Set<string>; turns: number }>();
  const attemptClaim = new Map<string, string>();
  const complaints = new Map<string, string[]>();
  for (const e of events) {
    if (e.type === "attempt.started") attemptClaim.set(e.data.attemptId, e.data.claimId);
    if (e.type === "attempt.finished") {
      const claim = attemptClaim.get(e.data.attemptId);
      if (claim === undefined) continue;
      const a = attempts.get(claim) ?? { n: 0, stops: new Set<string>(), turns: 0 };
      a.n += 1;
      a.stops.add(e.data.stoppedBy ?? "unrecorded");
      a.turns += e.data.turns;
      attempts.set(claim, a);
    }
    if (e.type === "validation.finished" && e.data.verdict === "invalid") {
      const list = complaints.get(e.data.claimId) ?? [];
      for (const reason of e.data.reasons) list.push(reason.replace(/\s+/g, " ").trim().slice(0, 240));
      complaints.set(e.data.claimId, list);
    }
  }
  return Object.fromEntries(
    problems.map((p) => {
      const claim = claimOf.get(p.id);
      const a = claim === undefined ? undefined : attempts.get(claim);
      const said = [...new Set(claim === undefined ? [] : (complaints.get(claim) ?? []))].slice(-3);
      const head = a === undefined ? "No attempt was recorded." : `${a.n} attempt${a.n === 1 ? "" : "s"}, ${a.turns} turns, stopped by ${[...a.stops].join(", ")}.`;
      return [p.id, said.length === 0 ? head : `${head} Lean's last complaints:\n${said.map((s) => `- ${s}`).join("\n")}`];
    }),
  );
}

export interface EvaluatorInput {
  template: AblationInput["template"];
  config: RunConfig;
  dir: string;
  run?: AblationInput["run"];
  log?: (line: string) => void;
}

/**
 * The default evaluation: one `harness ablate` arm, the baseline configuration with the candidate prompt, run on the problems at the budget of
 * the command. Its journals and its table are under `work/LABEL`, and its scores and feedback are read from the journal.
 */
export function ablationEvaluator(input: EvaluatorInput): Evaluate {
  return async ({ label, template, problems }): Promise<Evaluation> => {
    const dir = join(input.dir, "work", slug(label));
    const result = await runAblation({
      template: input.template,
      config: input.config,
      problems,
      arms: [{ name: slug(label), description: template === undefined ? "the merged prompt" : "a candidate prompt", lines: [], ...(template !== undefined ? { prompts: { proverSystem: template } } : {}) }],
      dir,
      ...(input.run !== undefined ? { run: input.run } : {}),
      ...(input.log !== undefined ? { log: input.log } : {}),
    });
    const arm = result.arms[0];
    if (arm === undefined) throw new RunSetupError(`the measurement ${label} produced no arm`);
    const scores: Score[] = arm.measures.perProblem.map((p) => ({ problemId: p.problemId, outcome: p.outcome, usd: p.usd }));
    return { scores, feedback: feedbackOf(readEvents(join(arm.dir, "journal.jsonl")), problems), dir };
  };
}

/** The rewriting model: one call per iteration, charged by the model's prices; its answer is text, screened by the caller. */
export function modelReflector(o: { models: Models; model: string; thinkingLevel: ThinkingLevel; signal?: AbortSignal }): Reflect {
  return async ({ system, prompt }) => {
    const model = await resolveModel(o.models, o.model);
    const message = await o.models.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { ...(o.signal !== undefined ? { signal: o.signal } : {}), ...(o.thinkingLevel !== "off" ? { reasoning: o.thinkingLevel as never } : {}) },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `the model's answer was ${message.stopReason}`);
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    return { text, usd: messageCost(model, message).usd };
  };
}

/** The date a file was first committed in a checkout, by problem: the best date the bench has of when a problem entered it. */
export function gitDates(checkout: string, problems: readonly ProblemEntry[]): Map<string, string> {
  const byPath = new Map<string, string | undefined>();
  const dateOfPath = (path: string): string | undefined => {
    if (!byPath.has(path)) {
      let found: string | undefined;
      try {
        const out = execFileSync("git", ["-C", checkout, "log", "--follow", "--diff-filter=A", "--format=%aI", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        found = out.split("\n").filter((l) => l !== "").pop();
      } catch {
        found = undefined;
      }
      byPath.set(path, found);
    }
    return byPath.get(path);
  };
  const dates = new Map<string, string>();
  for (const p of problems) {
    const d = dateOfPath(p.path);
    if (d !== undefined) dates.set(p.id, d);
  }
  return dates;
}

/** Dates from a file: a JSON object of problem id to ISO 8601 date (`--dates FILE`). */
export function readDates(path: string): Map<string, string> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RunSetupError(`${path}: expected a JSON object of problem id to date`);
  const entries = Object.entries(value as Record<string, unknown>);
  const bad = entries.filter(([, d]) => typeof d !== "string" || Number.isNaN(Date.parse(d))).map(([id]) => id);
  if (bad.length > 0) throw new RunSetupError(`${path}: not an ISO 8601 date for ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""}`);
  return new Map(entries as Array<[string, string]>);
}

/** One optimization that reached its gate: which problems it measured the held-out and temporal splits on. */
export interface LedgerEntry {
  at: string;
  benchId: string;
  out: string;
  problems: string[];
}

function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new RunSetupError(`${path}: expected a list of optimizations`);
  return value as LedgerEntry[];
}

export interface OptimizeCommand {
  template: AblationInput["template"];
  config: RunConfig;
  problems: readonly ProblemEntry[];
  /** The proposals directory. */
  dir: string;
  /** The repository this harness runs from: where the prompt files are, and the trees the command does not write to. */
  repoRoot: string;
  cutoff: string;
  dates: ReadonlyMap<string, string>;
  /** The split the search runs on; only `dev` (the other splits are never searched). */
  split?: string;
  target?: string;
  /** The rewriting model (`PROVIDER/ID`); default the run's model. */
  reflectorModel?: string;
  iterations?: number;
  minibatch?: number;
  finalists?: number;
  reflectBudgetUsd?: number;
  /** The most the whole optimization may spend (required): the measurements as the journals count them, and the rewriting model. */
  maxUsd: number;
  /** Go on with a model that has no price, whose dollars no cap can see (default: refused). */
  allowUnpriced?: boolean;
  /** The level of the sign test before the correction for the finalists (default 0.1). */
  alpha?: number;
  /** Fewest problems in the held-out split and in the temporal holdout (default 8): a smaller split cannot show a significant gain. */
  minGateProblems?: number;
  /** The file that records which problems earlier optimizations gated on (default `proposals/gate-ledger.json` of the repository). */
  ledger?: string;
  /** Go on although a problem of the gate splits was used by an earlier optimization: the report says so. */
  reuseGates?: boolean;
  /** Injected for tests: the rewriting model, and the run of one measurement. */
  reflect?: Reflect;
  run?: AblationInput["run"];
  now?: () => Date;
  log?: (line: string) => void;
  print: (line: string) => void;
}

/**
 * `harness optimize-prompts`: splits the bench, searches for better prompts on dev, gates the best on the held-out split and the temporal
 * holdout, and writes the candidates, their evidence and, for the accepted ones, a patch into the proposals directory (documentation/prompts.md).
 * It changes no prompt.
 */
export async function optimizePromptsCommand(command: OptimizeCommand): Promise<OptimizationResult> {
  if ((command.split ?? "dev") !== "dev") throw new RunSetupError(`--split takes dev: the search runs on the dev split only, and the held-out and temporal splits are measured once, at the end, and never searched (got ${command.split})`);
  const target: PromptTarget = promptTarget(command.target ?? "prover.system");
  const wrong = targetProblems(target);
  if (wrong.length > 0) throw new RunSetupError(wrong.join("; "));
  if (screenPrompt(target.current, target).length > 0) throw new RunSetupError(`the merged ${target.id} does not pass its own screen`);
  const writer = new ProposalWriter(command.dir, command.repoRoot);
  if (existsSync(join(command.dir, "report.md"))) throw new RunSetupError(`${command.dir} holds a finished optimization: write into a new directory`);
  const seed = String(command.config.seed ?? "optimize");
  const splits = optimizationSplits(command.problems, command.dates, { cutoff: command.cutoff, seed });
  if (!(command.maxUsd > 0) || !Number.isFinite(command.maxUsd)) throw new RunSetupError(`the optimization needs a cap on its total spend in dollars (--max-usd), a positive number, got ${String(command.maxUsd)}`);
  // A model with no price is charged $0, so no cap can see what it costs: refused unless asked for.
  for (const name of new Set([command.config.model, command.reflectorModel ?? command.config.model])) {
    const slash = name.indexOf("/");
    const known = slash > 0 ? command.template.models.getModel(name.slice(0, slash), name.slice(slash + 1)) : undefined;
    if (known !== undefined && !(known.cost.input > 0 || known.cost.output > 0) && command.allowUnpriced !== true) {
      throw new RunSetupError(`${name} has no price in pi-ai, so its responses would be charged $0 and --max-usd could not stop it: give it a price, or go on with --allow-unpriced`);
    }
  }
  const minGate = command.minGateProblems ?? 8;
  for (const [name, list] of [["held-out", splits.heldout], ["temporal", splits.temporal]] as const) {
    if (list.length < minGate) throw new RunSetupError(`the ${name} split has ${list.length} problems, fewer than the ${minGate} a gate needs to show a significant gain: choose more problems (--sample), another --cutoff, or lower --min-gate-problems knowing that no gain will be significant`);
  }
  const ledgerPath = command.ledger ?? join(command.repoRoot, "proposals", "gate-ledger.json");
  const ledger = readLedger(ledgerPath);
  const gateIds = new Set([...splits.heldout, ...splits.temporal].map((p) => `${command.template.index.benchId}\u0000${p.id}`));
  const spentBefore = ledger.filter((e) => e.out !== command.dir && e.problems.some((id) => gateIds.has(`${e.benchId}\u0000${id}`))).map((e) => `${e.at.slice(0, 10)} (${e.out})`);
  if (spentBefore.length > 0 && command.reuseGates !== true) {
    throw new RunSetupError(`problems of the held-out or temporal split were already used as a gate by ${spentBefore.join("; ")}: each reuse selects on the gate a little more. Choose other problems, or go on with --reuse-gates (the report says so)`);
  }
  const reflectorModel = command.reflectorModel ?? command.config.model;
  const reflectBudget = command.reflectBudgetUsd ?? 2;
  const estimate = estimateUsd({
    dev: splits.dev.length, heldout: splits.heldout.length, temporal: splits.temporal.length, iterations: command.iterations ?? 8,
    finalists: command.finalists ?? 2, problemUsd: command.config.budget.problemUsd, reflectBudgetUsd: reflectBudget,
  });
  if (estimate.minimum > command.maxUsd) {
    throw new RunSetupError(`the cheapest useful plan (the merged prompt on dev and one rewrite measured on it) could cost $${estimate.minimum.toFixed(2)} at ${command.config.budget.problemUsd} dollars per problem, more than --max-usd ${command.maxUsd}: raise the cap, lower --budget-usd, or choose fewer problems`);
  }
  const log = command.log ?? (() => undefined);
  log(`optimize-prompts: cost at most $${estimate.maximum.toFixed(2)} if every problem of every measurement spends its whole budget; the cap is $${command.maxUsd.toFixed(2)}${estimate.maximum > command.maxUsd ? " (the run stops at the cap and still writes its report)" : ""}`);
  log(`optimize-prompts: ${splits.dev.length} dev, ${splits.heldout.length} held-out and ${splits.temporal.length} temporal problems (newer than ${splits.cutoff})`);
  const rawReflect = command.reflect ?? modelReflector({ models: command.template.models, model: reflectorModel, thinkingLevel: command.config.thinkingLevel, ...(command.template.signal !== undefined ? { signal: command.template.signal } : {}) });
  // A cut-off optimization goes on from what it recorded: each answer of the rewriting model is kept as it comes, the measurements that finished
  // are kept by the ablation runner, and the search, which is seeded, replays to the same place (documentation/prompts.md, "Resuming").
  const identity = hashJson({
    target: target.id, seed, cutoff: splits.cutoff, bench: command.template.index.benchId, reflectorModel, model: command.config.model,
    dev: splits.dev.map((p) => p.id), heldout: splits.heldout.map((p) => p.id), temporal: splits.temporal.map((p) => p.id),
    iterations: command.iterations ?? 8, minibatch: command.minibatch ?? 3, finalists: command.finalists ?? 2,
  });
  const partialPath = join(command.dir, "optimization.partial.json");
  let recorded: Array<{ text: string; usd: number } | { error: string }> = [];
  if (existsSync(partialPath)) {
    const partial = JSON.parse(readFileSync(partialPath, "utf8")) as { identity: string; reflections: typeof recorded };
    if (partial.identity !== identity) throw new RunSetupError(`${command.dir} holds a cut-off optimization made with other problems, seed, cutoff, models or plan: resume it with the same arguments, or use a new directory (its measurements are in ${join(command.dir, "work")})`);
    recorded = partial.reflections;
    log(`optimize-prompts: resuming a cut-off optimization: ${recorded.length} rewrite${recorded.length === 1 ? "" : "s"} replayed, finished measurements are not run again`);
  }
  let calls = 0;
  const reflect: Reflect = async (request) => {
    const index = calls;
    calls += 1;
    const had = recorded[index];
    if (had !== undefined) {
      if ("error" in had) throw new Error(had.error);
      return had;
    }
    try {
      const answer = await rawReflect(request);
      recorded.push({ text: answer.text, usd: answer.usd });
      return answer;
    } catch (error) {
      // An answer cut off by Ctrl-C is not an answer: it is asked again when the optimization resumes.
      if (command.template.signal?.aborted !== true) recorded.push({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      writer.write("optimization.partial.json", `${JSON.stringify({ identity, reflections: recorded }, null, 2)}\n`);
    }
  };
  const result = await optimize({
    target,
    splits,
    evaluate: ablationEvaluator({ template: command.template, config: command.config, dir: command.dir, ...(command.run !== undefined ? { run: command.run } : {}), log }),
    reflect,
    provenance: {
      modelId: reflectorModel,
      promptVersion: PROMPT_VERSION,
      mathlibRev: command.template.index.source.rev,
      harnessVersion: command.template.codeRev ?? "unknown",
      budgetClass: budgetClassOf(command.config.budget.problemUsd),
    },
    seed,
    ...(command.iterations !== undefined ? { iterations: command.iterations } : {}),
    ...(command.minibatch !== undefined ? { minibatch: command.minibatch } : {}),
    ...(command.finalists !== undefined ? { finalists: command.finalists } : {}),
    ...(command.reflectBudgetUsd !== undefined ? { reflectBudgetUsd: command.reflectBudgetUsd } : {}),
    maxUsd: command.maxUsd,
    problemUsd: command.config.budget.problemUsd,
    ...(command.alpha !== undefined ? { alpha: command.alpha } : {}),
    beforeGate: () => {
      // From here the gate is spent, whether or not the run finishes.
      const entry: LedgerEntry = { at: (command.now ?? (() => new Date()))().toISOString(), benchId: command.template.index.benchId, out: command.dir, problems: [...splits.heldout, ...splits.temporal].map((p) => p.id) };
      new ProposalWriter(dirname(ledgerPath), command.repoRoot).write(basename(ledgerPath), `${JSON.stringify([...ledger.filter((e) => e.out !== entry.out), entry], null, 2)}\n`);
    },
    ...(command.now !== undefined ? { now: command.now } : {}),
    log,
  });
  const label = runLabel(command.config.model, [
    "The rewriting and the measurements ran on the models named above; whether a prompt that wins here wins on the real bench with a real Lean is what the first real run checks.",
    "The date of a problem is the date its file entered the checkout, or the date --dates gives: a file that gathers problems of several dates is dated by the first.",
  ]);
  const finalists = new Map(result.finalists.map((f) => [f.candidate.id, f]));
  for (const c of result.front.members.filter((m) => m !== result.baseline)) {
    const f = finalists.get(c.id);
    const dev = result.baseline.scores.size;
    writer.write(join("candidates", c.id, "prompt.txt"), `${c.text}\n`);
    writer.write(
      join("candidates", c.id, "evidence.json"),
      `${JSON.stringify(
        {
          candidate: c.id,
          target: target.id,
          parent: c.parent,
          generation: c.generation,
          provenance: c.provenance,
          promptSha256: sha256Hex(c.text),
          dev: { problems: dev, scores: [...c.scores.values()], baseline: [...result.baseline.scores.values()] },
          status: f === undefined ? "pareto only: not measured on the held-out split or the temporal holdout" : f.status.replace("_", " "),
          gates: f?.gates ?? [],
          label,
        } as unknown as Json,
        null,
        2,
      )}\n`,
    );
    if (f !== undefined && f.status !== "rejected") writer.write(join("candidates", c.id, f.status === "accepted" ? `${target.id}.patch` : `${target.id}.needs-review.patch`), patchFor(target, c.text, command.repoRoot));
  }
  writer.write(
    "optimization.json",
    `${JSON.stringify({ target: target.id, seed, cutoff: splits.cutoff, splits: { dev: splits.dev.map((p) => p.id), heldout: splits.heldout.map((p) => p.id), temporal: splits.temporal.map((p) => p.id), undated: splits.undated, leaked: splits.leaked }, trials: result.trials, reflectUsd: result.reflectUsd, spentUsd: result.spentUsd, maxUsd: command.maxUsd, estimate, stoppedBy: result.stoppedBy ?? null, baselineDirs: result.baselineDirs, finalists: result.finalists.map((f) => ({ candidate: f.candidate.id, status: f.status, accepted: f.accepted, dev: f.dev, gates: f.gates })), label }, null, 2)}\n`,
  );
  const text = renderOptimization(result, { label, model: command.config.model, reflectorModel, target, splits, budget: { problemUsd: command.config.budget.problemUsd }, proposalsDir: command.dir, promptVersion: PROMPT_VERSION, alpha: command.alpha ?? 0.1, spentBefore, maxUsd: command.maxUsd, estimate });
  writer.write("report.md", text);
  command.print(text);
  return result;
}
