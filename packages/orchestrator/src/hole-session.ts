import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type BlobStore, HOLE_VERDICTS, type Journal, newId } from "@seshat/core";
import type { HoleSessionRequest, HoleSessionResult, HoleVerdictCall } from "@seshat/lines";
import type { Ledger } from "./budget.ts";
import type { PriceBook } from "./prices.ts";
import type { Workbench } from "./problem.ts";
import { runSession } from "./session.ts";
import type { Turn } from "./turns.ts";

/** The site of a hole session's model responses in the journal's `model_call.finished` events. */
export const SITE_HOLE = "scheduler.hole";

/** The system prompt of a hole session: its tools and its rules, and nothing about the problem. */
export const HOLE_SYSTEM = [
  "You prove one lemma in Lean 4 with Mathlib. You work on a small file: a header, some lemmas that are given (their proofs are `sorry`: use them by name, do not prove or change them), and the lemma you prove.",
  "Tools: lean_check(aux, proof) checks the file with your two regions; lean_edit(region, old, new) changes one region as you last checked it and checks again. The aux region holds the given lemmas, kept exactly as they are, and any helper lemmas you add; the proof region is the tactic proof of your lemma without the leading `by`.",
  "You are done when Lean reports no error and the only `sorry` left are in the given lemmas. Never write `sorry` or `admit` anywhere else.",
  "If you find that the lemma is false, call hole_verdict with verdict statement_wrong. Give a Lean proof of its negation in negation_proof (the tactic proof of `not (the statement)`, without `by`) when you have one, and the reason in argument; a reason alone is only a suspicion and changes nothing. If you cannot prove it, call hole_verdict with verdict too_hard. Say nothing of a proof you have not checked.",
].join("\n\n");

export interface HoleSessionDeps {
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  /** `provider/id` of the run's model. */
  model: string;
  resolveModel: (name: string) => Promise<Model<Api>>;
  thinkingLevel: ThinkingLevel;
  ledger: Ledger;
  problemId: string;
  signal: AbortSignal;
  turn?: Turn;
  prices?: PriceBook;
  /** The claim's own workbench (`ClaimBenches.workbenchFor`). */
  workbench: (claimId: string) => Promise<Workbench>;
  actor: string;
  contextTokens: number;
  /** The seconds a Lean check may take (`RunConfig.checkTimeoutSec`); absent: the workbench's policy. */
  checkTimeoutSec?: number;
}

/** The arguments of `hole_verdict`. */
function verdictParameters() {
  return Type.Object({
    verdict: StringEnum([...HOLE_VERDICTS], { description: "proved (you checked a proof), statement_wrong (the lemma is false), or too_hard (you cannot prove it)." }),
    argument: Type.Optional(Type.String({ description: "For statement_wrong: why the lemma is false, or a counterexample. Not trusted without a checked proof." })),
    negation_proof: Type.Optional(Type.String({ description: "For statement_wrong: the tactic proof, without `by`, of the negation of the lemma. It is checked by Lean." })),
    negation_aux: Type.Optional(Type.String({ description: "For statement_wrong: helper lemmas of the negation's proof, named aux_..." })),
  });
}

/**
 * A session of the run's model with `lean_check`, `lean_edit` and `hole_verdict` on a claim's own small file (plan change CA10). It is
 * `runSession` on the claim's workbench: the checks are the workbench's, the charges go to the problem's ledger and each response is a
 * `model_call.finished` event of the line at the site `scheduler.hole`, so that the report counts the spend. The session has no attempt:
 * it is a task of a line, not a prover's attempt, so its checks carry no attempt id.
 */
export async function runHoleSession(d: HoleSessionDeps, request: HoleSessionRequest): Promise<HoleSessionResult> {
  const real = await d.workbench(request.claimId);
  const checks: { submission?: import("@seshat/core").Submission; report?: import("@seshat/core").ValidationReport; accepted: boolean; finished: boolean } = { accepted: false, finished: false };
  // The workbench with checks that carry no attempt id (the journal knows no attempt of this session).
  const bench: Workbench = Object.assign(Object.create(real) as Workbench, {
    check: async (submission: Parameters<Workbench["check"]>[0], context: Parameters<Workbench["check"]>[1]) => {
      const { attemptId: _none, ...rest } = context;
      return await real.check(submission, rest);
    },
  });
  let verdict: HoleVerdictCall | undefined;
  const verdictTool: AgentTool<ReturnType<typeof verdictParameters>, { summary: string }> = {
    name: "hole_verdict",
    label: "Verdict on the lemma",
    description: "Ends the session with a verdict on the lemma: proved, statement_wrong (it is false) or too_hard. A verdict of proved is checked against the last Lean check, not believed.",
    parameters: verdictParameters(),
    executionMode: "sequential",
    execute: async (_id, params) => {
      verdict = {
        verdict: params.verdict,
        ...(params.argument !== undefined && params.argument.trim() !== "" ? { argument: params.argument } : {}),
        ...(params.negation_proof !== undefined && params.negation_proof.trim() !== "" ? { negation: { proof: params.negation_proof, ...(params.negation_aux !== undefined && params.negation_aux.trim() !== "" ? { aux: params.negation_aux } : {}) } } : {}),
      };
      return { content: [{ type: "text", text: `Verdict recorded: ${params.verdict}.` }], details: { summary: `verdict ${params.verdict}` }, terminate: true };
    },
  };
  const model = await d.resolveModel(d.model);
  const sessionId = `hole_${newId("hs")}`;
  const result = await runSession({
    models: d.models,
    model,
    thinkingLevel: d.thinkingLevel,
    systemPrompt: HOLE_SYSTEM,
    prompt: request.prompt,
    workbench: bench,
    attemptId: sessionId,
    actor: d.actor,
    limits: { turns: request.turns, contextTokens: d.contextTokens },
    ledger: d.ledger,
    onCharge: (cost) => {
      d.journal.emit(
        "model_call.finished",
        {
          modelCallId: newId("mc"),
          line: "M12",
          problemId: d.problemId,
          model: d.model,
          outcome: "ok",
          site: SITE_HOLE,
          requestHash: d.blobs.put(JSON.stringify({ session: request.key, claimId: request.claimId })),
          durationMs: 0,
          usd: cost.usd,
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          ...(cost.cachedInputTokens !== undefined ? { cachedInputTokens: cost.cachedInputTokens } : {}),
        },
        d.actor,
      );
    },
    signal: d.signal,
    wrapUp: false,
    ...(d.turn !== undefined ? { turn: d.turn } : {}),
    ...(d.prices !== undefined ? { prices: d.prices } : {}),
    tools: [verdictTool as AgentTool<never, unknown>],
    editTool: true,
    maskOldChecks: true,
    ...(d.checkTimeoutSec !== undefined ? { checkTimeoutSec: d.checkTimeoutSec } : {}),
    lines: {
      afterCheck: async (check) => {
        checks.submission = check.submission;
        checks.report = check.report;
        checks.accepted ||= check.accepted;
        checks.finished = check.accepted || request.done(check.submission, check.report);
        return checks.finished ? { line: "M12", reason: "the work on the lemma is done" } : undefined;
      },
    },
  });
  return {
    stop: result.stop,
    turns: result.turns,
    usd: result.cost.usd,
    ...(result.submission !== undefined ? { submission: result.submission } : {}),
    ...(result.report !== undefined ? { report: result.report } : {}),
    finished: checks.finished,
    accepted: checks.accepted,
    ...(verdict !== undefined ? { verdict } : {}),
  };
}
