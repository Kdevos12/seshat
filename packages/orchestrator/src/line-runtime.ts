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
import type { Draw, DrawItem, DrawOptions, MemoryStore } from "@seshat/memory";
import { messageOf, type Registry } from "@seshat/registry";
import { routingInfo, type TaskLedger, taskInfo } from "@seshat/scheduler";
import type { Ledger } from "./budget.ts";
import { lineLlm } from "./llm.ts";
import { packetFault } from "./packet.ts";
import type { Workbench } from "./problem.ts";
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
  /** Seeds the draws of unverified items (`SessionContext.draw`). Default: the run's id, so that each run draws differently. */
  seed?: string | number;
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

  constructor(run: RunLines, options: ProblemLinesOptions) {
    this.run = run;
    this.p = options;
  }

  /** The strategy labels `lean_check` offers; none when no enabled line gives any. */
  get strategies(): string[] {
    return this.run.strategies;
  }

  private with<K extends keyof LineHooks>(hook: K): Array<{ entry: EnabledLine; hook: NonNullable<LineHooks[K]> }> {
    return this.run.o.lines.flatMap((entry) => {
      const fn = entry.line.hooks[hook];
      return fn === undefined ? [] : [{ entry, hook: fn as NonNullable<LineHooks[K]> }];
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
    for (const { entry, hook } of this.with("briefing")) {
      const briefing = await call(entry.line.id, "briefing", () => hook(this.sessionContext(entry, info)));
      if (briefing !== undefined) sections.push(briefing);
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
    const signal = this.run.o.signal ?? new AbortController().signal;
    for (const { entry, hook } of this.with("afterProblem")) {
      await call(entry.line.id, "afterProblem", () => hook(this.context(entry, signal), end));
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
    ready: () => projection().tasks({ problemId, statuses: ["ready"] }).map(taskInfo),
    routings: (taskId) => {
      const own = new Set(projection().tasks({ problemId }).map((task) => task.task_id));
      if (taskId !== undefined && !own.has(taskId)) return [];
      return projection()
        .taskRoutes(taskId)
        .filter((route) => own.has(route.task_id))
        .map(routingInfo);
    },
    propose: (proposal) => {
      const result = tasks.propose(who, proposal);
      if (result.accepted) tasks.promote(problemId);
      return result;
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
