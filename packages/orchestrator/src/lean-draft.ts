import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { HostTactics } from "@seshat/classical";
import { type BlobStore, dedent, extractSubmission, type Journal, newId, PROOF_BEGIN, PROOF_END, type Provenance, type Submission, type ValidationReport } from "@seshat/core";
import { chargedTotals, type Ledger, messageCost } from "./budget.ts";
import { failureClass } from "./feedback.ts";
import { informalBriefing } from "./informal.ts";
import { textOf } from "./llm.ts";
import type { PriceBook } from "./prices.ts";
import type { CheckResult, Workbench } from "./problem.ts";
import { LEAN_DRAFT_SYSTEM, LEAN_DRAFT_VERSION_RECORD } from "./prompt.ts";
import { outcomeOf } from "./prover.ts";
import { ABORT_BUDGET } from "./session.ts";
import { sketchBriefing } from "./sketch.ts";
import { sessionSorryBattery, type SorryBatteryConfig } from "./sorry-battery.ts";
import type { Turn } from "./turns.ts";

/**
 * A Lean-only first draft before the probe (plan change CL2, documentation/scheduler.md, "The Lean draft before the probe"): `RunConfig.leanDraft`,
 * experimental and off by default. One completion with no tools at thinking `off`, capped at `maxOutputTokens`, that writes the proof as a `have`-sketch
 * in Lean alone (the prompt `prompts/lean-draft.system.txt`); Lean checks the whole of it once. A draft that checks clean is a candidate, as a prover's
 * is: `Workbench.check` makes it one, `validate` and the certifier settle it. A draft with an error is cut at the first error (or `sorry`), the cut file
 * is checked to read the goal of the `sorry` that replaced the rest, and one continuation is asked from the verified prefix with that goal (truncate and
 * resume, `resumes` times); the classical battery then tries the `sorry` left, when the run has it.
 *
 * Called by the probe's start in `run.ts`, through the budget gate, for a fresh probe of a problem that is not `long`. It is one attempt like any other
 * (`attempt.started`, one `attempt.charged` per response, `attempt.finished`, its checks as tool runs of the attempt, its transcript), and its settings say
 * `mode: "lean_draft"`, so that the memory, the audit and the report see it.
 *
 * It never sets a claim's status (the workbench's check and the certifier do, as for any proof), has no budget of its own (it is charged to the ledger it
 * is given, the probe's), writes no event of a new type, and never submits the cut file: a file with a `sorry` is no validation, and the file the battery
 * closes is checked like any other. A failure that is no more than a failed draft (a model that errors, a Lean that cannot answer) ends the attempt and
 * leaves the probe to run as it would have.
 */
export interface LeanDraftConfig {
  /** The most output tokens of each completion. Default `DEFAULT_DRAFT_TOKENS`. */
  maxOutputTokens?: number;
  /** The continuations asked after a draft that has an error; 0 asks none. Default `DEFAULT_DRAFT_RESUMES`. */
  resumes?: number;
}

export const DEFAULT_DRAFT_TOKENS = 1024;
export const DEFAULT_DRAFT_RESUMES = 1;

/** The prover name and actor of the draft's attempt. */
export const DRAFT_PROVER = "draft";
const ACTOR = `prover:${DRAFT_PROVER}`;
/** The site of the draft's attempt, for the audit and the spend by site: its own row, neither a session of a prover nor a role's. */
export const SITE_LEAN_DRAFT = "gate.draft";
/** The `settings.mode` of the draft's attempt. */
export const DRAFT_MODE = "lean_draft";

/** What `RunConfig.leanDraft` fails to be, for `checkConfig`. */
export function checkLeanDraft(config: LeanDraftConfig): string[] {
  const problems: string[] = [];
  if (config.maxOutputTokens !== undefined && !(Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens >= 1)) problems.push(`leanDraft.maxOutputTokens must be a whole number of at least 1, got ${config.maxOutputTokens}`);
  if (config.resumes !== undefined && !(Number.isInteger(config.resumes) && config.resumes >= 0)) problems.push(`leanDraft.resumes must be a whole number of at least 0, got ${config.resumes}`);
  return problems;
}

export interface LeanDraftDeps {
  config: LeanDraftConfig;
  /** The problem's: the draft is checked on its file, and a check that passes makes its candidate. */
  workbench: Workbench;
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  /** The prover role's model, and its `provider/id` name. */
  model: Model<Api>;
  modelName: string;
  /** The probe's ledger: the draft and the probe's session are charged to it, so that its cap covers both. */
  ledger: Ledger;
  signal: AbortSignal;
  /** The consortium turn, when the run has them: once it is over no request is sent. */
  turn?: Turn;
  prices?: PriceBook;
  /** The provenance stamp of the attempt, as the prover's (`ProverOptions.stamp`). */
  stamp?: (modelId: string) => Provenance;
  /** The run's classical battery (`RunConfig.sorryBattery`, or `longProof`'s default), and the tactics the host's Lean has. Absent: the draft has none. */
  battery?: { config: SorryBatteryConfig; host: HostTactics };
  /** The seconds a Lean check may take (`RunConfig.checkTimeoutSec`); absent: the workbench's policy. */
  checkTimeoutSec?: number;
  /** Keeps the attempt's messages (`transcripts/ID.json`), which the audit's split of output tokens reads. */
  transcript?: (attemptId: string, messages: AgentMessage[]) => void;
  log?: (line: string) => void;
}

export interface DraftOutcome {
  attemptId: string;
  /** True when a check of the draft passed: the problem has a candidate, which `validate` made and the certifier is to settle. */
  solved: boolean;
}

/** One draft. See the header of this file. */
export async function leanDraft(d: LeanDraftDeps): Promise<DraftOutcome> {
  const { workbench, journal } = d;
  const maxTokens = d.config.maxOutputTokens ?? DEFAULT_DRAFT_TOKENS;
  const resumes = d.config.resumes ?? DEFAULT_DRAFT_RESUMES;
  const attemptId = newId("att");
  journal.emit(
    "attempt.started",
    {
      attemptId,
      claimId: workbench.claimId,
      prover: DRAFT_PROVER,
      iteration: 1,
      model: d.modelName,
      site: SITE_LEAN_DRAFT,
      ...(d.stamp !== undefined ? { provenance: d.stamp(d.modelName) } : {}),
      settings: { mode: DRAFT_MODE, thinking: "off", maxOutputTokens: maxTokens, resumes, promptVersion: LEAN_DRAFT_VERSION_RECORD.promptVersion },
    },
    ACTOR,
  );
  const started = performance.now();
  const messages: AgentMessage[] = [];
  let checks = 0;
  let error: string | undefined;
  /** The last check of a whole draft (the first, or a continuation joined to its prefix): what the attempt is judged by. */
  let state: CheckResult | undefined;
  const over = (): boolean => d.signal.aborted || d.turn?.ended !== undefined;

  /** One completion, charged to the ledger and the attempt; its text, or undefined when none came (the reason is in `error` or the signal). */
  const ask = async (prompt: string): Promise<string | undefined> => {
    if (over() || d.ledger.exhausted) return undefined;
    const user = { role: "user" as const, content: prompt, timestamp: Date.now() };
    const message = await d.models.completeSimple(d.model, { systemPrompt: LEAN_DRAFT_SYSTEM, messages: [user] }, { signal: d.signal, maxTokens });
    const cost = messageCost(d.model, message, d.prices);
    d.ledger.charge(cost);
    journal.emit("attempt.charged", { attemptId, ...cost }, ACTOR);
    messages.push(user, message);
    if (message.stopReason === "error") error = message.errorMessage ?? "the model's answer was an error";
    return message.stopReason === "error" || message.stopReason === "aborted" ? undefined : leanBlock(textOf(message));
  };
  /** One Lean check of a proof, as a tool run of the attempt (`Workbench.check`): a file with no error and no hole makes the candidate. */
  const check = async (proof: string): Promise<CheckResult> => {
    checks += 1;
    return await workbench.check({ aux: "", proof }, { attemptId, actor: ACTOR, signal: d.signal, ...(d.checkTimeoutSec !== undefined ? { timeoutSec: d.checkTimeoutSec } : {}) });
  };

  try {
    const context = statementPrompt(workbench, d.blobs);
    const draft = await ask(`${context}\n\nReply:`);
    if (draft !== undefined) state = await check(draft);
    for (let resumed = 0; state !== undefined && !state.accepted; resumed++) {
      const cut = cutAtFirstBreak(state.report);
      const last = resumed >= resumes;
      if (cut === undefined || (last && d.battery === undefined)) break;
      // The cut file has one `sorry`, which Lean answers with its goal: no model call, and no candidate (a file with a hole is no validation).
      const hole = await check(cut.proof);
      const goal = soleGoal(hole.report);
      if (goal === undefined || over()) break;
      if (last) {
        // No continuation is left to ask: the battery tries the `sorry`, and what it closes is checked like any file.
        const closed = await sessionSorryBattery(journal, workbench, attemptId, d.battery as NonNullable<LeanDraftDeps["battery"]>)({ aux: "", proof: cut.proof }, hole.report, d.signal);
        if (closed?.submission !== undefined) {
          const whole = await check(closed.submission.proof);
          if (whole.accepted) state = whole;
        }
        break;
      }
      const more = await ask(`${context}\n\n${resumePrompt(cut.steps, goal)}`);
      if (more === undefined) break;
      state = await check(`${cut.steps === "" ? "" : `${cut.steps}\n`}${dedent(more)}`);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    d.log?.(`the Lean draft failed: ${error}`);
  }

  const solved = state?.accepted === true;
  const stop = solved ? "solved" : d.signal.aborted ? (d.signal.reason === ABORT_BUDGET ? "budget" : "aborted") : error !== undefined ? "error" : d.ledger.exhausted ? "budget" : "model";
  const outcome = outcomeOf({ stop, submissions: checks });
  const submitted = workbench.lastSubmission(attemptId);
  journal.emit(
    "attempt.finished",
    {
      attemptId,
      outcome,
      ...(outcome === "invalid" && state !== undefined ? failureOf(state.report, workbench, submitted) : {}),
      stoppedBy: stop,
      ...(error !== undefined ? { error: error.slice(0, 1000) } : {}),
      durationMs: Math.round(performance.now() - started),
      checks,
      ...chargedTotals(journal.projection.attempt(attemptId)),
    },
    ACTOR,
  );
  d.transcript?.(attemptId, messages);
  // The attempt is the problem's own only when it found the candidate: the gate reads the problem's attempts for the probe's Lean progress, and a draft is not the probe.
  if (solved) workbench.noteAttempt(attemptId);
  return { attemptId, solved };
}

/** The statement the model is shown, with what the probe's first briefing would carry that is at hand: a person's sketch and an accepted informal proof. */
function statementPrompt(workbench: Workbench, blobs: BlobStore): string {
  const { prefix, header } = workbench.sketch;
  const sections = [...sketchBriefing(workbench.journal.projection, workbench.claimId), ...informalBriefing(workbench.journal.projection, blobs, workbench.claimId)];
  return [`Theorem:\n\`\`\`lean\n${`${prefix}${header}`.trim()}\n\`\`\``, ...sections.map((s) => `# ${s.title}\n${s.text}`)].join("\n\n");
}

/** The request for the continuation: the steps Lean accepted, the goal that is left, and what to write. */
function resumePrompt(steps: string, goal: string): string {
  const done = steps === "" ? "No step of your draft was accepted." : `These steps of your draft were checked by Lean with no error:\n\`\`\`lean\n${steps}\n\`\`\``;
  return `${done}\nThe goal that is left after them is:\n\`\`\`\n${goal}\n\`\`\`\nContinue from there: write only the steps that come after the ones above, ending by closing this goal, in one lean block, at the left margin.\n\nReply:`;
}

/** The proof in the first lean block of a reply (an open block is read to the end of the reply, a reply with no block is the proof), or undefined when it is empty. */
export function leanBlock(reply: string): string | undefined {
  const fenced = /```(?:lean4?)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/.exec(reply);
  const body = (fenced?.[1] ?? reply).replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
  return body === "" ? undefined : body;
}

/** The goal of the one `sorry` of a checked file that has no error, or undefined: Lean did not answer, there is an error, or the file does not have exactly one hole. */
function soleGoal(report: ValidationReport): string | undefined {
  if (report.leanStatus === undefined || report.messages.some((m) => m.severity === "error") || report.sorries.length !== 1) return undefined;
  return (report.sorries[0] as { goal: string }).goal;
}

/** A line that goes on a step of the line before it: an alternative of `induction ... with`, a `calc` step, `<;>`, `else`. */
const CONTINUES = /^(?:\||_(?:\s|$)|<;>|else\b|termination_by|decreasing_by)/;

/**
 * Where a checked file first breaks, as a cut of its proof: `steps`, the complete top-level steps that come before the first error or `sorry` that Lean placed in
 * the PROOF region (the step that holds it is left out), and `proof`, those steps and a `sorry` in place of the rest. An error that Lean placed outside the region
 * (an `unsolved goals` at the theorem's `by`) means that every step stands and the goal is not closed: all the steps are kept. Undefined when the report names
 * no error or `sorry` at all, as a file Lean never read (refused before Lean, a timeout).
 */
export function cutAtFirstBreak(report: ValidationReport): { steps: string; proof: string } | undefined {
  const lines = report.checked.split("\n");
  const begin = lines.findIndex((l) => l.trim() === PROOF_BEGIN.trim()) + 1;
  const breaks = [...report.messages.filter((m) => m.severity === "error").map((m) => m.pos.line), ...report.sorries.map((s) => s.pos.line)];
  if (begin === 0 || breaks.length === 0) return undefined;
  const proof = dedent(extractProof(report.checked)).split("\n");
  const inside = breaks.map((line) => line - begin).filter((line) => line >= 1 && line <= proof.length);
  // The step that holds the first break starts at the last line at the left margin that is not the continuation of the one before it.
  let cut = proof.length;
  if (inside.length > 0) {
    const first = Math.min(...inside);
    cut = proof.findLastIndex((l, i) => i < first && l.trim() !== "" && !/^\s/.test(l) && !CONTINUES.test(l));
    if (cut < 0) cut = 0;
  }
  // A comment above the step that was cut stays with it.
  while (cut > 0 && /^(?:\s*|\s*--.*)$/.test(proof[cut - 1] as string)) cut -= 1;
  const steps = proof.slice(0, cut).join("\n");
  return { steps, proof: steps === "" ? "sorry" : `${steps}\nsorry` };
}

/** The PROOF region of a checked file. */
function extractProof(checked: string): string {
  return extractSubmission(checked).proof;
}

/** What the attempt's failure was, as `attempt.finished` carries it: the class of the last whole draft's check. */
function failureOf(report: ValidationReport, workbench: Workbench, submitted: Submission | undefined): { failureClass?: string } {
  const failure = failureClass(report, { statement: workbench.sketch.statement, ...(submitted !== undefined ? { aux: submitted.aux } : {}) });
  return failure === undefined ? {} : { failureClass: failure };
}
