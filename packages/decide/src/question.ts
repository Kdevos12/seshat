import {
  decisionSiteProblem,
  DECISION_SITES,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
} from "@seshat/core";
import type { DecideQuestion, DecideRequest } from "@seshat/lines";
import { DecisionQuestionError, ForbiddenDecisionError } from "./errors.ts";

/** Jev's context for a request: beyond it the provider switches to a slower, less accurate mode. */
export const JEV_MAX_TOKENS = 32_000;

/**
 * A deliberately high estimate of the tokens of a text: one per three characters. Mathematics,
 * Unicode and Lean names tokenize worse than prose, and an estimate that is too low would send a
 * long request into the long-context mode.
 */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 3);
}

/** The labels an answer is among, in order: a choice's keys, a score's levels, `yes` and `no`. */
export function labelsOf(question: DecideQuestion): string[] {
  switch (question.type) {
    case "choice":
      return Object.keys(question.options);
    case "score":
      return [...question.levels];
    case "noul":
      return ["yes", "no"];
  }
}

/** The text a backend reads: the state, then the question with its options. */
export function renderPrompt(request: DecideRequest): string {
  const q = request.question;
  const parts = [`State:\n${request.state}`, `Question: ${q.instructions}`];
  if (q.type === "choice") {
    parts.push(`Options:\n${Object.entries(q.options).map(([key, text]) => `- ${key}: ${text}`).join("\n")}`);
  } else if (q.type === "score") {
    parts.push(`Levels, lowest first: ${q.levels.join(", ")}`);
  } else {
    parts.push("Answer yes or no.");
  }
  return parts.join("\n\n");
}

/** The estimated tokens of everything a backend is sent for a request. */
export function requestTokens(request: DecideRequest): number {
  return estimateTokens(renderPrompt(request));
}

/**
 * Refuses what `decide` never does (plan change J3) and what is malformed. The forbidden list and the
 * sites are `@seshat/core`'s, which the journal checks again.
 */
export function checkRequest(request: DecideRequest, calibrated = false): void {
  const problem = decisionSiteProblem(request.site);
  if (problem !== undefined) throw new ForbiddenDecisionError(problem);
  const allowed = DECISION_SITES[request.site] ?? [];
  const q = request.question;
  if (!allowed.includes(q.type)) throw new ForbiddenDecisionError(`${request.site} asks ${allowed.join(" or ")}, not a ${q.type}`);
  if (request.use !== undefined && request.use !== "order" && !calibrated) {
    throw new ForbiddenDecisionError(`decide is used to order only: a threshold on a probability needs a reliability curve of the site, and ${request.site} has none (plan change J4)`);
  }
  if (typeof request.state !== "string" || request.state.trim() === "") throw new DecisionQuestionError("a decision needs a state");
  if (typeof q.instructions !== "string" || q.instructions.trim() === "") throw new DecisionQuestionError("a decision needs instructions");
  if (q.type === "choice") {
    const keys = Object.keys(q.options);
    if (keys.length < 2 || keys.length > MAX_CHOICE_OPTIONS) throw new DecisionQuestionError(`a choice has 2 to ${MAX_CHOICE_OPTIONS} options, got ${keys.length}`);
    if (keys.some((key) => key === "")) throw new DecisionQuestionError("an option's key is not empty");
  } else if (q.type === "score") {
    if (!Array.isArray(q.levels) || q.levels.length < MIN_SCORE_LEVELS || q.levels.length > MAX_SCORE_LEVELS) {
      throw new DecisionQuestionError(`a score has ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} levels`);
    }
    if (new Set(q.levels).size !== q.levels.length || q.levels.some((level) => level === "")) throw new DecisionQuestionError("a score's levels are distinct, non-empty names");
  } else if (q.type !== "noul") {
    throw new DecisionQuestionError(`unknown question type ${String((q as { type?: unknown }).type)}`);
  }
}
