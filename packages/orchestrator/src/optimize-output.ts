import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Candidate, type Finalist, type OptimizationResult, type OptimizationSplits, totals } from "./optimize.ts";
import { type PromptTarget, screenPrompt, targetProblems } from "./prompt-screen.ts";
import { labelLines, type RunLabel } from "./run-label.ts";
import { RunSetupError } from "./run.ts";

/**
 * The trees of the repository that `harness optimize-prompts` has no write access to: the code (the validator, the guards, the journal and its
 * tests, in `packages`), the Lean files, the bench and its indexes, the capabilities and the configuration, the plans and the documentation.
 * The command writes into one proposals directory, which may be inside the repository but not inside one of these.
 */
export const PROTECTED_TREES: readonly string[] = ["packages", "lean", "bench", "capabilities", "config", "plans", "documentation", ".git", "node_modules"];

/** What a proposals directory may hold: text, json, markdown and patches. */
const WRITABLE = new Set([".txt", ".json", ".md", ".patch"]);

/**
 * The only way the optimization writes a file of its own. It refuses a directory inside a protected tree of the repository, or one that holds
 * the repository (or any protected tree), and every write outside the directory, through `..` or a symbolic link, or of a kind of file that is
 * not text, json, markdown or a patch. The runs that measure candidates write their journals under `work/` through the ablation runner, as
 * `harness ablate` does; they are not written here.
 */
export class ProposalWriter {
  readonly dir: string;
  private readonly root: string;

  constructor(dir: string, repoRoot: string) {
    this.dir = resolve(dir);
    this.root = resolve(repoRoot);
    for (const tree of PROTECTED_TREES) {
      const protectedDir = join(this.root, tree);
      const inside = relative(protectedDir, this.dir);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
        throw new RunSetupError(`${dir} is inside ${tree}/, which the optimization has no write access to: propose into a directory such as proposals/ (it writes prompt candidates and patches, and nothing else)`);
      }
      const above = relative(this.dir, protectedDir);
      if (!above.startsWith("..") && !isAbsolute(above)) {
        throw new RunSetupError(`${dir} holds ${tree}/ of the repository, which the optimization has no write access to: propose into a directory that does not`);
      }
    }
  }

  /** Writes `content` at `path` below the directory. Returns the full path. */
  write(path: string, content: string): string {
    const full = resolve(this.dir, path);
    const inside = relative(this.dir, full);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new RunSetupError(`${path} is outside the proposals directory ${this.dir}`);
    if (!WRITABLE.has(extname(full))) throw new RunSetupError(`${path}: the optimization writes text, json, markdown and patches, and nothing else`);
    mkdirSync(dirname(full), { recursive: true });
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new RunSetupError(`${path} is a symbolic link`);
    const real = realpathSync(dirname(full));
    const base = realpathSync(this.dir);
    if (real !== base && !real.startsWith(base + sep)) throw new RunSetupError(`${path} leaves the proposals directory through a symbolic link`);
    writeFileSync(full, content);
    return full;
  }
}

/** An edit script between two lists of lines: ` ` kept, `-` removed, `+` added. */
function editScript(a: readonly string[], b: readonly string[]): Array<[" " | "-" | "+", string]> {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Array<[" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([" ", a[i] as string]); i += 1; j += 1; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push(["-", a[i] as string]); i += 1; }
    else { out.push(["+", b[j] as string]); j += 1; }
  }
  while (i < n) { out.push(["-", a[i] as string]); i += 1; }
  while (j < m) { out.push(["+", b[j] as string]); j += 1; }
  return out;
}

/** A unified diff, in the form `git apply` reads, between two texts of the file at `file`. Empty when they are the same. */
export function unifiedPatch(file: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const script = editScript(lines(before), lines(after));
  const changed = script.flatMap(([op], k) => (op === " " ? [] : [k]));
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const from = Math.max(0, k - context);
    const to = Math.min(script.length, k + context + 1);
    const last = hunks[hunks.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const body = hunks.map(([from, to]) => {
    const slice = script.slice(from, to);
    const oldStart = script.slice(0, from).filter(([op]) => op !== "+").length + 1;
    const newStart = script.slice(0, from).filter(([op]) => op !== "-").length + 1;
    const oldCount = slice.filter(([op]) => op !== "+").length;
    const newCount = slice.filter(([op]) => op !== "-").length;
    return [`@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`, ...slice.map(([op, text]) => `${op}${text}`)].join("\n");
  });
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n") + "\n";
}

/**
 * The patch that makes `candidate` the text of the target's prompt file, against the file as the checkout holds it. The target must be a prompt
 * file, the candidate must pass the screen again (it was model-derived text, and it is written now), and the file must still say what the
 * optimization started from; otherwise nothing is proposed.
 */
export function patchFor(target: PromptTarget, candidate: string, repoRoot: string): string {
  const problems = targetProblems(target);
  if (problems.length > 0) throw new RunSetupError(problems.join("; "));
  const reasons = screenPrompt(candidate, target);
  if (reasons.length > 0) throw new RunSetupError(`candidate for ${target.id} no longer passes the strict screen: ${reasons.join("; ")}`);
  const path = join(repoRoot, target.file);
  const before = readFileSync(path, "utf8");
  if (before.replace(/\n$/, "") !== target.current) throw new RunSetupError(`${target.file} in ${repoRoot} is not the text the optimization started from: a patch against it would not mean what was measured`);
  return unifiedPatch(target.file, before, `${candidate}\n`);
}

const usd = (x: number) => `$${x.toFixed(3)}`;

export interface ReportMeta {
  label: RunLabel;
  model: string;
  reflectorModel: string;
  target: PromptTarget;
  splits: OptimizationSplits;
  budget: { problemUsd: number };
  /** Where the proposals are, for the merge instructions. */
  proposalsDir: string;
  promptVersion: string;
}

function verdictLine(f: Finalist): string {
  return f.accepted ? "accepted: beats the merged prompt on the held-out split and on the temporal holdout" : "not accepted";
}

/** The report of an optimization, as markdown: the splits, the search, the Pareto set, and each finalist against the merged prompt. */
export function renderOptimization(result: OptimizationResult, meta: ReportMeta): string {
  const dev = meta.splits.dev.map((p) => p.id);
  const lines: string[] = [
    `# Prompt optimization: ${result.target}`,
    "",
    ...labelLines(meta.label),
    `Prover model ${meta.model}, rewriting model ${meta.reflectorModel}, ${usd(meta.budget.problemUsd)} per problem for every measurement. Seed ${result.seed}. Prompt version of the merged prompt: ${meta.promptVersion}.`,
    "",
    "## Splits",
    "",
    "| Split | Problems | Used for |",
    "|---|---|---|",
    `| dev | ${meta.splits.dev.length} | the rewriting and the selection of the Pareto set |`,
    `| held-out | ${meta.splits.heldout.length} | the gate: older problems the search never saw |`,
    `| temporal | ${meta.splits.temporal.length} | the gate: problems newer than ${meta.splits.cutoff} |`,
    "",
    ...(meta.splits.undated > 0 ? [`${meta.splits.undated} problem(s) had no known date and count as older. `] : []),
    ...(meta.splits.leaked.length > 0 ? [`${meta.splits.leaked.length} newer problem(s) were left out of the temporal split because a problem of their family is in the older part: ${meta.splits.leaked.join(", ")}.`, ""] : []),
    "## The search",
    "",
    `${result.trials.length} iteration(s); the rewriting model cost ${usd(result.reflectUsd)}.${result.stoppedBy !== undefined ? ` Stopped early: ${result.stoppedBy}.` : ""}`,
    "",
    "| Iteration | Parent | Outcome | Child | Minibatch (parent, child) | Why |",
    "|---|---|---|---|---|---|",
    ...result.trials.map((t) =>
      `| ${t.iteration} | ${t.parent} | ${t.status.replace(/_/g, " ")} | ${t.child ?? ""} | ${t.parentBatch !== undefined && t.childBatch !== undefined ? `${t.parentBatch.solved} solved ${usd(t.parentBatch.usd)}, ${t.childBatch.solved} solved ${usd(t.childBatch.usd)}` : ""} | ${(t.reasons ?? []).join("; ").replace(/\|/g, "/")} |`,
    ),
    "",
    "## Pareto set on dev",
    "",
    `The merged prompt (c0) solves ${totals(result.baseline, dev).solved} of ${dev.length} dev problems for ${usd(totals(result.baseline, dev).usd)}. A member is the best prompt on at least one problem and dominated by no other.`,
    "",
    "| Candidate | From | Solved | Dollars | Best on |",
    "|---|---|---|---|---|",
    ...result.front.members.map((c: Candidate) => `| ${c.id} | ${c.parent ?? "the merged prompt"} | ${totals(c, dev).solved} of ${dev.length} | ${usd(totals(c, dev).usd)} | ${(result.front.leads.get(c.id) ?? []).length} problem(s) |`),
    "",
    "## Finalists against the merged prompt",
    "",
  ];
  if (result.finalists.length === 0) {
    lines.push("No candidate beat the merged prompt on dev, so none was measured on the held-out split or the temporal holdout. Nothing is proposed.", "");
  }
  for (const f of result.finalists) {
    lines.push(`### ${f.candidate.id}: ${verdictLine(f)}`, "", `Dev: ${f.dev.solved} of ${dev.length} solved for ${usd(f.dev.usd)}.`, "", "| Split | Problems | Merged prompt | Candidate | Verdict | Detail |", "|---|---|---|---|---|---|");
    for (const g of f.gates) {
      lines.push(`| ${g.split} | ${g.problems} | ${g.baseline.solved} solved ${usd(g.baseline.usd)} | ${g.candidate.solved} solved ${usd(g.candidate.usd)} | ${g.accepted ? "beats" : "does not beat"} | ${g.note.replace(/\|/g, "/")} |`);
    }
    lines.push("");
  }
  const accepted = result.finalists.filter((f) => f.accepted);
  lines.push(
    "## What a person does",
    "",
    accepted.length === 0
      ? "Nothing was accepted. The prompt is unchanged, and no patch was written."
      : [
          `Accepted: ${accepted.map((f) => f.candidate.id).join(", ")}. Each has a patch under \`candidates/ID/\`. The optimization changed no prompt: nothing changes until a person merges one.`,
          "",
          "```sh",
          "git checkout -b prompts/PROPOSAL",
          `git apply ${meta.proposalsDir}/candidates/ID/${meta.target.id}.patch`,
          "# bump PROMPT_VERSION in packages/orchestrator/src/prompt.ts, read the new text, then:",
          "pnpm check",
          "```",
          "",
          "Read the whole new prompt before merging, not the numbers alone. A gain the sign test calls indicative only (see the detail column) is a reason to measure again on more problems. The provenance stamp of each candidate is in `evidence.json`.",
        ].join("\n"),
    "",
  );
  return `${lines.join("\n")}\n`;
}
