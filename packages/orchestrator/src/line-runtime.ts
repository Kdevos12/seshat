import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { type BlobStore, hash32, type Journal, type RandomSource, seeded, type Submission } from "@seshat/core";
import type {
  AttemptAnnotation,
  Briefing,
  Budget,
  EnabledLine,
  FinishedAttempt,
  FrozenPacket,
  JsonObject,
  LineHooks,
  LineId,
  LineTool,
  ProblemContext,
  ProblemEnd,
  Proposal,
  ProverEnd,
  ResumedProblem,
  SessionCheck,
  SessionContext,
  Target,
  TaskApi,
  TaskQuery,
  TranscriptEntry,
} from "@seshat/lines";
import type { Draw, DrawItem, DrawOptions, MemoryStore, ModelRanking } from "@seshat/memory";
import { messageOf, type Registry } from "@seshat/registry";
import { isInterrupted } from "@seshat/lines";
import { ladderDue, NO_PROGRESS, progressed, type Progress, progressOf, type Rung, rungsOf, routingInfo, type TaskLedger, taskInfo, DEFAULT_FRACTIONS } from "@seshat/scheduler";
import type { Ledger } from "./budget.ts";
import { lineLlm } from "./llm.ts";
import { packetFault } from "./packet.ts";
import type { Workbench } from "./problem.ts";
import { steering } from "./team.ts";
import type { Turn } from "./turns.ts";
import type { ClaimBenches } from "./validate.ts";

/** A hook of a line threw: a failure of the harness, which names the line and the hook. */
export class LineError extends Error {
  readonly line: LineId;
  readonly hook: keyof LineHooks;

  constructor(line: LineId, hook: keyof LineHooks, cause: unknown) {
    super(`line ${line} failed in ${hook}: ${messageOf(cause)}`, { cause });
    this.line = line;
    this.hook = hook;
  }
}

async function call<T>(line: LineId, hook: keyof LineHooks, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new LineError(line, hook, error);
  }
}

export interface RunLinesOptions {
  lines: readonly EnabledLine[];
  runId: string;
  journal: Journal;
  blobs: BlobStore;
  registry: Registry;
  memory: MemoryStore;
  benches: ClaimBenches;
  /** The orchestrator's handle on the task ledger: the lines read it through `TaskApi` and propose through it. */
  tasks: TaskLedger;
  models: Models;
  /** `provider/id` of the run's model. */
  model: string;
  /** Looks a `provider/id` up, with its credentials checked. */
  resolveModel: (name: string) => Promise<Model<Api>>;
  thinkingLevel: ThinkingLevel;
  log: (line: string) => void;
  /** The run's stop signal. */
  signal?: AbortSignal;
  /** The consortium turn of the run, when it has them: the lines' model calls stop when it is over. */
  turn?: Turn;
  /** Seeds the draws of unverified items (`SessionContext.draw`). Default: the run's id, so that each run draws differently. */
  seed?: string | number;
  /** The run's models, weakest first, and its budget class; the lines read it as `ProblemContext.ranking`. */
  ranking?: ModelRanking;
}

export interface ProblemLinesOptions {
  problemId: string;
  claimId: string;
  target: Target;
  domain: readonly string[];
  /** The problem's ledger. */
  ledger: Ledger;
  /** The problem's signal. */
  signal: AbortSignal;
  workbench: Workbench;
}

/** The enabled lines of a run, in `LINE_ORDER`, and what their contexts share. */
export class RunLines {
  readonly o: RunLinesOptions;
  private readonly resolved = new Map<string, Promise<Model<Api>>>();

  constructor(options: RunLinesOptions) {
    this.o = options;
  }

  get ids(): LineId[] {
    return this.o.lines.map((entry) => entry.line.id);
  }

  /** The strategy labels the enabled lines classify attempts with, once each. */
  get strategies(): string[] {
    return [...new Set(this.o.lines.flatMap((entry) => entry.line.strategies ?? []))];
  }

  /** Looks a model up once per run. */
  resolveModel(name: string): Promise<Model<Api>> {
    let model = this.resolved.get(name);
    if (model === undefined) {
      model = this.o.resolveModel(name);
      this.resolved.set(name, model);
      model.catch(() => this.resolved.delete(name));
    }
    return model;
  }

  problem(options: ProblemLinesOptions): ProblemLines {
    return new ProblemLines(this, options);
  }
}

/** What a prover tells the lines about a session. */
export interface SessionInfo {
  prover: string;
  session: number;
  sessions: number;
  attemptId: string;
  /** `provider/id`. */
  model: string;
  regions: Submission;
  strategy?: string;
  subgoal?: string;
  /** The unverified items the lines' draws included and withheld, once `beforeSession` has run. */
  included?: string[];
  withheld?: string[];
  /** The settings the lines sampled for the session, and whether the exploration floor drew its strategy. */
  settings?: JsonObject;
  exploration?: boolean;
}

/** What the lines decided for a session about to start, merged in `LINE_ORDER`. */
export interface SessionPlan {
  /** The prover stops, for this reason (`line <id>: ...`). */
  stop?: string;
  /** The session is skipped, for this reason (`line <id>: ...`). */
  skip?: string;
  /** The session's model, when a line chose one. */
  model?: { name: string; model: Model<Api> };
  strategy?: string;
  subgoal?: string;
  /** The unverified items the lines drew into the session and the ones the draws withheld; recorded on `attempt.started`. */
  included?: string[];
  withheld?: string[];
  /** The settings the lines sampled for the session, merged key by key; recorded on `attempt.started`. */
  settings?: JsonObject;
  /** The exploration floor drew the strategy; recorded on `attempt.started`. */
  exploration?: boolean;
}

/** The thinking levels a line may sample for a session (the run's providers' own scale). */
export const SESSION_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What is wrong with the settings a line sampled, or undefined: the keys that act on a session are checked here. */
export function settingsProblem(settings: JsonObject): string | undefined {
  const { temperature, thinking } = settings;
  if (temperature !== undefined && !(typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) {
    return `settings.temperature must be a number from 0 to 2, got ${JSON.stringify(temperature)}`;
  }
  if (thinking !== undefined && !(typeof thinking === "string" && (SESSION_THINKING_LEVELS as readonly string[]).includes(thinking))) {
    return `settings.thinking must be one of ${SESSION_THINKING_LEVELS.join(", ")}, got ${JSON.stringify(thinking)}`;
  }
  return undefined;
}

/** The lines' part in a session that starts: briefing sections, tools, and the in-session hooks. */
export interface OpenedSession {
  sections: Briefing[];
  tools: AgentTool<never, unknown>[];
  hooks?: SessionHooks;
}

/** The hooks a session calls itself. */
export interface SessionHooks {
  /**
   * What replaces the request's messages after the system prompt, or undefined: a string, or a
   * prefix and a tail. `prefix` is the one the session froze, once it has (absent before).
   */
  packet?: (request: number, messages: readonly AgentMessage[], prefix: string | undefined) => Promise<string | FrozenPacket | undefined>;
  /** Before each check: the line that rejects the call, and why. */
  beforeCheck?: (proposal: Proposal) => Promise<{ line: LineId; reason: string } | undefined>;
  /** After each check: the line that stops the session, and why. */
  afterCheck?: (check: SessionCheck) => Promise<{ line: LineId; reason: string } | undefined>;
}

/** The lines of one problem: each line's context, and the hooks at each point of the problem. */
export class ProblemLines {
  private readonly run: RunLines;
  private readonly p: ProblemLinesOptions;
  private readonly contexts = new Map<LineId, ProblemContext>();
  /** What the draws of each session that is being decided have included and withheld, by attempt. */
  private readonly draws = new Map<string, { included: string[]; withheld: string[] }>();
  /** The random source of each (session, line): one stream, so that two draws of a session do not repeat each other. */
  private readonly streams = new Map<string, RandomSource>();

  /** Schedule steps and ladder checks run one at a time: a step works a task to its end while the provers wait. */
  private chain: Promise<void> = Promise.resolve();
  /** The rungs of the problem's ladder, when the ladder is on (line M12 with its `ladder` option and a line with a rung). */
  private readonly rungs: Rung[];
  private readonly fractions: number[];
  /** The Lean progress the ladder last saw, and the problem's spend then. Read from the memory the first time it is needed. */
  private mark: { progress: Progress; atUsd: number } | undefined;

  constructor(run: RunLines, options: ProblemLinesOptions) {
    this.run = run;
    this.p = options;
    const m12 = run.o.lines.find((entry) => entry.line.id === "M12");
    const on = m12 !== undefined && m12.options.ladder === true;
    this.rungs = on ? rungsOf(run.o.lines.map((entry) => entry.line)) : [];
    const given = m12?.options.fractions;
    this.fractions = Array.isArray(given) && given.every((f) => typeof f === "number" && f > 0 && f <= 1) && given.length > 0 ? (given as number[]) : [...DEFAULT_FRACTIONS];
  }

  /** The rung the problem is on: 0 until the ladder moves it up (the journal says). */
  get rung(): number {
    return this.rungs.length === 0 ? 0 : this.run.o.journal.projection.ladderRung(this.p.problemId);
  }

  /** Whether a line works on this problem now: with the ladder on, a line of a rung waits for the problem to reach it. */
  private active(entry: EnabledLine): boolean {
    const wanted = entry.line.rung;
    if (this.rungs.length === 0 || wanted === undefined || wanted <= 0) return true;
    const index = this.rungs.findIndex((rung) => rung.lines.includes(entry.line.id));
    return index >= 0 && index < this.rung;
  }

  /** The strategy labels `lean_check` offers; none when no enabled line gives any. */
  get strategies(): string[] {
    return this.run.strategies;
  }

  private with<K extends keyof LineHooks>(hook: K): Array<{ entry: EnabledLine; hook: NonNullable<LineHooks[K]> }> {
    return this.run.o.lines.flatMap((entry) => {
      const fn = entry.line.hooks[hook];
      return fn === undefined || !this.active(entry) ? [] : [{ entry, hook: fn as NonNullable<LineHooks[K]> }];
    });
  }

  /** The context of a line for this problem; with `signal`, one aborted by that signal instead. */
  context(entry: EnabledLine, signal?: AbortSignal): ProblemContext {
    const cached = signal === undefined ? this.contexts.get(entry.line.id) : undefined;
    if (cached !== undefined) return cached;
    const o = this.run.o;
    const id = entry.line.id;
    const actor = `line:${id}`;
    const own = signal ?? this.p.signal;
    const context: ProblemContext = {
      line: id,
      runId: o.runId,
      problemId: this.p.problemId,
      claimId: this.p.claimId,
      target: this.p.target,
      domain: this.p.domain,
      memory: o.memory.withActor(actor),
      registry: o.registry,
      llm: lineLlm({
        line: id,
        journal: o.journal,
        blobs: o.blobs,
        models: o.models,
        model: o.model,
        resolveModel: (name) => this.run.resolveModel(name),
        thinkingLevel: o.thinkingLevel,
        ledger: this.p.ledger,
        problemId: this.p.problemId,
        signal: own,
        ...(o.turn !== undefined ? { turn: o.turn } : {}),
      }),
      validate: (request) =>
        o.benches.validate(request, {
          actor,
          signal: own,
          problem: { problemId: this.p.problemId, claimId: this.p.claimId, workbench: this.p.workbench },
        }),
      budget: budgetOf(this.p.ledger),
      tasks: taskApi(o.tasks, o.journal, { problemId: this.p.problemId, claimId: this.p.claimId, line: id }),
      log: (text) => o.log(`${this.p.problemId} [${id}] ${text}`),
      signal: own,
      options: entry.options,
      ...(o.seed !== undefined ? { seed: o.seed } : {}),
      ...(o.ranking !== undefined ? { ranking: o.ranking } : {}),
    };
    if (signal === undefined) this.contexts.set(id, context);
    return context;
  }

  /** `deciding`: the session has not started, so a draw can still be recorded on its `attempt.started`. */
  private sessionContext(entry: EnabledLine, info: SessionInfo, deciding = false): SessionContext {
    const drawn = (): { included: string[]; withheld: string[] } =>
      deciding ? (this.draws.get(info.attemptId) ?? { included: [], withheld: [] }) : { included: info.included ?? [], withheld: info.withheld ?? [] };
    return {
      ...this.context(entry),
      prover: info.prover,
      session: info.session,
      sessions: info.sessions,
      attemptId: info.attemptId,
      model: info.model,
      regions: info.regions,
      ...(info.strategy !== undefined ? { strategy: info.strategy } : {}),
      ...(info.subgoal !== undefined ? { subgoal: info.subgoal } : {}),
      ...(info.settings !== undefined ? { settings: info.settings } : {}),
      ...(info.exploration !== undefined ? { exploration: info.exploration } : {}),
      draw: (items, options) => {
        if (!deciding) {
          throw new Error(`line ${entry.line.id}: the attempt ${info.attemptId} has started and its draw is recorded on attempt.started: draw the unverified items in beforeSession`);
        }
        return this.draw(entry.line.id, info, items, options);
      },
      get drawn() {
        const { included, withheld } = drawn();
        return { included: [...included], withheld: [...withheld] };
      },
    };
  }

  /**
   * A line's draw for a session about to start: the unverified items it selected, drawn with
   * `MemoryStore.draw` from the run's seeded source, and noted for `attempt.started`. The stream is
   * seeded by the run's seed, the problem, the prover, the session and the line, so the same run draws
   * the same. An item already drawn for this session keeps its first outcome.
   */
  private draw(line: LineId, info: SessionInfo, items: readonly (string | DrawItem)[], options?: Partial<DrawOptions>): Draw {
    const noted = this.draws.get(info.attemptId) ?? { included: [], withheld: [] };
    this.draws.set(info.attemptId, noted);
    const decided = (id: string) => noted.included.includes(id) || noted.withheld.includes(id);
    const fresh = items.filter((item) => !decided(typeof item === "string" ? item : item.id));
    const key = `${this.run.o.seed ?? this.run.o.runId}:draw:${this.p.problemId}:${info.prover}:${info.session}:${line}`;
    let random = this.streams.get(key);
    if (random === undefined) {
      random = seeded(hash32(key));
      this.streams.set(key, random);
    }
    const drawn = this.run.o.memory.draw(fresh, random, options);
    noted.included.push(...drawn.included);
    noted.withheld.push(...drawn.withheld);
    const ids = items.map((item) => (typeof item === "string" ? item : item.id));
    return {
      ...drawn,
      included: ids.filter((id) => noted.included.includes(id)),
      withheld: ids.filter((id) => noted.withheld.includes(id)),
    };
  }

  /**
   * Runs the lines' `beforeProvers` in order, and stops calling them once the problem is settled
   * (a proof of its claim passed) or its signal is aborted.
   */
  async beforeProvers(): Promise<void> {
    for (const { entry, hook } of this.with("beforeProvers")) {
      if (this.p.workbench.candidate !== undefined || this.p.signal.aborted) return;
      await call(entry.line.id, "beforeProvers", () => hook(this.context(entry)));
      if (this.p.workbench.candidate !== undefined) this.log(`line ${entry.line.id} settled the problem before the provers`);
    }
  }

  /**
   * The lines' start of a problem in a resumed process. A line that rebuilds its state gets
   * `resumeProblem` with what the journal holds, whether or not the problem is settled, since its
   * later hooks need the state it sets up. Any other line gets `beforeProvers`, as a process that
   * was not interrupted would give it, unless the provers had started (the hook ran then, and what
   * it did is in the journal), and with the stop that `beforeProvers` has once the problem is
   * settled.
   */
  async resumeProblem(held: ResumedProblem): Promise<void> {
    for (const entry of this.run.o.lines) {
      const id = entry.line.id;
      if (!this.active(entry)) continue;
      const rebuild = entry.line.resume === "rebuild" ? entry.line.hooks.resumeProblem : undefined;
      if (rebuild !== undefined) {
        await call(id, "resumeProblem", () => rebuild(this.context(entry), held));
        continue;
      }
      const hook = entry.line.hooks.beforeProvers;
      if (hook === undefined || held.begun) continue;
      if (this.p.workbench.candidate !== undefined || this.p.signal.aborted) continue;
      await call(id, "beforeProvers", () => hook(this.context(entry)));
      if (this.p.workbench.candidate !== undefined) this.log(`line ${id} settled the problem before the provers`);
    }
  }

  /**
   * The lines' decisions for a session, merged in order: a later line's model, strategy or
   * subgoal wins, and the first `stop` or `skip` ends the merge. A model a line chose is looked up
   * here, so that a wrong one is that line's failure.
   */
  async beforeSession(info: SessionInfo): Promise<SessionPlan> {
    // Between two sessions the scheduling line works its ready tasks (documentation/lines.md, "Scheduling"), and the ladder looks at the problem.
    await this.step();
    const plan: SessionPlan = {};
    let chosen: { line: LineId; name: string } | undefined;
    try {
      for (const { entry, hook } of this.with("beforeSession")) {
        const id = entry.line.id;
        const decision = await call(id, "beforeSession", () => hook(this.sessionContext(entry, info, true)));
        if (decision === undefined) continue;
        if (decision.stop !== undefined) {
          this.log(`${info.prover} stops before session ${info.session}: line ${id}: ${decision.stop}`);
          return { stop: `line ${id}: ${decision.stop}` };
        }
        if (decision.skip !== undefined) {
          this.log(`${info.prover} skips session ${info.session}: line ${id}: ${decision.skip}`);
          return { skip: `line ${id}: ${decision.skip}` };
        }
        if (decision.model !== undefined) chosen = { line: id, name: decision.model };
        if (decision.strategy !== undefined) plan.strategy = decision.strategy;
        if (decision.subgoal !== undefined) plan.subgoal = decision.subgoal;
        if (decision.settings !== undefined) {
          const problem = settingsProblem(decision.settings);
          if (problem !== undefined) throw new LineError(id, "beforeSession", problem);
          plan.settings = { ...plan.settings, ...decision.settings };
        }
        if (decision.exploration !== undefined) plan.exploration = decision.exploration;
      }
      if (chosen !== undefined) {
        const { line, name } = chosen;
        plan.model = { name, model: await call(line, "beforeSession", () => this.run.resolveModel(name)) };
      }
      // What the draws decided is recorded on the attempt, which the prover starts next.
      const drawn = this.draws.get(info.attemptId);
      if (drawn !== undefined && drawn.included.length + drawn.withheld.length > 0) {
        plan.included = [...drawn.included];
        plan.withheld = [...drawn.withheld];
      }
      return plan;
    } finally {
      this.draws.delete(info.attemptId);
    }
  }

  /**
   * Prepares a session that starts: the lines' briefing sections and tools, and the hooks the
   * session calls. `taken` are the names of the session's other tools.
   */
  async openSession(info: SessionInfo, taken: readonly string[]): Promise<OpenedSession> {
    let sections: Briefing[] = [];
    for (const entry of this.run.o.lines.filter((e) => this.active(e))) {
      const id = entry.line.id;
      const one = entry.line.hooks.briefing;
      if (one !== undefined) {
        const briefing = await call(id, "briefing", () => one(this.sessionContext(entry, info)));
        if (briefing !== undefined) sections.push(briefing);
      }
      const several = entry.line.hooks.briefingSections;
      if (several !== undefined) {
        const more = await call(id, "briefingSections", () => several(this.sessionContext(entry, info)));
        if (more !== undefined) sections.push(...more);
      }
    }
    // Each line reviews the sections as the lines before it left them: it may drop or reword, not add.
    for (const { entry, hook } of this.with("reviewBriefing")) {
      const id = entry.line.id;
      const reviewed = await call(id, "reviewBriefing", () => hook(this.sessionContext(entry, info), sections));
      if (reviewed === undefined) continue;
      if (!isReview(reviewed, sections)) throw new LineError(id, "reviewBriefing", "a review may drop or reword sections, not add, replace or reorder them");
      sections = reviewed;
    }
    const tools: AgentTool<never, unknown>[] = [];
    const names = new Set(taken);
    for (const { entry, hook } of this.with("tools")) {
      const id = entry.line.id;
      const specs = await call(id, "tools", () => hook(this.sessionContext(entry, info)));
      for (const spec of specs) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name)) throw new LineError(id, "tools", `bad tool name ${JSON.stringify(spec.name)}`);
        if (names.has(spec.name)) throw new LineError(id, "tools", `the tool name ${spec.name} is taken`);
        names.add(spec.name);
        tools.push(agentTool(id, spec, this.p.signal));
      }
    }
    const packetLine = this.with("contextPacket")[0];
    const guards = this.with("beforeCheck");
    const checkers = this.with("afterCheck");
    let differed = false;
    const hooks: SessionHooks = {
      ...(packetLine !== undefined
        ? {
            packet: (request: number, messages: readonly AgentMessage[], prefix: string | undefined) =>
              call(packetLine.entry.line.id, "contextPacket", async () => {
                const answer = await packetLine.hook(this.sessionContext(packetLine.entry, info), {
                  request,
                  transcript: transcriptOf(messages),
                  ...(prefix !== undefined ? { prefix } : {}),
                });
                const fault = packetFault(answer);
                if (fault !== undefined) throw new Error(fault);
                // The session sends the frozen prefix whatever the line answers; say so once, in the progress log.
                if (prefix !== undefined && typeof answer === "object" && answer.prefix !== prefix && !differed) {
                  differed = true;
                  this.log(`${info.prover} session ${info.session}: line ${packetLine.entry.line.id} answered a prefix that differs from the frozen one; the session keeps the first (said once per session)`);
                }
                return answer;
              }),
          }
        : {}),
      ...(guards.length > 0
        ? {
            beforeCheck: async (proposal: Proposal) => {
              for (const { entry, hook } of guards) {
                const id = entry.line.id;
                const veto = await call(id, "beforeCheck", () => hook(this.sessionContext(entry, info), proposal));
                if (veto !== undefined) {
                  this.log(`${info.prover} session ${info.session}: line ${id} rejects a check: ${veto.reject}`);
                  return { line: id, reason: veto.reject };
                }
              }
              return undefined;
            },
          }
        : {}),
      ...(checkers.length > 0
        ? {
            afterCheck: async (check: SessionCheck) => {
              for (const { entry, hook } of checkers) {
                const id = entry.line.id;
                const decision = await call(id, "afterCheck", () => hook(this.sessionContext(entry, info), check));
                if (decision?.stop !== undefined) {
                  this.log(`${info.prover} session ${info.session}: line ${id} stops it: ${decision.stop}`);
                  return { line: id, reason: decision.stop };
                }
              }
              return undefined;
            },
          }
        : {}),
    };
    const inSession = hooks.packet !== undefined || hooks.beforeCheck !== undefined || hooks.afterCheck !== undefined;
    return { sections, tools, ...(inSession ? { hooks } : {}) };
  }

  /** The lines' annotations of an attempt, merged in order: a later line's fields win. */
  async afterAttempt(attempt: FinishedAttempt): Promise<AttemptAnnotation> {
    const merged: AttemptAnnotation = {};
    for (const { entry, hook } of this.with("afterAttempt")) {
      const annotation = await call(entry.line.id, "afterAttempt", () => hook(this.context(entry), attempt));
      if (annotation?.strategy !== undefined) merged.strategy = annotation.strategy;
      if (annotation?.premises !== undefined) merged.premises = annotation.premises;
      if (annotation?.failureDetail !== undefined) merged.failureDetail = annotation.failureDetail;
      if (annotation?.notes !== undefined) merged.notes = annotation.notes;
    }
    return merged;
  }

  /** The lines' `afterProver`, when a prover has ended. */
  async afterProver(end: ProverEnd): Promise<void> {
    for (const { entry, hook } of this.with("afterProver")) {
      await call(entry.line.id, "afterProver", () => hook(this.context(entry), end));
    }
  }

  /** The lines' `afterProblem`, with the run's signal: the problem's own may be aborted by now. */
  async afterProblem(end: ProblemEnd): Promise<void> {
    // The tasks that are still ready are worked now, with what the problem's budget has left, before the lines close the problem.
    await this.step(true);
    const signal = this.run.o.signal ?? new AbortController().signal;
    for (const { entry, hook } of this.with("afterProblem")) {
      await call(entry.line.id, "afterProblem", () => hook(this.context(entry, signal), end));
    }
  }


  /** Runs `work` after the work already queued: the problem's schedule steps and ladder checks never overlap. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * One schedule step: the tasks the scheduling line proposed are worked, as many as its `stepTasks` option allows (all of them, when the problem's provers are over). For each: the lines that assign owners do (the fleet), the scheduling line chooses, the
   * orchestrator starts the task, the line does the work, and the task ends by what the line answers and its criterion.
   * A task whose work was interrupted stays `running`; the resumed run makes it `ready` again.
   */
  async step(drain = false): Promise<void> {
    const entry = this.run.o.lines.find((e) => e.line.hooks.schedule !== undefined && this.active(e));
    if (entry === undefined && this.rungs.length === 0) return;
    await this.serial(async () => {
      if (entry !== undefined) {
        const per = typeof entry.options.stepTasks === "number" ? Math.max(1, Math.floor(entry.options.stepTasks)) : 1;
        await this.runTasks(entry, drain ? Number.POSITIVE_INFINITY : per);
      }
      await this.checkLadder();
    });
  }

  private async runTasks(entry: EnabledLine, count: number): Promise<void> {
    const id = entry.line.id;
    const tasks = this.run.o.tasks;
    const schedule = entry.line.hooks.schedule as NonNullable<LineHooks["schedule"]>;
    for (let n = 0; n < count; n++) {
      if (this.p.workbench.candidate !== undefined || this.p.signal.aborted) return;
      tasks.promote(this.p.problemId);
      const context = this.context(entry);
      const ready = context.tasks.ready().filter((task) => task.proposedBy !== undefined);
      for (const { entry: other, hook } of this.with("assignOwners")) await call(other.line.id, "assignOwners", () => hook(this.context(other), ready));
      const choice = await call(id, "schedule", () => schedule(context, context.tasks.ready().filter((task) => task.proposedBy !== undefined)));
      if (choice === undefined) return;
      const row = tasks.get(choice.taskId);
      if (row === undefined || row.status !== "ready" || row.problem_id !== this.p.problemId) {
        throw new LineError(id, "schedule", `${choice.taskId} is not a ready task of this problem`);
      }
      tasks.start(choice.taskId, `scheduled by line ${id}: ${choice.reason}`);
      this.log(`task ${choice.taskId} starts: ${choice.reason}`);
      let end;
      try {
        end = await call(id, "schedule", () => choice.run(tasks.get(choice.taskId)?.owner ?? `line:${id}`));
      } catch (error) {
        // A process that ended, or a turn that ended, leaves the task running; the resumption gives it back.
        if (isInterrupted(error) || (error instanceof LineError && isInterrupted(error.cause))) throw error;
        tasks.fail(choice.taskId, `line ${id} failed: ${messageOf(error)}`);
        tasks.promote(this.p.problemId);
        throw error;
      }
      if (end.ended === "done" && tasks.completeIfHolds(choice.taskId, end.reason)) {
        // done
      } else if (end.ended === "done") {
        tasks.fail(choice.taskId, `${end.reason}, but the task's criterion does not hold`);
      } else if (this.p.signal.aborted) {
        tasks.cancel(choice.taskId, `the problem ended: ${end.reason}`);
      } else {
        tasks.fail(choice.taskId, end.reason);
      }
      tasks.promote(this.p.problemId);
      await this.checkLadder();
    }
  }

  /** The ladder's progress mark: the last Lean progress and what the problem had spent then, from the memory. */
  private markOf(): { progress: Progress; atUsd: number } {
    if (this.mark !== undefined) return this.mark;
    const nodes = this.run.o.memory.nodes("ladder_progress", { claimId: this.p.claimId }).filter((node) => (node.data as { problemId?: string }).problemId === this.p.problemId);
    const last = nodes.at(-1)?.data as { proved?: number; holes?: number | null; atUsd?: number } | undefined;
    this.mark =
      last === undefined
        ? { progress: NO_PROGRESS, atUsd: 0 }
        : { progress: { proved: last.proved ?? 0, holes: typeof last.holes === "number" ? last.holes : undefined }, atUsd: last.atUsd ?? 0 };
    return this.mark;
  }

  /**
   * Moves the problem up its ladder when a fraction of its budget has been spent since the last Lean progress (PE4). Lean
   * progress is a new proved subclaim, or fewer open holes in the best healthy sketch; it moves the mark. The move is
   * the orchestrator's own: the journal refuses `ladder.escalated` unless the spend reaches the threshold it names.
   */
  private async checkLadder(): Promise<void> {
    if (this.rungs.length === 0 || this.p.workbench.candidate !== undefined || this.p.signal.aborted) return;
    const memory = this.run.o.memory;
    const mark = this.markOf();
    const now = progressOf(memory, this.p.problemId, this.p.claimId);
    const spent = this.p.ledger.usd;
    const why = progressed(mark.progress, now);
    if (why !== undefined) {
      this.mark = { progress: { proved: Math.max(now.proved, mark.progress.proved), holes: now.holes === undefined ? mark.progress.holes : mark.progress.holes === undefined ? now.holes : Math.min(now.holes, mark.progress.holes) }, atUsd: spent };
      memory.recordNode({ kind: "ladder_progress", claimId: this.p.claimId, data: { problemId: this.p.problemId, proved: this.mark.progress.proved, holes: this.mark.progress.holes ?? null, atUsd: spent, why } });
      this.log(`Lean progress: ${why}`);
      return;
    }
    const budget = this.p.ledger.limitUsd;
    if (budget === undefined) return;
    const due = ladderDue(this.rungs, this.fractions, { rung: this.rung, sinceProgressUsd: spent - mark.atUsd, budgetUsd: budget });
    if (due === undefined) return;
    const reason = `${(spent - mark.atUsd).toFixed(4)} of ${budget} dollars spent without Lean progress (${mark.progress.proved} subclaim(s) proved${mark.progress.holes === undefined ? ", no healthy sketch" : `, ${mark.progress.holes} open hole(s) in the best healthy sketch`})`;
    this.run.o.journal.emit(
      "ladder.escalated",
      { problemId: this.p.problemId, from: due.from, to: due.to, lines: due.lines, threshold: due.threshold, sinceProgressUsd: spent - mark.atUsd, budgetUsd: budget, reason },
      "orchestrator",
    );
    this.log(`rung ${due.from} to ${due.to}: ${reason}; the lines ${due.lines.join(", ")} start`);
    // The lines of the new rung start on the problem as they would have at its beginning.
    for (const entry of this.run.o.lines) {
      if (!due.lines.includes(entry.line.id)) continue;
      const hook = entry.line.hooks.beforeProvers;
      if (hook === undefined || this.p.workbench.candidate !== undefined || this.p.signal.aborted) continue;
      await call(entry.line.id, "beforeProvers", () => hook(this.context(entry)));
    }
  }

  private log(text: string): void {
    this.run.o.log(`${this.p.problemId}: ${text}`);
  }
}

/**
 * Whether `reviewed` is `sections` with some dropped and some reworded: each section it keeps has
 * the title of one of the sections it was given, in the same order. A title that was not given is
 * an added or replaced section, and a title out of order is a moved one.
 */
function isReview(reviewed: readonly Briefing[], sections: readonly Briefing[]): boolean {
  let from = 0;
  for (const section of reviewed) {
    const at = sections.findIndex((candidate, k) => k >= from && candidate.title === section.title);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

/**
 * The ledger as one line sees it for one problem: the problem's tasks, read from the projection,
 * and `propose`, which the orchestrator commits or refuses (`TaskLedger.propose`). A task that was
 * accepted is moved to `ready` when its dependencies are done, so that a line reading `ready`
 * sees what may start.
 */
function taskApi(tasks: TaskLedger, journal: Journal, who: { problemId: string; claimId: string; line: LineId }): TaskApi {
  const { problemId } = who;
  const projection = () => journal.projection;
  return {
    list: (query: TaskQuery = {}) =>
      projection()
        .tasks({
          problemId,
          ...(query.statuses !== undefined ? { statuses: query.statuses } : {}),
          ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
          ...(query.claimId !== undefined ? { claimId: query.claimId } : {}),
          ...(query.owner !== undefined ? { owner: query.owner } : {}),
        })
        .map(taskInfo),
    get: (taskId) => {
      const row = projection().task(taskId);
      return row !== undefined && row.problem_id === problemId ? taskInfo(row) : undefined;
    },
    // What the team asked to be worked on first comes first (documentation/human.md); otherwise the order tasks were made in.
    ready: () => {
      const focus = steering(projection()).focus;
      const rank = (claimId: string | null) => (claimId === null ? focus.length : focus.indexOf(claimId) < 0 ? focus.length : focus.indexOf(claimId));
      return projection()
        .tasks({ problemId, statuses: ["ready"] })
        .map((row, order) => ({ row, order }))
        .sort((a, b) => rank(a.row.claim_id) - rank(b.row.claim_id) || a.order - b.order)
        .map(({ row }) => taskInfo(row));
    },
    routings: (taskId) => {
      const own = new Set(projection().tasks({ problemId }).map((task) => task.task_id));
      if (taskId !== undefined && !own.has(taskId)) return [];
      return projection()
        .taskRoutes(taskId)
        .filter((route) => own.has(route.task_id))
        .map(routingInfo);
    },
    propose: (proposal) => {
      // A claim the team gave up gets no more tasks.
      const about = proposal.claimId ?? who.claimId;
      if (steering(projection()).dropped.has(about)) return { accepted: false, reason: `the team dropped claim ${about}: no task is made for it` };
      const result = tasks.propose(who, proposal);
      if (result.accepted) tasks.promote(problemId);
      return result;
    },
    assign: (taskId, owner, reason) => {
      if (projection().task(taskId)?.problem_id !== problemId) return { assigned: false, reason: `${taskId} is not a task of this problem` };
      try {
        tasks.assign(taskId, owner, reason);
        return { assigned: true };
      } catch (error) {
        return { assigned: false, reason: messageOf(error) };
      }
    },
  };
}

function budgetOf(ledger: Ledger): Budget {
  return {
    get limitUsd() {
      return ledger.limitUsd;
    },
    get usd() {
      return ledger.usd;
    },
    get exhausted() {
      return ledger.exhausted;
    },
  };
}

/** A line's tool as a tool of a prover's session. An error goes back to the model as a tool error. */
function agentTool(line: LineId, spec: LineTool, fallback: AbortSignal): AgentTool<never, unknown> {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    // A plain JSON Schema, which pi validates as it is.
    parameters: spec.parameters as never,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      try {
        const text = await spec.run(params as JsonObject, signal ?? fallback);
        return { content: [{ type: "text", text }], details: { line } };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${messageOf(error)}` }], details: { line }, isError: true };
      }
    },
  };
}

/** A session's messages as the lines read them: the system messages left out, thinking dropped. */
export function transcriptOf(messages: readonly AgentMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!("role" in message)) continue;
    switch (message.role) {
      case "user": {
        const text = typeof message.content === "string" ? message.content : message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
        entries.push({ role: "user", text });
        break;
      }
      case "assistant": {
        const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
        const toolCalls = message.content.flatMap((c) => (c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments as JsonObject }] : []));
        entries.push({ role: "assistant", text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
        break;
      }
      case "toolResult":
        entries.push({
          role: "tool",
          text: message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"),
          tool: message.toolName,
          ...(message.isError ? { isError: true } : {}),
        });
        break;
      default:
        break;
    }
  }
  return entries;
}
