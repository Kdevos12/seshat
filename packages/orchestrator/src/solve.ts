import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { buildSequences, type BenchIndex, type ProblemEntry, readIndex, writeIndex } from "@seshat/bench";
import {
  BlobStore,
  hashJson,
  importsOf,
  type LeanChecker,
  maskCommentsAndStrings,
  namespacesAt,
  prepareSketch,
  readDeclarationHead,
  sha256Hex,
  splitCommands,
  statementIdV0,
  toPlainHeader,
  type Journal,
  type TokenCost,
  USER_NAME,
} from "@seshat/core";
import { cheapTactics, formalizeHypothesis, testLemmas, type TestLemmas } from "@seshat/induction";
import { type Llm, type LlmRequest, type LlmResult, withJson } from "@seshat/lines";
import { messageCost } from "./budget.ts";
import type { PriceBook } from "./prices.ts";
import { resolveModel, runBench, type RunConfig, type RunOptions, type RunResult } from "./run.ts";
import { checkAllowance, studentConfig, STUDENT_TURN_SHARE, type StudentOptions } from "./student.ts";

/**
 * `harness solve` (plan change PB6, documentation/quickstart.md): a problem of one's own, with the least friction. The statement is a Lean
 * statement (a file, or text) or prose; prose is formalized by the induction path, shown, and signed before any spend. The problem becomes
 * a bench of one problem inside the run directory, and the run takes the student defaults (`student.ts`). Nothing here is a new
 * mechanism of a run: it prepares the inputs of `runBench` and calls it.
 */

/** A mistake of the person's input, such as a statement with no `sorry` to prove: the message says what to do. */
export class SolveInputError extends Error {}

/** The name of the theorem the harness gives a statement written without one. */
export const TARGET_NAME = "solve_target";

/** The imports a statement gets when it has none: Mathlib, which every statement of the bench is read under. */
export const DEFAULT_HEADER = "import Mathlib";

/** The file of the problem in the one-problem checkout. */
export const PROBLEM_FILE = "Solve.lean";

const DECLARATION = /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable)\s+)*(?:theorem|lemma)\s/m;
const SORRY = /(?<![\p{L}\p{N}_'.!?])sorry(?![\p{L}\p{N}_'!?])/u;

/** Whether the text starts with binders and then `:`, the signature form of a statement (`(n : ℕ) : n + 0 = n`). */
export function isSignature(text: string): boolean {
  const masked = maskCommentsAndStrings(text.trim());
  let i = 0;
  let groups = 0;
  const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}", "⦃": "⦄", "⟨": "⟩" };
  for (;;) {
    while (i < masked.length && /\s/.test(masked[i] as string)) i++;
    const open = masked[i];
    const close = open === undefined ? undefined : closers[open];
    if (close === undefined) break;
    let depth = 0;
    for (; i < masked.length; i++) {
      const c = masked[i] as string;
      if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    if (depth !== 0) return false;
    i++;
    groups++;
  }
  return groups > 0 && masked[i] === ":" && masked[i + 1] !== "=";
}

/**
 * Lean or prose. Lean when the text has a `theorem` or `lemma` declaration or an `import` line, or is a signature (binders, then `:`);
 * anything else is prose. A bare proposition such as `∀ n, n + 0 = n` is told apart from prose by the person: `--lean`.
 */
export function classifyStatement(text: string): "lean" | "prose" {
  const masked = maskCommentsAndStrings(text.trim());
  if (DECLARATION.test(masked) || /^import\s/m.test(masked) || isSignature(text)) return "lean";
  return "prose";
}

/** A Lean file with its target declaration found. */
export interface LeanProblem {
  /** The text of the file. */
  source: string;
  /** The target's full name in the file. */
  fullName: string;
  /** Things the person should know about how the text was read. */
  notes: string[];
}

/**
 * Reads the person's Lean text as a problem file. A theorem or lemma is taken as written; a signature or a proposition becomes
 * `theorem solve_target ... := by sorry`. A file with no `import` gets `import Mathlib`. The target is the theorem whose proof is `sorry`
 * (the last one, when there are several: the lemmas above it are the file's own).
 */
export function leanProblem(text: string, header: string = DEFAULT_HEADER): LeanProblem {
  const notes: string[] = [];
  let body = text.trim();
  if (body === "") throw new SolveInputError("the statement is empty");
  const declared = DECLARATION.test(maskCommentsAndStrings(body));
  if (!declared) {
    body = body.replace(/\s*:=\s*(?:by\s+)?sorry\s*$/, "");
    const sorry = SORRY.test(maskCommentsAndStrings(body));
    if (sorry) throw new SolveInputError("the statement holds `sorry` inside it: give the statement only, the harness supplies the `sorry` that stands for the proof");
    body = `theorem ${TARGET_NAME} ${isSignature(body) ? body : `: ${body}`} := by\n  sorry`;
    notes.push(`the statement had no name: it is the theorem ${TARGET_NAME}`);
  } else if (!/:=/.test(maskCommentsAndStrings(body))) {
    body = `${body} := by\n  sorry`;
  }
  const source = /^\s*(?:public\s+|meta\s+)*import\s/m.test(maskCommentsAndStrings(body)) ? `${body}\n` : `${header}\n\n${body}\n`;
  const commands = splitCommands(source);
  const scopes = namespacesAt(commands);
  const targets: string[] = [];
  for (let k = 0; k < commands.length; k++) {
    const command = commands[k] as (typeof commands)[number];
    if (command.kind !== "code") continue;
    const head = readDeclarationHead(command.text);
    if (head === undefined || (head.keyword !== "theorem" && head.keyword !== "lemma")) continue;
    if (!SORRY.test(maskCommentsAndStrings(command.text))) continue;
    targets.push([...(scopes[k] ?? []), head.name].join(".").replace(/^(?:.*\.)?_root_\./, ""));
  }
  const fullName = targets.at(-1);
  if (fullName === undefined) throw new SolveInputError("no theorem or lemma in the text has `sorry` for its proof: there is nothing to prove. Leave the proof out, or write `:= by sorry`");
  if (targets.length > 1) notes.push(`${targets.length} declarations end in \`sorry\`; the target is the last, ${fullName}`);
  return { source, fullName, notes };
}

/** The problem of a one-problem bench: its entry, the index, and where the files are. */
export interface OneProblem {
  checkout: string;
  indexFile: string;
  index: BenchIndex;
  entry: ProblemEntry;
}

/**
 * Writes the problem as a checkout of one file and a bench index of one problem under `dir/problem`. The index is the same shape as
 * the bench's (its hash is checked when it is read), so `harness resume` takes it with `--bench`.
 */
export function writeProblem(dir: string, problem: LeanProblem): OneProblem {
  const checkout = join(resolve(dir), "problem");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, PROBLEM_FILE), problem.source);
  const plain = toPlainHeader(problem.source);
  const sketch = prepareSketch(plain, problem.fullName);
  const fileHash = sha256Hex(plain);
  const lineOf = (offset: number): number => problem.source.slice(0, offset).split("\n").length;
  const entry: ProblemEntry = {
    id: `${PROBLEM_FILE}#${sketch.fullName}`,
    path: PROBLEM_FILE,
    fullName: sketch.fullName,
    declaredName: sketch.declaredName,
    line: lineOf(sketch.prefix.length),
    category: "research open",
    ams: [],
    proofInFile: false,
    sorryInStatement: SORRY.test(maskCommentsAndStrings(sketch.statement)),
    statement: sketch.statement,
    statementId: statementIdV0(sketch.statement),
    fileHash,
    imports: importsOf(problem.source),
    unprovedBefore: [],
  };
  const short = fileHash.slice(0, 8);
  const body = {
    v: 1 as const,
    benchId: `solve-${short}`,
    source: { repo: "local", rev: `local:${short}`, lean: "unknown" },
    filter: { categories: ["research open"], ams: [] as number[], includeProofInFile: false, excludeUnprovedBefore: false },
    counts: { theorems: 1, selected: 1, unreadable: 0 },
    problems: [entry],
    sequences: buildSequences([entry]),
  };
  const index: BenchIndex = { ...body, hash: hashJson(body) };
  const indexFile = join(checkout, "index.json");
  writeIndex(indexFile, index);
  return { checkout, indexFile, index: readIndex(indexFile), entry };
}

// --- Prose ------------------------------------------------------------------------------------

/** What formalizing the person's words cost, and the calls' records. */
export interface FormalizationSpend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  requestHash: string;
  responseHash: string;
}

/** An `Llm` for the few calls before a run exists: its requests and responses go to the run's blobs, and its cost is added up. */
export function preRunLlm(o: { models: Models; model: string; prices?: PriceBook; blobs: BlobStore; signal?: AbortSignal; maxUsd: number }): Llm & { spend(): FormalizationSpend | undefined } {
  const spent = { usd: 0, inputTokens: 0, outputTokens: 0 };
  let last: { requestHash: string; responseHash: string } | undefined;
  let model: Model<Api> | undefined;
  const llm = withJson(async (request: LlmRequest): Promise<LlmResult> => {
    if (spent.usd >= o.maxUsd) throw new SolveInputError(`formalizing the statement has already cost $${spent.usd.toFixed(4)}, the share of the allowance it may take: stopping before more is spent`);
    const name = request.model ?? o.model;
    model ??= await resolveModel(o.models, name);
    const requestHash = o.blobs.putJson({ model: name, system: request.system ?? null, prompt: request.prompt, maxTokens: request.maxTokens ?? null });
    const message = await o.models.completeSimple(
      model,
      { ...(request.system !== undefined ? { systemPrompt: request.system } : {}), messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] },
      { ...(o.signal !== undefined ? { signal: o.signal } : {}), ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}) },
    );
    const cost: TokenCost = messageCost(model, message, o.prices);
    spent.usd += cost.usd;
    spent.inputTokens += cost.inputTokens;
    spent.outputTokens += cost.outputTokens;
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new SolveInputError(`the model call failed: ${message.errorMessage ?? message.stopReason}`);
    last = { requestHash, responseHash: o.blobs.put(text) };
    return { text, cost, model: name, modelCallId: requestHash };
  });
  return { ...llm, spend: () => (last === undefined ? undefined : { ...spent, ...last }) };
}

// --- The run ----------------------------------------------------------------------------------

/** What the person is shown before anything is spent, and signs. */
export interface Signature {
  source: "prose" | "lean";
  prose?: string;
  /** The theorem as it stands in the problem file, with its `sorry`. */
  theorem: string;
  statement: string;
  statementId: string;
  testLemmas?: TestLemmas;
  trivial?: { by: string };
  notes: string[];
}

export interface SolveOptions {
  /** The person's statement: Lean or prose. */
  statement: string;
  /** Force the reading; the default tells them apart (`classifyStatement`). */
  mode?: "lean" | "prose";
  /** The run directory, which holds the problem too. */
  dir: string;
  models: Models;
  /** `provider/id`. */
  model: string;
  maxUsd: number;
  turnUsd?: number;
  offpeak?: RunConfig["offpeak"];
  lines?: StudentOptions["lines"];
  base?: StudentOptions["base"];
  prices?: PriceBook;
  /** The person's name, for the signature and every event of the run. */
  user: string;
  /** The first lines of the file, for a statement without imports. */
  header?: string;
  /** Checks the first cases and triviality of a formalized statement; absent: they are not tried. */
  checker?: LeanChecker;
  /** Asks the person to sign the statement. A statement the harness wrote from prose has to be accepted; `false` ends the command with nothing spent. */
  confirm: (signature: Signature) => Promise<boolean>;
  show?: (line: string) => void;
  registry: RunOptions["registry"];
  leanEnvironment?: RunOptions["leanEnvironment"];
  certifier?: RunOptions["certifier"];
  signal?: AbortSignal;
  log?: (line: string) => void;
  codeRev?: string;
  runId?: string;
  lib?: Pick<RunOptions, "libraryRegistry" | "memoryFrom">;
}

export interface SolveResult {
  /** `declined`: the person did not sign, nothing ran. */
  state: "ran" | "declined";
  dir: string;
  signature: Signature;
  problem: OneProblem;
  formalization?: FormalizationSpend;
  config?: RunConfig;
  result?: RunResult;
  /** The command that resumes the run. */
  resume: string;
}

/** The command that resumes a solve, exactly. */
export function solveResumeCommand(dir: string, problem: OneProblem, host?: string): string {
  const parts = ["harness", "resume", resolve(dir), "--checkout", problem.checkout, "--bench", problem.indexFile];
  if (host !== undefined) parts.push("--host", host);
  return parts.join(" ");
}

/** The share of the allowance the formalization may take. */
export const FORMALIZATION_SHARE = 0.2;

export async function solve(o: SolveOptions): Promise<SolveResult> {
  const problems = checkAllowance(o.maxUsd, o.turnUsd);
  if (problems.length > 0) throw new SolveInputError(problems.join("; "));
  if (!USER_NAME.test(o.user)) throw new SolveInputError(`the name ${JSON.stringify(o.user)} cannot sign: use letters, digits, dot, dash and underscore (--as NAME)`);
  const show = o.show ?? (() => {});
  const dir = resolve(o.dir);
  if (existsSync(join(dir, "journal.jsonl"))) throw new SolveInputError(`${dir} already holds a run: choose another directory, or resume it with harness resume`);
  const mode = o.mode ?? classifyStatement(o.statement);
  const header = o.header ?? DEFAULT_HEADER;
  mkdirSync(dir, { recursive: true });
  const blobs = new BlobStore(join(dir, "blobs"));

  let lean: LeanProblem;
  let formalization: FormalizationSpend | undefined;
  let prose: string | undefined;
  const notes: string[] = [];
  if (mode === "prose") {
    prose = o.statement.trim();
    if (prose === "") throw new SolveInputError("the statement is empty");
    const llm = preRunLlm({ models: o.models, model: o.model, blobs, maxUsd: o.maxUsd * FORMALIZATION_SHARE, ...(o.prices !== undefined ? { prices: o.prices } : {}), ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    show(`Formalizing your statement with ${o.model} (this is the only model call before you sign; it is charged to your allowance)...`);
    let answer: Awaited<ReturnType<typeof formalizeHypothesis>>;
    try {
      answer = await formalizeHypothesis(llm, { id: "statement", level: "generalization", informal: prose, conclusion: "", uses: [] }, "the problem of the person running the harness", header, { model: o.model });
    } catch (error) {
      const spend = llm.spend();
      throw new SolveInputError(`${error instanceof Error ? error.message : String(error)}${spend !== undefined ? ` (the formalization cost $${spend.usd.toFixed(4)})` : ""}`);
    }
    formalization = llm.spend();
    if (answer.statement === undefined) throw new SolveInputError(`the model's Lean statement was refused: ${answer.problem ?? "unreadable"}. Nothing was proved or run; try again, or write the statement in Lean.`);
    lean = leanProblem(`theorem ${TARGET_NAME} ${answer.statement}`, header);
    notes.push(`the model formalized your words; read the Lean statement below and sign it only if it says what you mean`);
  } else {
    lean = leanProblem(o.statement, header);
    notes.push(...lean.notes);
  }

  const problem = writeProblem(dir, lean);
  let testLemmasResult: TestLemmas | undefined;
  let trivial: { by: string } | undefined;
  if (mode === "prose" && o.checker !== undefined) {
    try {
      testLemmasResult = await testLemmas(o.checker, header, problem.entry.statement, 10, o.signal !== undefined ? { signal: o.signal } : {});
      if (testLemmasResult.result === "failed") notes.push(`Lean's \`decide\` refutes this statement on case ${testLemmasResult.failedAt}: it probably does not say what you mean`);
      const probe = await cheapTactics(o.checker)(problem.entry.statement, header, o.signal);
      if (probe.trivial) {
        trivial = { by: probe.by ?? "cheap tactics" };
        notes.push("cheap automation closes this statement: it is trivial as written");
      }
    } catch (error) {
      notes.push(`the first cases could not be tried: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const signature: Signature = {
    source: mode,
    ...(prose !== undefined ? { prose } : {}),
    theorem: `theorem ${problem.entry.declaredName} ${problem.entry.statement}`,
    statement: problem.entry.statement,
    statementId: problem.entry.statementId,
    ...(testLemmasResult !== undefined ? { testLemmas: testLemmasResult } : {}),
    ...(trivial !== undefined ? { trivial } : {}),
    notes,
  };
  const resume = solveResumeCommand(dir, problem);
  if (!(await o.confirm(signature))) return { state: "declined", dir, signature, problem, ...(formalization !== undefined ? { formalization } : {}), resume };

  // The allowance is the person's total: what the formalization cost comes off it.
  const remaining = Math.round((o.maxUsd - (formalization?.usd ?? 0)) * 1e6) / 1e6;
  if (!(remaining > 0)) throw new SolveInputError(`formalizing the statement cost $${formalization?.usd.toFixed(4)}, all of the allowance $${o.maxUsd}: raise --max-usd`);
  const turnUsd = Math.min(remaining, o.turnUsd ?? Math.round(o.maxUsd * STUDENT_TURN_SHARE * 1e6) / 1e6);
  const config = studentConfig({
    selection: { ids: [problem.entry.id] },
    model: o.model,
    maxUsd: remaining,
    turnUsd,
    ...(o.lines !== undefined ? { lines: o.lines } : {}),
    ...(o.offpeak !== undefined ? { offpeak: o.offpeak } : {}),
    ...(o.base !== undefined ? { base: o.base } : {}),
  });
  const result = await runBench({
    config,
    index: problem.index,
    problems: [problem.entry],
    checkout: problem.checkout,
    dir,
    models: o.models,
    registry: o.registry,
    ...(o.leanEnvironment !== undefined ? { leanEnvironment: o.leanEnvironment } : {}),
    ...(o.certifier !== undefined ? { certifier: o.certifier } : {}),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    ...(o.log !== undefined ? { log: o.log } : {}),
    ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    ...(o.lib ?? {}),
    benchFile: problem.indexFile,
    user: o.user,
    afterStart: (journal: Journal) => {
      journal.emit(
        "statement.signed",
        {
          source: signature.source,
          ...(prose !== undefined ? { prose } : {}),
          statement: signature.statement,
          statementId: signature.statementId,
          problemId: problem.entry.id,
          ...(formalization !== undefined ? { model: o.model, formalization } : {}),
          ...(testLemmasResult !== undefined ? { testLemmas: testLemmasResult } : {}),
          ...(trivial !== undefined ? { trivial } : {}),
        },
        `human:${o.user}`,
        { user: o.user },
      );
    },
  });
  return { state: "ran", dir, signature, problem, ...(formalization !== undefined ? { formalization } : {}), config, result, resume };
}
