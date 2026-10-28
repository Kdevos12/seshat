import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model, Models } from "@earendil-works/pi-ai";
import { type AttemptCarry, type AttemptOutcome, type BlobStore, type Journal, newId, SITE_PROVER_SESSION, type Submission } from "@seshat/core";
import type { AttemptAnnotation } from "@seshat/lines";
import type { FailureClass } from "@seshat/memory";
import { chargedTotals, type Ledger } from "./budget.ts";
import { failureClass, formatCheck } from "./feedback.ts";
import type { OpenedSession, ProblemLines, SessionInfo } from "./line-runtime.ts";
import type { Workbench } from "./problem.ts";
import { sessionPrompt, systemPrompt } from "./prompt.ts";
import { ABORT_BUDGET, runSession, type SessionLimits, type SessionOptions, type SessionResult } from "./session.ts";
import { teamBriefing, teamVeto } from "./team.ts";
import { capabilityTool, type PinnedTool, toolBinding, toolName } from "./tools.ts";
import { isTurnEnded, type Turn } from "./turns.ts";

export interface ProverOptions {
  /** `p1`, `p2`...: the prover's name in attempts and actors. */
  name: string;
  workbench: Workbench;
  journal: Journal;
  /** Keeps what the prover carries from one session to the next. */
  blobs: BlobStore;
  /** The prover's task in the ledger, which the orchestrator started: its attempts work for it. */
  taskId?: string;
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
  /** The prompt cache retention asked of the provider (`SessionOptions.cacheRetention`); absent: its default. */
  cacheRetention?: CacheRetention;
  /** The problem's ledger. */
  ledger: Ledger;
  /** The problem's signal. */
  signal: AbortSignal;
  /** Receives each session's messages, to keep them. */
  transcript?: (attemptId: string, messages: AgentMessage[]) => void;
  /** Capabilities given to the sessions besides lean_check (`direct` ones, checked and pinned by the run). */
  tools?: readonly PinnedTool[];
  /** The problem's enabled lines; absent in M0. */
  lines?: ProblemLines;
  /**
   * The consortium turn, when the run has them. Once it is over the prover starts no session, and a
   * session in flight stops after the response in flight; the prover ends with `turn` and its task stays
   * `running`, as the task of a process that ended does (documentation/human.md).
   */
  turn?: Turn;
  /** The prover picks up where an interrupted run left it, instead of starting. */
  resume?: ProverResume;
  /** Called when the loop has ended, before the lines' `afterProver`: the orchestrator ends the prover's task here. */
  onEnd?: (result: ProverResult) => void;
  /** Called after each attempt's `attempt.finished`: the orchestrator takes the routing decisions about the task here. */
  onAttemptEnd?: (attempt: { attemptId: string; outcome: AttemptOutcome; failureClass?: FailureClass }) => void;
  /** Runs a session. Default: `runSession`; a test replaces it to make the harness fail in the middle of one. */
  session?: (options: SessionOptions) => Promise<SessionResult>;
}

/**
 * Where a prover stood when its run was interrupted, rebuilt from the journal (documentation/ledger.md,
 * "Resume"). A session that the interruption cut counts as a session the prover used: it was started
 * and paid for.
 */
export interface ProverResume {
  /** The number of the last session the prover started; its next one is this plus one. */
  session: number;
  /** The attempts the prover made. */
  attempts: number;
  /** Sessions in a row that ended with an error, at the end of those. */
  failed: number;
  /** What the last session that ended handed on: the file's regions, the text of its last check, the notes. */
  carry?: { regions: Submission; lastCheck?: string; notes?: string };
}

/**
 * Why a prover stopped: it found the candidate, used its sessions, ran out of budget, was stopped,
 * kept failing, a line's `beforeSession` stopped it, or the consortium turn ended (`turn`).
 */
export type ProverStop = "solved" | "sessions" | "budget" | "aborted" | "errors" | "line" | "turn";

export interface ProverResult {
  name: string;
  attempts: number;
  stop: ProverStop;
}

/** A prover fails this many sessions in a row (model or Lean unreachable): it stops. */
const MAX_FAILED_SESSIONS = 2;

/**
 * One independent prover, in a Ralph loop: each session is a fresh agent, and only the file as the
 * prover left it and its notes go from one session to the next (agent A of AlphaProof Nexus). With
 * lines, their `afterProver` hooks run when the loop has ended.
 */
export async function runProver(o: ProverOptions): Promise<ProverResult> {
  const progress = { attempts: o.resume?.attempts ?? 0 };
  let result: ProverResult;
  try {
    result = await proveLoop(o, progress);
  } catch (error) {
    // A line that wanted a model call when the turn was over has not failed: the prover waits for the next turn.
    if (o.turn?.ended === undefined || !isTurnEnded(error)) throw error;
    result = { name: o.name, attempts: progress.attempts, stop: "turn" };
  }
  o.onEnd?.(result);
  // The lines hear of a prover that ended, not of one the turn interrupted: it has not ended, it waits.
  if (result.stop !== "turn") await o.lines?.afterProver({ prover: result.name, stop: result.stop, attempts: result.attempts });
  return result;
}

async function proveLoop(o: ProverOptions, progress: { attempts: number }): Promise<ProverResult> {
  const { workbench, journal } = o;
  const actor = `prover:${o.name}`;
  const tools = o.tools ?? [];
  const strategies = o.lines?.strategies ?? [];
  const system = systemPrompt(o.notesChars, tools.map((t) => toolName(t.capability)));
  const resumed = o.resume;
  let regions: Submission = resumed?.carry?.regions ?? { aux: "", proof: workbench.sketch.originalProof };
  let notes: string | undefined = resumed?.carry?.notes;
  let lastCheck: string | undefined = resumed?.carry?.lastCheck;
  let failed = resumed?.failed ?? 0;
  let attempts = resumed?.attempts ?? 0;
  const done = (stop: ProverStop): ProverResult => ({ name: o.name, attempts, stop });

  for (let session = (resumed?.session ?? 0) + 1; session <= o.sessions; session++) {
    if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
    if (o.ledger.exhausted) return done("budget");
    if (o.turn?.ended !== undefined) return done("turn");
    const attemptId = newId("att");
    let info: SessionInfo = { prover: o.name, session, sessions: o.sessions, attemptId, model: o.modelName, regions };
    let model = o.model;
    if (o.lines !== undefined) {
      const plan = await o.lines.beforeSession(info);
      if (plan.stop !== undefined) return done("line");
      if (plan.skip !== undefined) continue;
      if (plan.model !== undefined) model = plan.model.model;
      info = {
        ...info,
        ...(plan.model !== undefined ? { model: plan.model.name } : {}),
        ...(plan.strategy !== undefined ? { strategy: plan.strategy } : {}),
        ...(plan.subgoal !== undefined ? { subgoal: plan.subgoal } : {}),
      };
      // The problem may have ended while the lines decided.
      if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
      if (o.ledger.exhausted) return done("budget");
      if (o.turn?.ended !== undefined) return done("turn");
    }
    attempts += 1;
    progress.attempts = attempts;
    journal.emit(
      "attempt.started",
      {
        attemptId,
        claimId: workbench.claimId,
        prover: o.name,
        iteration: session,
        model: info.model,
        site: SITE_PROVER_SESSION,
        ...(o.taskId !== undefined ? { taskId: o.taskId } : {}),
        ...(info.strategy !== undefined ? { strategy: info.strategy } : {}),
        ...(info.subgoal !== undefined ? { subgoal: info.subgoal } : {}),
      },
      actor,
    );
    workbench.noteAttempt(attemptId);
    const started = performance.now();
    let result: SessionResult;
    try {
      const opened: OpenedSession | undefined =
        o.lines === undefined ? undefined : await o.lines.openSession(info, ["lean_check", ...tools.map((t) => toolName(t.capability))]);
      const start = regions;
      // The lines' briefing sections, then what the team said (hints, what it asks): after the lines' review, so that no line drops it.
      const sections = [...(opened?.sections ?? []), ...teamBriefing(journal.projection, workbench.claimId)];
      const veto = teamVeto(journal.projection, workbench.claimId);
      result = await (o.session ?? runSession)({
        tools: [
          ...tools.map((t) => {
            const binding = toolBinding(t.capability, { sketch: workbench.sketch, current: () => workbench.lastSubmission(attemptId) ?? start });
            return capabilityTool(t.capability, {
              registry: workbench.registry, attemptId, actor, implementation: t.implementation, ...(binding !== undefined ? { binding } : {}),
            });
          }),
          ...(opened?.tools ?? []),
        ],
        models: o.models,
        model,
        thinkingLevel: o.thinkingLevel,
        systemPrompt: system,
        prompt: sessionPrompt({
          theorem: workbench.sketch.fullName,
          file: workbench.render(regions),
          notes,
          lastCheck,
          session,
          sessions: o.sessions,
          ...(sections.length > 0 ? { sections } : {}),
        }),
        workbench,
        attemptId,
        actor,
        limits: o.limits,
        ledger: o.ledger,
        onCharge: (cost) => journal.emit("attempt.charged", { attemptId, ...cost }, actor),
        signal: o.signal,
        wrapUp: session < o.sessions,
        ...(o.turn !== undefined ? { turn: o.turn } : {}),
        ...(veto !== undefined ? { veto } : {}),
        ...(opened?.hooks !== undefined ? { lines: opened.hooks } : {}),
        ...(strategies.length > 0 ? { strategies } : {}),
        ...(o.cacheRetention !== undefined ? { cacheRetention: o.cacheRetention } : {}),
      });
    } catch (error) {
      // The harness failed in the session. What the session was charged before it failed is spent, and the
      // attempt ends at that cost: a finished attempt is counted at its own totals, not at its charges.
      const turnOver = o.turn?.ended !== undefined && isTurnEnded(error);
      journal.emit(
        "attempt.finished",
        {
          attemptId,
          ...(turnOver ? { outcome: "aborted" as const, stoppedBy: "turn" } : { outcome: "error" as const, stoppedBy: "error", error: String(error) }),
          durationMs: Math.round(performance.now() - started),
          ...chargedTotals(journal.projection.attempt(attemptId)),
        },
        actor,
      );
      throw error;
    } finally {
      // The attempt's state in stateful tools (its SageMath session) ends with it.
      if (tools.length > 0 || o.lines !== undefined) await workbench.registry.release(attemptId);
    }
    const durationMs = Math.round(performance.now() - started);

    if (result.submission !== undefined) {
      regions = result.submission;
      lastCheck = result.report === undefined ? undefined : formatCheck(result.report);
    }
    if (result.notes !== undefined) {
      notes = clipNotes(result.notes, o.notesChars);
      journal.emit("lesson.recorded", { attemptId, claimId: workbench.claimId, text: notes }, actor);
    } else if (result.stop === "turn") {
      // No request for notes is sent once the turn is over: the notes go on as they were, and the harness says what happened.
      const cut = `(The turn ended during session ${session}, after ${result.submissions} check(s); the file and the last check above are where that session stood.)`;
      notes = clipNotes(notes === undefined ? cut : `${notes}\n${cut}`, o.notesChars);
    }
    const outcome = outcomeOf(result);
    const failure =
      outcome === "invalid" && result.report !== undefined
        ? failureClass(result.report, {
            statement: workbench.sketch.statement,
            ...(result.submission !== undefined ? { aux: result.submission.aux } : {}),
          })
        : undefined;
    // What the next session starts from, kept in the journal so that a resumed run can start from it too.
    const carry = (): AttemptCarry => ({
      regions: o.blobs.putJson({ aux: regions.aux, proof: regions.proof }),
      ...(lastCheck !== undefined ? { lastCheck: o.blobs.put(lastCheck) } : {}),
      ...(notes !== undefined ? { notes: o.blobs.put(notes) } : {}),
    });
    const finished = () => ({
      attemptId,
      outcome,
      ...(failure !== undefined ? { failureClass: failure } : {}),
      stoppedBy: result.stop,
      ...(result.error !== undefined ? { error: result.error.slice(0, 1000) } : {}),
      ...(result.declaredStrategy !== undefined ? { declaredStrategy: result.declaredStrategy } : {}),
      durationMs: o.lines === undefined ? Math.round(performance.now() - started) : durationMs,
      turns: result.turns,
      usd: result.cost.usd,
      inputTokens: result.cost.inputTokens,
      outputTokens: result.cost.outputTokens,
      ...(result.cost.cachedInputTokens !== undefined ? { cachedInputTokens: result.cost.cachedInputTokens } : {}),
      carry: carry(),
    });
    if (o.lines === undefined) {
      journal.emit("attempt.finished", finished(), actor);
    } else {
      let annotation: AttemptAnnotation;
      try {
        annotation = await o.lines.afterAttempt({
          attemptId,
          prover: o.name,
          session,
          model: info.model,
          outcome,
          stoppedBy: result.stop,
          ...(failure !== undefined ? { failureClass: failure } : {}),
          ...(result.submission !== undefined ? { submission: result.submission } : {}),
          ...(result.report !== undefined ? { report: result.report } : {}),
          checks: result.submissions,
          turns: result.turns,
          cost: result.cost,
          durationMs,
          ...(result.notes !== undefined ? { notes: result.notes } : {}),
          ...(info.strategy !== undefined ? { strategy: info.strategy } : {}),
          ...(info.subgoal !== undefined ? { subgoal: info.subgoal } : {}),
          ...(result.declaredStrategy !== undefined ? { declaredStrategy: result.declaredStrategy } : {}),
        });
      } catch (error) {
        // A line that wanted a model call after the turn ended has not failed: it annotates nothing.
        if (result.stop === "turn" && isTurnEnded(error)) {
          annotation = {};
        } else {
          // The session is over and its facts stand; the line's failure stops the prover.
          journal.emit("attempt.finished", finished(), actor);
          o.transcript?.(attemptId, result.messages);
          throw error;
        }
      }
      // The notes a line gives replace the model's for the next session; the journal kept the model's own
      // in `lesson.recorded`, and the carry holds the ones the next session starts from.
      if (annotation.notes !== undefined) notes = annotation.notes === "" ? undefined : clipNotes(annotation.notes, o.notesChars);
      journal.emit(
        "attempt.finished",
        {
          ...finished(),
          ...(annotation.strategy !== undefined ? { strategy: annotation.strategy } : {}),
          ...(annotation.premises !== undefined ? { premises: annotation.premises } : {}),
          ...(annotation.failureDetail !== undefined ? { failureDetail: annotation.failureDetail } : {}),
        },
        actor,
      );
    }
    o.onAttemptEnd?.({ attemptId, outcome, ...(failure !== undefined ? { failureClass: failure } : {}) });
    o.transcript?.(attemptId, result.messages);

    if (result.stop === "turn") return done("turn");
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
    case "turn":
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
