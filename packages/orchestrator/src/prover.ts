import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model, Models } from "@earendil-works/pi-ai";
import { type AttemptCarry, type AttemptOutcome, type BlobStore, type Journal, newId, type Provenance, SITE_PROVER_SESSION, type Submission } from "@seshat/core";
import type { LeanSearchPush } from "@seshat/lean-search";
import type { AttemptAnnotation } from "@seshat/lines";
import { classifyFailure, type FailureClass, MemoryStore, recordAcceptedLemmas, stateCard } from "@seshat/memory";
import { type ConsultConfig, CONSULT_TOOL, consultTool } from "./consult.ts";
import { pageForSession } from "./consolidation-show.ts";
import { chargedTotals, type Ledger } from "./budget.ts";
import { failureClass, formatCheck } from "./feedback.ts";
import type { OpenedSession, ProblemLines, SessionInfo } from "./line-runtime.ts";
import type { PriceBook } from "./prices.ts";
import type { Workbench } from "./problem.ts";
import { sessionPrompt, systemPrompt } from "./prompt.ts";
import { fatalProviderError } from "./provider-errors.ts";
import type { RetryPolicy } from "./retry.ts";
import type { RoleBook } from "./roles.ts";
import { ABORT_BUDGET, type PacketMode, runSession, type SessionLimits, type SessionOptions, type SessionResult } from "./session.ts";
import { sketchBriefing } from "./sketch.ts";
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
  /** A candidate text of the system prompt (`RunConfig.prompts`); absent: the merged prompt. */
  systemTemplate?: string;
  /** The prompt cache retention asked of the provider (`SessionOptions.cacheRetention`); absent: its default. */
  cacheRetention?: CacheRetention;
  /** How the session's requests are built from a line's context packet (`SessionOptions.packetMode`); absent: `prefix_tail`. */
  packetMode?: PacketMode;
  /** How a request that a transient error cut is sent again (`SessionOptions.retry`); absent: `REQUEST_RETRY`. */
  retry?: RetryPolicy;
  /** The sessions get the tool `lean_edit` (`SessionOptions.editTool`) and a prompt that says when to use it. */
  editTool?: boolean;
  /** The sessions mask their old check results (`SessionOptions.maskOldChecks`). */
  maskOldChecks?: boolean;
  /** The run's push of verified `lean.search` hits into the check answers (`SessionOptions.appendToCheck`); absent: none. */
  leanSearch?: LeanSearchPush;
  /** The first cases of the statement, computed by the harness (`RunConfig.firstCases`): a titled section of the first session's opening message only. */
  firstCases?: { title: string; text: string };
  /**
   * The next session's opening message carries the state card (plan change CA7, documentation/m0-loop.md, "The state card"), and the
   * prover records what the card needs (the typed detail of the failure, the lemmas Lean accepted). The caller limits `notesChars` to
   * `CARD_NOTES_CHARS`. Absent: off, and the prompts and the journal are what they always were.
   */
  stateCard?: boolean;
  /** The card's size bound in characters (`StateCardOptions.maxChars`); absent: the default. */
  stateCardChars?: number;
  /**
   * The page of an earlier consolidation pass is shown to the sessions, drawn like a lesson (`RunConfig.consolidation`, documentation/consolidation.md).
   * `seed` is the run's draw seed. Absent: off.
   */
  consolidation?: { seed: string | number; problemId: string };
  /** The seconds a Lean check of a session may take (`SessionOptions.checkTimeoutSec`); absent: the workbench's policy. */
  checkTimeoutSec?: number;
  /** The host's prices, passed to the session (`SessionOptions.prices`). */
  prices?: PriceBook;
  /** The problem's ledger. */
  ledger: Ledger;
  /** The problem's signal. */
  signal: AbortSignal;
  /** Receives each session's messages, to keep them. */
  transcript?: (attemptId: string, messages: AgentMessage[]) => void;
  /** Capabilities given to the sessions besides lean_check (`direct` ones, checked and pinned by the run). */
  tools?: readonly PinnedTool[];
  /** The tool `consult` (plan change NL3, beta): one question to another model, answered as text. Absent: the sessions do not have it. */
  consult?: { config: ConsultConfig; resolveModel: (name: string) => Promise<Model<Api>>; problemId: string };
  /**
   * The run's roles (`RunConfig.roles`): with `prover` in them, the sessions are sent the role's sampling settings, and the settings used are recorded
   * on `attempt.started`. The role's model and thinking level are `model` and `thinkingLevel` above. Absent: nothing changes.
   */
  roles?: RoleBook;
  /** The problem's enabled lines; absent in M0. */
  lines?: ProblemLines;
  /**
   * The consortium turn, when the run has them. Once it is over the prover starts no session, and a
   * session in flight stops after the response in flight; the prover ends with `turn` and its task stays
   * `running`, as the task of a process that ended does (documentation/human.md).
   */
  turn?: Turn;
  /** The off-peak option: a session starts after this resolves, which it does at once at an off-peak hour (documentation/human.md, "Off-peak"). */
  waitOffPeak?: () => Promise<void>;
  /** The prover picks up where an interrupted run left it, instead of starting. */
  resume?: ProverResume;
  /**
   * The problem's probe (documentation/scheduler.md, "The budget gate"): the prover runs only `sessions` sessions and then
   * pauses with `probe`, neither ended nor failed, so that the orchestrator decides whether the problem widens. Its `ledger`
   * is a child of the problem's with the probe's cap; running into that cap pauses it too.
   */
  probe?: { sessions: number };
  /**
   * True when the budget that ran out is only the slice a round of the run's budget gave the problem (`RunConfig.budgetRounds`): the prover then
   * pauses with `slice`, its task stays running, and the problem asks for its next slice. Absent: a budget that runs out ends the prover.
   */
  slice?: () => boolean;
  /** The budget gate: asked before each session after a prover's first. A `skip` ends the prover with `gate`. */
  gate?: { minSessions: number; session(who: { prover: string; session: number }): Promise<{ action: string }> };
  /** Called when the loop has ended, before the lines' `afterProver`: the orchestrator ends the prover's task here. */
  onEnd?: (result: ProverResult) => void;
  /** Called after each attempt's `attempt.finished`: the orchestrator takes the routing decisions about the task here. */
  onAttemptEnd?: (attempt: { attemptId: string; outcome: AttemptOutcome; failureClass?: FailureClass }) => void;
  /**
   * The provenance stamp of a record this prover writes, for the model of the session: the attempt
   * and the lesson carry it (documentation/memory.md, "Provenance and epochs"). Absent: no stamp.
   */
  stamp?: (modelId: string) => Provenance;
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
 * kept failing, a line's `beforeSession` stopped it, the consortium turn ended (`turn`), the budget gate skipped its next session
 * (`gate`), or it ran its probe sessions and waits for the gate to widen the problem (`probe`: not an end), or the problem's slice of the run's budget in rounds is spent (`slice`: a pause, not an end, plan change CA8).
 */
export type ProverStop = "solved" | "sessions" | "budget" | "aborted" | "errors" | "line" | "turn" | "probe" | "gate" | "slice";

export interface ProverResult {
  name: string;
  attempts: number;
  stop: ProverStop;
  /** Set when the session's error was a refusal of the model provider that a retry cannot cure (`fatalProviderError`): the prover stopped at once. */
  refusal?: string;
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
  // A prover that ran its probe has not ended either: the gate says whether it goes on. Nor has one whose slice of the run's budget is spent.
  if (result.stop === "probe" || result.stop === "slice") return result;
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
  const system = systemPrompt(o.notesChars, tools.map((t) => toolName(t.capability)), o.systemTemplate, o.editTool === true);
  const cardStore = o.stateCard === true ? new MemoryStore({ journal, blobs: o.blobs }).withActor(actor) : undefined;
  const pageStore = o.consolidation === undefined ? undefined : new MemoryStore({ journal, blobs: o.blobs, actor: "orchestrator" });
  const resumed = o.resume;
  let regions: Submission = resumed?.carry?.regions ?? { aux: "", proof: workbench.sketch.originalProof };
  let notes: string | undefined = resumed?.carry?.notes;
  let lastCheck: string | undefined = resumed?.carry?.lastCheck;
  let failed = resumed?.failed ?? 0;
  let attempts = resumed?.attempts ?? 0;
  const done = (stop: ProverStop): ProverResult => ({ name: o.name, attempts, stop });

  // The probe's cap is its own ledger's: running into it pauses the prover, running into the problem's budget ends it.
  const budgetStop = (): ProverStop => o.slice?.() === true ? "slice" : (o.probe !== undefined && !(o.ledger.parent?.exhausted ?? false) ? "probe" : "budget");
  let lastSession = o.probe === undefined ? o.sessions : Math.min(o.sessions, o.probe.sessions);
  let probeExtended = false;
  for (let session = (resumed?.session ?? 0) + 1; session <= lastSession; session++) {
    if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
    if (o.ledger.exhausted) return done(budgetStop());
    if (o.turn?.ended !== undefined) return done("turn");
    // The wave that started a prover paid for its first session: the gate weighs the ones after it.
    if (o.gate !== undefined && o.probe === undefined && session > o.gate.minSessions) {
      const gated = await o.gate.session({ prover: o.name, session });
      if (gated.action === "skip") return done("gate");
      if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
      if (o.turn?.ended !== undefined) return done("turn");
    }
    if (o.waitOffPeak !== undefined) {
      await o.waitOffPeak();
      if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
      if (o.turn?.ended !== undefined) return done("turn");
    }
    const attemptId = newId("att");
    let info: SessionInfo = { prover: o.name, session, sessions: o.sessions, attemptId, model: o.modelName, regions };
    let model = o.model;
    let thinkingLevel = o.thinkingLevel;
    let temperature: number | undefined;
    let pageSection: { title: string; text: string } | undefined;
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
        ...(plan.included !== undefined ? { included: plan.included } : {}),
        ...(plan.withheld !== undefined ? { withheld: plan.withheld } : {}),
        ...(plan.settings !== undefined ? { settings: plan.settings } : {}),
        ...(plan.exploration !== undefined ? { exploration: plan.exploration } : {}),
      };
      // The settings a line sampled act on the session; the journal records them as they were given.
      if (typeof plan.settings?.thinking === "string") thinkingLevel = plan.settings.thinking as ThinkingLevel;
      if (typeof plan.settings?.temperature === "number") temperature = plan.settings.temperature;
      // The problem may have ended while the lines decided.
      if (o.signal.aborted) return done(o.signal.reason === ABORT_BUDGET ? "budget" : "aborted");
      if (o.ledger.exhausted) return done(budgetStop());
      if (o.turn?.ended !== undefined) return done("turn");
    }
    if (pageStore !== undefined && o.consolidation !== undefined) {
      const shown = pageForSession(pageStore, { claimId: workbench.claimId, problemId: o.consolidation.problemId, prover: o.name, session, seed: o.consolidation.seed });
      if (shown.included !== undefined && shown.withheld !== undefined && shown.included.length + shown.withheld.length > 0) {
        info = { ...info, included: [...(info.included ?? []), ...shown.included], withheld: [...(info.withheld ?? []), ...shown.withheld] };
      }
      pageSection = shown.section;
    }
    // The prover role's settings (`RunConfig.roles`): a temperature or thinking level a line sampled for the session wins, key by key.
    let topP: number | undefined;
    if (o.roles?.has("prover") === true) {
      const use = o.roles.use("prover", info.model, thinkingLevel);
      if (temperature === undefined) temperature = use.temperature;
      topP = use.topP;
      if (use.record !== undefined) info = { ...info, settings: { ...use.record, ...info.settings } };
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
        ...(o.stamp !== undefined ? { provenance: o.stamp(info.model) } : {}),
        ...(info.included !== undefined ? { included: info.included } : {}),
        ...(info.withheld !== undefined ? { withheld: info.withheld } : {}),
        ...(info.settings !== undefined ? { settings: info.settings } : {}),
        ...(info.exploration !== undefined ? { exploration: info.exploration } : {}),
      },
      actor,
    );
    workbench.noteAttempt(attemptId);
    const started = performance.now();
    let result: SessionResult;
    try {
      const opened: OpenedSession | undefined =
        o.lines === undefined ? undefined : await o.lines.openSession(info, ["lean_check", ...(o.editTool === true ? ["lean_edit"] : []), ...(o.consult !== undefined ? [CONSULT_TOOL] : []), ...tools.map((t) => toolName(t.capability))]);
      const start = regions;
      // The lines' briefing sections, then what the team said (hints, what it asks): after the lines' review, so that no line drops it.
      const team = teamBriefing(journal.projection, workbench.claimId);
      // A person's sketch (`harness solve --sketch`) is in the first briefing only: "A sketch from NAME", screened and as data.
      const sketch = session === 1 ? sketchBriefing(journal.projection, workbench.claimId) : [];
      const sections = [...(opened?.sections ?? []), ...(o.firstCases !== undefined && session === 1 ? [o.firstCases] : []), ...sketch, ...(pageSection !== undefined ? [pageSection] : []), ...team];
      const veto = teamVeto(journal.projection, workbench.claimId);
      // The card is made now, from the journal as the session finds it: after the lines' `beforeSession` and the previous session's records.
      const card = cardStore === undefined ? undefined : stateCard(cardStore, workbench.claimId, o.stateCardChars === undefined ? {} : { maxChars: o.stateCardChars })?.text;
      result = await (o.session ?? runSession)({
        tools: [
          ...tools.map((t) => {
            const binding = toolBinding(t.capability, { sketch: workbench.sketch, current: () => workbench.lastSubmission(attemptId) ?? start });
            return capabilityTool(t.capability, {
              registry: workbench.registry, attemptId, actor, implementation: t.implementation, ...(binding !== undefined ? { binding } : {}),
            });
          }),
          ...(o.consult !== undefined
            ? [consultTool({
                config: o.consult.config, journal, blobs: o.blobs, models: o.models, resolveModel: o.consult.resolveModel, ledger: o.ledger,
                problemId: o.consult.problemId, attemptId, actor, signal: o.signal,
                ...(o.prices !== undefined ? { prices: o.prices } : {}), ...(o.turn !== undefined ? { turn: o.turn } : {}),
                ...(o.roles !== undefined ? { roles: o.roles } : {}),
              }) as never]
            : []),
          ...(opened?.tools ?? []),
        ],
        models: o.models,
        model,
        thinkingLevel,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        systemPrompt: system,
        prompt: sessionPrompt({
          theorem: workbench.sketch.fullName,
          file: workbench.render(regions),
          notes,
          lastCheck,
          session,
          sessions: o.sessions,
          ...(card !== undefined ? { card } : {}),
          ...(sections.length > 0 ? { sections } : {}),
        }),
        workbench,
        attemptId,
        actor,
        limits: o.limits,
        ledger: o.ledger,
        onCharge: (cost, retry) => journal.emit("attempt.charged", { attemptId, ...cost, ...(retry !== undefined ? { retry } : {}) }, actor),
        signal: o.signal,
        wrapUp: session < o.sessions,
        ...(o.turn !== undefined ? { turn: o.turn } : {}),
        ...(veto !== undefined ? { veto } : {}),
        ...(team.length > 0 ? { teamSections: team } : {}),
        ...(opened?.hooks !== undefined ? { lines: opened.hooks } : {}),
        ...(strategies.length > 0 ? { strategies } : {}),
        ...(o.cacheRetention !== undefined ? { cacheRetention: o.cacheRetention } : {}),
        ...(o.packetMode !== undefined ? { packetMode: o.packetMode } : {}),
        ...(o.retry !== undefined ? { retry: o.retry } : {}),
        ...(o.prices !== undefined ? { prices: o.prices } : {}),
        ...(o.checkTimeoutSec !== undefined ? { checkTimeoutSec: o.checkTimeoutSec } : {}),
        ...(o.editTool === true ? { editTool: true } : {}),
        ...(o.maskOldChecks === true ? { maskOldChecks: true } : {}),
        ...(o.leanSearch !== undefined ? { appendToCheck: (o.leanSearch as LeanSearchPush).forSession() } : {}),
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
      journal.emit(
        "lesson.recorded",
        { attemptId, claimId: workbench.claimId, text: notes, ...(o.stamp !== undefined ? { provenance: o.stamp(info.model) } : {}) },
        actor,
      );
    } else if (result.stop === "turn") {
      // No request for notes is sent once the turn is over: the notes go on as they were, and the harness says what happened.
      const cut = `(The turn ended during session ${session}, after ${result.submissions} check(s); the file and the last check above are where that session stood.)`;
      notes = clipNotes(notes === undefined ? cut : `${notes}\n${cut}`, o.notesChars);
    }
    const outcome = outcomeOf(result);
    if (cardStore !== undefined && result.report !== undefined) recordAcceptedLemmas(cardStore, workbench.claimId, attemptId, result.report);
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
      ...(cardStore !== undefined && outcome === "invalid" && result.report !== undefined ? failureDetailOf(result.report, workbench.sketch.statement, result.submission?.aux) : {}),
      // A session the rotation's slice cut is no failure, but the rotation reads its last check's class to see Lean progress in it.
      ...(outcome === "budget_exhausted" && o.slice !== undefined && result.report !== undefined
        ? (() => {
            const cls = failureClass(result.report, { statement: workbench.sketch.statement, ...(result.submission !== undefined ? { aux: result.submission.aux } : {}) });
            return cls === undefined ? {} : { lastCheckClass: cls };
          })()
        : {}),
      stoppedBy: result.stop,
      ...(result.error !== undefined ? { error: result.error.slice(0, 1000) } : {}),
      ...(result.declaredStrategy !== undefined ? { declaredStrategy: result.declaredStrategy } : {}),
      durationMs: o.lines === undefined ? Math.round(performance.now() - started) : durationMs,
      turns: result.turns,
      ...(result.retries !== undefined ? { retries: result.retries } : {}),
      ...(result.toolTokens !== undefined ? { toolTokens: result.toolTokens } : {}),
      checks: result.submissions,
      ...(result.holes !== undefined ? { holes: result.holes } : {}),
      usd: result.cost.usd,
      inputTokens: result.cost.inputTokens,
      outputTokens: result.cost.outputTokens,
      ...(result.cost.cachedInputTokens !== undefined ? { cachedInputTokens: result.cost.cachedInputTokens } : {}),
      ...(result.cost.savedUsd !== undefined ? { savedUsd: result.cost.savedUsd } : {}),
      ...(result.cost.offPeakUsd !== undefined ? { offPeakUsd: result.cost.offPeakUsd } : {}),
      ...(result.cost.unchargedUsd !== undefined ? { unchargedUsd: result.cost.unchargedUsd } : {}),
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
    // A probe session the repeat rule ended has not told the gate anything: the session that is told to change approach runs, once, under the probe's ledger.
    if (o.probe !== undefined && !probeExtended && outcome !== "valid" && result.lineCause === "repeated_failure" && lastSession < o.sessions && session === lastSession) {
      probeExtended = true;
      lastSession += 1;
    }
    switch (outcome) {
      case "valid":
        return done("solved");
      case "budget_exhausted":
        return done(budgetStop());
      case "aborted":
        return done("aborted");
      case "error":
        failed += 1;
        {
          const refusal = result.error === undefined ? undefined : fatalProviderError(result.error);
          if (refusal !== undefined) return { ...done("errors"), refusal };
        }
        if (failed >= MAX_FAILED_SESSIONS) return done("errors");
        break;
      default:
        failed = 0;
    }
  }
  return done(lastSession < o.sessions ? "probe" : "sessions");
}

/** The typed detail of a session's last check, for the card; a line's own `failureDetail` comes after it and wins. */
function failureDetailOf(report: NonNullable<SessionResult["report"]>, statement: string, aux: string | undefined): { failureDetail?: string } {
  const failure = classifyFailure(report, { statement, ...(aux !== undefined ? { aux } : {}) });
  return failure === undefined ? {} : { failureDetail: failure.detail };
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
