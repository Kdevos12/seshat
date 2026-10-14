import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { type AttemptOutcome, type Journal, newId, type Submission } from "@seshat/core";
import type { Ledger } from "./budget.ts";
import { failureClass, formatCheck } from "./feedback.ts";
import type { Workbench } from "./problem.ts";
import { sessionPrompt, systemPrompt } from "./prompt.ts";
import { ABORT_BUDGET, runSession, type SessionLimits, type SessionResult } from "./session.ts";
import { capabilityTool, type PinnedTool, toolName } from "./tools.ts";

export interface ProverOptions {
  /** `p1`, `p2`...: the prover's name in attempts and actors. */
  name: string;
  workbench: Workbench;
  journal: Journal;
  models: Models;
  model: Model<Api>;
  /** `provider/id`, as recorded in attempts. */
  modelName: string;
  thinkingLevel: ThinkingLevel;
  /** Sessions at most. */
  sessions: number;
  limits: SessionLimits;
  /** Length limit of the notes passed from one session to the next. */
  notesChars: number;
  /** The problem's ledger. */
  ledger: Ledger;
  /** The problem's signal. */
  signal: AbortSignal;
  /** Receives each session's messages, to keep them. */
  transcript?: (attemptId: string, messages: AgentMessage[]) => void;
  /** Capabilities given to the sessions besides lean_check (`direct` ones, checked and pinned by the run). */
  tools?: readonly PinnedTool[];
}

/** Why a prover stopped: it found the candidate, used its sessions, ran out of budget, was stopped, or kept failing. */
export type ProverStop = "solved" | "sessions" | "budget" | "aborted" | "errors";

export interface ProverResult {
  name: string;
  attempts: number;
  stop: ProverStop;
}

/** A prover fails this many sessions in a row (model or Lean unreachable): it stops. */
const MAX_FAILED_SESSIONS = 2;

/**
 * One independent prover, in a Ralph loop: each session is a fresh agent, and only the file as the
 * prover left it and its notes go from one session to the next (agent A of AlphaProof Nexus).
 */
export async function runProver(o: ProverOptions): Promise<ProverResult> {
  const { workbench, journal } = o;
  const actor = `prover:${o.name}`;
  const tools = o.tools ?? [];
  const system = systemPrompt(o.notesChars, tools.map((t) => toolName(t.capability)));
  let regions: Submission = { aux: "", proof: workbench.sketch.originalProof };
  let notes: string | undefined;
  let lastCheck: string | undefined;
  let failed = 0;
  let attempts = 0;
  const done = (stop: ProverStop): ProverResult => ({ name: o.name, attempts, stop });

  for (let session = 1; session <= o.sessions; session++) {
    if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
    if (o.ledger.exhausted) return done("budget");
    const attemptId = newId("att");
    attempts += 1;
    journal.emit(
      "attempt.started",
      { attemptId, claimId: workbench.claimId, prover: o.name, iteration: session, model: o.modelName },
      actor,
    );
    const started = performance.now();
    let result: SessionResult;
    try {
      result = await runSession({
        tools: tools.map((t) => capabilityTool(t.capability, { registry: workbench.registry, attemptId, actor, implementation: t.implementation })),
        models: o.models,
        model: o.model,
        thinkingLevel: o.thinkingLevel,
        systemPrompt: system,
        prompt: sessionPrompt({
          theorem: workbench.sketch.fullName,
          file: workbench.render(regions),
          notes,
          lastCheck,
          session,
          sessions: o.sessions,
        }),
        workbench,
        attemptId,
        actor,
        limits: o.limits,
        ledger: o.ledger,
        signal: o.signal,
        wrapUp: session < o.sessions,
      });
    } catch (error) {
      journal.emit(
        "attempt.finished",
        {
          attemptId, outcome: "error", stoppedBy: "error", error: String(error), durationMs: Math.round(performance.now() - started),
          turns: 0, usd: 0, inputTokens: 0, outputTokens: 0,
        },
        actor,
      );
      throw error;
    } finally {
      // The attempt's state in stateful tools (its SageMath session) ends with it.
      if (tools.length > 0) await workbench.registry.release(attemptId);
    }

    if (result.submission !== undefined) {
      regions = result.submission;
      lastCheck = result.report === undefined ? undefined : formatCheck(result.report);
    }
    if (result.notes !== undefined) {
      notes = clipNotes(result.notes, o.notesChars);
      journal.emit("lesson.recorded", { attemptId, claimId: workbench.claimId, text: notes }, actor);
    }
    const outcome = outcomeOf(result);
    const failure = outcome === "invalid" && result.report !== undefined ? failureClass(result.report) : undefined;
    journal.emit(
      "attempt.finished",
      {
        attemptId,
        outcome,
        ...(failure !== undefined ? { failureClass: failure } : {}),
        stoppedBy: result.stop,
        ...(result.error !== undefined ? { error: result.error.slice(0, 1000) } : {}),
        durationMs: Math.round(performance.now() - started),
        turns: result.turns,
        usd: result.cost.usd,
        inputTokens: result.cost.inputTokens,
        outputTokens: result.cost.outputTokens,
      },
      actor,
    );
    o.transcript?.(attemptId, result.messages);

    switch (outcome) {
      case "valid":
        return done("solved");
      case "budget_exhausted":
        return done("budget");
      case "aborted":
        return done("aborted");
      case "error":
        failed += 1;
        if (failed >= MAX_FAILED_SESSIONS) return done("errors");
        break;
      default:
        failed = 0;
    }
  }
  return done("sessions");
}

function outcomeOf(result: SessionResult): AttemptOutcome {
  switch (result.stop) {
    case "solved":
      return "valid";
    case "budget":
      return "budget_exhausted";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return result.submissions > 0 ? "invalid" : "no_submission";
  }
}

function clipNotes(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}\n[notes cut at ${chars} characters]`;
}
