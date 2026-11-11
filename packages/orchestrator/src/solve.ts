import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { buildSequences, type BenchIndex, type ProblemEntry, readIndex, writeIndex } from "@seshat/bench";
import {
  BlobStore,
  forbiddenTokensIn,
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
import { shellQuote } from "./result.ts";
import type { PriceBook } from "./prices.ts";
import { resolveModel, runBench, type RunConfig, type RunOptions, type RunResult } from "./run.ts";
import { type IntakeConfig } from "./intake.ts";

import { checkAllowance, INTAKE_ALLOWANCE_SHARE, studentConfig, STUDENT_TURN_SHARE, type StudentOptions } from "./student.ts";

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
    const start = i;
    for (; i < masked.length; i++) {
      const c = masked[i] as string;
      if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    if (depth !== 0) return false;
    // A binder (x : T) or {x : T} has a colon inside; a parenthesis in prose ("(Fermat) : ...") does not.
    if ((open === "(" || open === "{") && !masked.slice(start + 1, i).includes(":")) return false;
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
  if (DECLARATION.test(masked) || /^import\s+[A-Z][\w.]*\s*$/m.test(masked) || isSignature(text)) return "lean";
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
  // The screen of every model-written text, for a file the person wrote or downloaded: it reaches Kimina and the certifier as it stands.
  // Comments are kept (a file has docstrings), the header is apart, and `sorry` is the target's proof.
  const rest = toPlainHeader(source).split("\n").map((line) => (/^import\s/.test(line) ? "" : line)).join("\n");
  const maskedRest = maskCommentsAndStrings(rest);
  const reasons = forbiddenTokensIn(maskedRest).filter((t) => t !== "sorry");
  if (maskedRest.includes("#")) reasons.push("#");
  if (reasons.length > 0) {
    throw new SolveInputError(
      `the Lean text is refused by the screen that every model-written text goes through, because it is checked by Lean as it stands: ${reasons.map((t) => `'${t}'`).join(", ")}. Remove it, or state the problem without it.`,
    );
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

/** Dollars per million tokens of a model, input and output, from the host's table when it has the model and from pi-ai otherwise. */
function pricePerMillion(model: Model<Api>, prices?: PriceBook): { input: number; output: number } {
  const host = prices?.pricingOf(model);
  return host !== undefined ? { input: host.cacheMiss, output: host.output } : { input: model.cost.input, output: model.cost.output };
}

/** The smallest answer worth paying for, in tokens: below it the call is not made. */
const MIN_ANSWER_TOKENS = 64;

/**
 * An `Llm` for the few calls before a run exists: its requests and responses go to the run's blobs, and its cost is added up. Every call is bounded
 * before it is sent: the input is estimated (three characters a token, an over-estimate), and the answer gets the `maxTokens` that the rest of
 * `maxUsd` can pay for at the model's output price, so that the share cannot be passed by one call, nor by the retry of `completeJson`.
 */
export function preRunLlm(o: { models: Models; model: string; prices?: PriceBook; blobs: BlobStore; signal?: AbortSignal; maxUsd: number }): Llm & { spend(): FormalizationSpend | undefined; total(): { usd: number; inputTokens: number; outputTokens: number; calls: number } } {
  const spent = { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
  let last: { requestHash: string; responseHash: string } | undefined;
  let model: Model<Api> | undefined;
  const llm = withJson(async (request: LlmRequest): Promise<LlmResult> => {
    const name = request.model ?? o.model;
    model ??= await resolveModel(o.models, name);
    const price = pricePerMillion(model, o.prices);
    const estimatedInput = Math.ceil(((request.system?.length ?? 0) + request.prompt.length) / 3);
    const left = o.maxUsd - spent.usd - (estimatedInput * price.input) / 1e6;
    const affordable = price.output > 0 ? Math.floor((left * 1e6) / price.output) : 4096;
    const maxTokens = Math.min(request.maxTokens ?? 4096, 4096, affordable);
    if (!(maxTokens >= MIN_ANSWER_TOKENS)) {
      throw new SolveInputError(`formalizing the statement may cost $${o.maxUsd.toFixed(4)} (a share of the allowance) and has cost $${spent.usd.toFixed(4)}: not enough is left for an answer, so no call is made. Raise --max-usd, or write the statement in Lean.`);
    }
    const requestHash = o.blobs.putJson({ model: name, system: request.system ?? null, prompt: request.prompt, maxTokens });
    spent.calls++;
    const message = await o.models.completeSimple(
      model,
      { ...(request.system !== undefined ? { systemPrompt: request.system } : {}), messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] },
      { ...(o.signal !== undefined ? { signal: o.signal } : {}), maxTokens },
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
  return {
    ...llm,
    spend: () => (last === undefined ? undefined : { usd: spent.usd, inputTokens: spent.inputTokens, outputTokens: spent.outputTokens, ...last }),
    total: () => ({ ...spent }),
  };
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
  /** The defaults set (`student.ts`); absent: the default one, `v2`. */
  defaults?: StudentOptions["defaults"];
  /** The host profile's `checkTimeoutSec`, for the sets that bound the checks. */
  hostCheckTimeoutSec?: number;
  base?: StudentOptions["base"];
  prices?: PriceBook;
  /** The host profile the run uses, which the resume command names. */
  host?: string;
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
  /** `--tool ID` (CA17): capabilities the provers get besides lean_check. Default: none. */
  tools?: readonly string[];
  /**
   * The host's compute tool (`compute.sage`), given to the provers when the router files the statement as finite, about a graph or about
   * numbers (`fileStatement`). Absent: nothing is added. The caller passes it only when the host offers the capability.
   */
  autoTool?: string;
  /** The intake step (Task 36): the statement's hygiene, and the literature when the person agrees. Absent: none, as before. */
  intake?: IntakeConfig;
  /** Asks the person once whether the statement may go to third parties (the literature, and `lean.search` with `leanSearch`); the answer is journaled. Absent: no answer, which is no. */
  askConsent?: () => Promise<boolean>;
  /** `--private`: nothing goes outside the machine and the model provider; wins over everything. */
  private?: boolean;
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
  const parts = [resolve(dir), "--checkout", problem.checkout, "--bench", problem.indexFile];
  if (host !== undefined) parts.push("--host", host);
  return `harness resume ${parts.map((p) => shellQuote(p)).join(" ")}`;
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
    // What the call cost is written down whatever comes next, because no journal exists yet to hold it: a refused, failed or declined formalization has still been paid for.
    const record = (state: string): void => writeFileSync(join(dir, "formalization.json"), `${JSON.stringify({ state, model: o.model, ...llm.total() }, null, 2)}\n`);
    try {
      answer = await formalizeHypothesis(llm, { id: "statement", level: "generalization", informal: prose, conclusion: "", uses: [] }, "the problem of the person running the harness", header, { model: o.model });
    } catch (error) {
      record("failed");
      const spent = llm.total();
      throw new SolveInputError(`${error instanceof Error ? error.message : String(error)}${spent.calls > 0 ? ` (the formalization cost $${spent.usd.toFixed(4)}; it is written in ${join(dir, "formalization.json")})` : ""}`);
    }
    formalization = llm.spend();
    record(answer.statement === undefined ? "refused" : "formalized");
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
  if ((mode === "prose" || o.intake?.hygiene === true) && o.checker !== undefined) {
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
  const resume = solveResumeCommand(dir, problem, o.host);
  if (!(await o.confirm(signature))) {
    if (formalization !== undefined) writeFileSync(join(dir, "formalization.json"), `${JSON.stringify({ state: "declined", model: o.model, ...formalization }, null, 2)}\n`);
    return { state: "declined", dir, signature, problem, ...(formalization !== undefined ? { formalization } : {}), resume };
  }

  // The allowance is the person's total: what the formalization cost comes off it.
  const remaining = Math.round((o.maxUsd - (formalization?.usd ?? 0)) * 1e6) / 1e6;
  if (!(remaining > 0)) throw new SolveInputError(`formalizing the statement cost $${formalization?.usd.toFixed(4)}, all of the allowance $${o.maxUsd}: raise --max-usd`);
  const turnUsd = Math.min(remaining, o.turnUsd ?? Math.round(o.maxUsd * STUDENT_TURN_SHARE * 1e6) / 1e6);
  // The person's agreement to send the statement outside is asked once, here, after the signature, and journaled by the run.
  // The answer governs the literature and also `lean.search` (Task 36b), so `--lean-search` brings the question and the record of the answer too.
  const wantsLeanSearch = o.base?.leanSearch === true;
  let intake = o.intake ?? (wantsLeanSearch ? {} : undefined);
  if (intake !== undefined && (intake.literature === true || wantsLeanSearch) && o.private !== true && intake.consent === undefined && o.askConsent !== undefined) {
    intake = { ...intake, consent: { allowed: await o.askConsent(), via: "asked" } };
  }
  // The intake's judge call is proportionate to the allowance: the smaller of its default and 5% of it (`--intake-usd` wins).
  if (intake !== undefined && intake.capUsd === undefined && intake.capShare === undefined) intake = { ...intake, capShare: INTAKE_ALLOWANCE_SHARE };
  // The compute tool is decided by the run, per problem (`RunConfig.autoTool`); a tool the person named is run-wide and is not added twice.
  const tools = [...new Set(o.tools ?? [])];
  const autoTool = o.autoTool !== undefined && !tools.includes(o.autoTool) ? o.autoTool : undefined;
  const config = studentConfig({
    selection: { ids: [problem.entry.id] },
    model: o.model,
    maxUsd: remaining,
    turnUsd,
    ...(o.lines !== undefined ? { lines: o.lines } : {}),
    ...(o.defaults !== undefined ? { defaults: o.defaults } : {}),
    ...(o.hostCheckTimeoutSec !== undefined ? { hostCheckTimeoutSec: o.hostCheckTimeoutSec } : {}),
    ...(o.offpeak !== undefined ? { offpeak: o.offpeak } : {}),
    base: { ...o.base, ...(tools.length > 0 ? { tools } : {}), ...(autoTool !== undefined ? { autoTool } : {}), ...(intake !== undefined ? { intake } : {}), ...(o.private === true ? { private: true } : {}) },
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
    ...(testLemmasResult !== undefined ? { testLemmas: new Map([[problem.entry.id, testLemmasResult]]) } : {}),
    user: o.user,
    ...(prose !== undefined ? { prose } : {}),
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
