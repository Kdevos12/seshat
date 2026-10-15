import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { importsOf, type Json, toPlainHeader } from "@seshat/core";
import {
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
  messageOf,
  serverEnv,
  UnavailableError,
  validate,
  type JsonSchema,
} from "@seshat/registry";
import type { GoalsInput, GoalsOutput } from "./goals.ts";
import { leanTimeoutSec } from "./implementation.ts";

export interface PantographOptions {
  /** The REPL's executable, or a launcher such as `lake`. */
  command: string;
  /** Arguments before the modules, e.g. `["env", "/opt/pantograph/.lake/build/bin/repl"]` with `lake`. */
  args?: readonly string[];
  /** The modules the REPL imports when it starts; it cannot import others later. Default `Mathlib`. */
  modules?: readonly string[];
  /** The project directory the REPL runs in. */
  cwd?: string;
  /** Variables added to the few the REPL inherits (`PATH`, `HOME`...), such as `LEAN_PATH`. */
  env?: Record<string, string>;
}

/** The answer of one REPL command: a JSON object, which has `error` and `desc` when the command failed. */
export type PantographAnswer = Record<string, Json>;

/**
 * Pantograph's REPL (v0.3.13) as a child process: started on the first command, it prints
 * `ready.` once its modules are imported, then answers each command line (`<command> <json>`)
 * with one line of JSON. Commands go one at a time. An aborted command kills the process, since
 * Lean cannot be interrupted otherwise, and so does `close`; the next command starts a new one.
 * `generation` changes when a process stops: the goal states it held are gone.
 */
export class PantographRepl {
  readonly options: PantographOptions;
  generation = 0;
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = "";
  private timeoutMs = 0;

  constructor(options: PantographOptions) {
    this.options = options;
  }

  /** Whether a process is running. */
  get running(): boolean {
    return this.child !== undefined;
  }

  /** Sends a command once the commands before it are answered, and returns its answer. */
  request(command: string, payload: Json, signal: AbortSignal): Promise<PantographAnswer> {
    const run = this.queue.then(() => this.send(command, payload, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Lean's time limit for the commands that run tactics or elaborate (Pantograph's option `timeout`). */
  async setTimeout(ms: number, signal: AbortSignal): Promise<void> {
    if (ms === this.timeoutMs && this.running) return;
    await this.request("options.set", { timeout: ms }, signal);
    this.timeoutMs = ms;
  }

  close(): void {
    this.stop();
  }

  private async send(command: string, payload: Json, signal: AbortSignal): Promise<PantographAnswer> {
    signal.throwIfAborted();
    await this.start(signal);
    const child = this.child;
    if (child === undefined) throw new Error("Pantograph stopped");
    const line = await new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.stop();
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = () => signal.removeEventListener("abort", onAbort);
      this.waiting = {
        resolve: (text) => (done(), resolve(text)),
        reject: (error) => (done(), reject(error)),
      };
      child.stdin.write(`${command} ${JSON.stringify(payload)}\n`);
    });
    let answer: unknown;
    try {
      answer = JSON.parse(line);
    } catch {
      throw new Error(`Pantograph answered ${command} with ${line.slice(0, 300)}`);
    }
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error(`Pantograph answered ${command} with ${line.slice(0, 300)}`);
    return answer as PantographAnswer;
  }

  private start(signal: AbortSignal): Promise<void> {
    if (this.ready === undefined) {
      const { command, args = [], modules = ["Mathlib"], cwd, env } = this.options;
      this.timeoutMs = 0;
      this.stderr = "";
      const child = spawn(command, [...args, ...modules], { cwd, env: serverEnv(env), stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.ready = new Promise<void>((resolve, reject) => {
        let started = false;
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          if (this.child !== child) return;
          if (!started) {
            if (line.trim() === "ready.") {
              started = true;
              resolve();
            }
            return;
          }
          const waiting = this.waiting;
          this.waiting = undefined;
          waiting?.resolve(line);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000);
        });
        const gone = (why: string) => {
          const error = started ? new Error(`Pantograph stopped: ${why}`) : new UnavailableError(`Pantograph did not start: ${why}`);
          if (!started) reject(error);
          // A process stopped on purpose has been forgotten already, and its command answered.
          if (this.child !== child) return;
          this.forget();
          const waiting = this.waiting;
          this.waiting = undefined;
          waiting?.reject(error);
        };
        child.on("error", (error) => gone(error.message));
        child.on("exit", (code, sig) => gone(`it exited (${sig ?? `code ${code}`})${this.stderr.trim() !== "" ? `: ${this.stderr.trim()}` : ""}`));
      });
      this.ready.catch(() => undefined);
    }
    const ready = this.ready;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.stop();
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ready.then(
        () => (signal.removeEventListener("abort", onAbort), resolve()),
        (error: unknown) => (signal.removeEventListener("abort", onAbort), reject(error)),
      );
    });
  }

  private stop(): void {
    const child = this.child;
    this.forget();
    this.waiting = undefined;
    child?.kill("SIGKILL");
  }

  /** Drops the process: its goal states are gone, so the states numbered under it are refused. */
  private forget(): void {
    this.child = undefined;
    this.ready = undefined;
    this.generation++;
  }
}

/**
 * A Lean file for `frontend.distil`. The REPL has its modules already and cannot import others,
 * so the file's imports are checked against them and blanked, which keeps the line numbers.
 */
export function distilFile(source: string, modules: readonly string[]): string {
  const missing = importsOf(source).filter((m) => !modules.includes(m));
  if (missing.length > 0) {
    throw new Error(`the file imports ${missing.join(", ")}, which this Lean has not loaded (it has ${modules.join(", ") || "no module"})`);
  }
  const lines = toPlainHeader(source).split("\n");
  let k = 0;
  while (k < lines.length && /^(?:import\s.*)?$/.test((lines[k] ?? "").trim())) {
    lines[k] = "";
    k++;
  }
  return lines.join("\n");
}

interface PantographGoal {
  userName?: string;
  target?: { pp?: string };
  vars?: Array<{ userName?: string; isInaccessible?: boolean; type?: { pp?: string }; value?: { pp?: string } }>;
}

/** A goal as Lean shows it: `case` and its name, the hypotheses (those of one type together), `⊢` and the target. */
export function renderGoal(goal: PantographGoal): string {
  const lines: string[] = [];
  if (goal.userName !== undefined && goal.userName !== "" && goal.userName !== "[anonymous]") lines.push(`case ${goal.userName}`);
  const groups: Array<{ names: string[]; type: string; value?: string }> = [];
  for (const v of goal.vars ?? []) {
    const name = `${v.userName ?? "_"}${v.isInaccessible === true ? "✝" : ""}`;
    const type = v.type?.pp ?? "?";
    const last = groups[groups.length - 1];
    if (v.value?.pp === undefined && last !== undefined && last.value === undefined && last.type === type) last.names.push(name);
    else groups.push({ names: [name], type, ...(v.value?.pp !== undefined ? { value: v.value.pp } : {}) });
  }
  for (const g of groups) lines.push(`${g.names.join(" ")} : ${g.type}${g.value !== undefined ? ` := ${g.value}` : ""}`);
  lines.push(`⊢ ${goal.target?.pp ?? "?"}`);
  return lines.join("\n");
}

function renderMessage(message: Json): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return String(message);
  const severity = typeof message.severity === "string" ? message.severity : "information";
  return `${severity}: ${typeof message.data === "string" ? message.data : JSON.stringify(message.data)}`;
}

function goalsOf(answer: Json | undefined): string[] {
  return Array.isArray(answer) ? answer.map((g) => renderGoal(g as PantographGoal)) : [];
}

function failure(answer: PantographAnswer): Error | undefined {
  return typeof answer.error === "string" ? new Error(`Pantograph: ${typeof answer.desc === "string" ? answer.desc : answer.error}`) : undefined;
}

/** The states of one scope: Pantograph's ids under the scope's own numbers, which start at 0. */
interface ScopeStates {
  next: number;
  states: Map<number, { generation: number; id: number }>;
}

/**
 * `lean.goals` over a `PantographRepl`. Each scope numbers its states from 0; a state names a goal
 * state of the process that made it, so after a restart (an abort, a crash) the older states are
 * refused. `release` deletes a scope's states in Pantograph.
 */
export function pantographImplementation(repl: PantographRepl, version = "pantograph"): ImplementationInstance {
  const scopes = new Map<string, ScopeStates>();
  const modules = repl.options.modules ?? ["Mathlib"];
  const scopeStates = (scope: string | undefined): ScopeStates => {
    if (scope === undefined) throw new Error("lean.goals keeps states, so a call needs a scope");
    const found = scopes.get(scope) ?? { next: 0, states: new Map() };
    scopes.set(scope, found);
    return found;
  };
  const register = (states: ScopeStates, id: Json | undefined): number => {
    if (typeof id !== "number") throw new Error("Pantograph answered without a state");
    const state = states.next++;
    states.states.set(state, { generation: repl.generation, id });
    return state;
  };
  const lookup = (states: ScopeStates, state: number): number => {
    const entry = states.states.get(state);
    if (entry === undefined) throw new Error(`there is no state ${state} in this session`);
    if (entry.generation !== repl.generation) throw new Error(`state ${state} was lost when Lean restarted; start again`);
    return entry.id;
  };
  return {
    async invoke(input, context) {
      const call = input as unknown as GoalsInput;
      const states = scopeStates(context.scope);
      const { signal } = context;
      // Pantograph's own limit comes before the registry's abort, which would kill the process and every scope's states.
      const timeoutMs = leanTimeoutSec(call.timeoutSec, context.timeoutMs) * 1000;
      let output: GoalsOutput;
      switch (call.op) {
        case "start":
        case "sketch": {
          const file =
            call.op === "start"
              ? `${distilFile(call.header ?? "", modules).trimEnd()}\n\ntheorem seshat_goal ${requireText(call.statement, "statement")} := by\n  sorry\n`
              : distilFile(requireText(call.code, "code"), modules);
          await repl.setTimeout(timeoutMs, signal);
          const answer = await repl.request("frontend.distil", { file }, signal);
          const error = failure(answer);
          if (error !== undefined) throw error;
          const targets = Array.isArray(answer.targets) ? (answer.targets as Array<Record<string, Json>>) : [];
          const found = targets.map((t) => ({ state: register(states, t.stateId), goals: goalsOf(t.goals) }));
          if (call.op === "sketch") {
            output = { targets: found };
          } else {
            const [first] = found;
            if (first === undefined || found.length !== 1) throw new Error(`Pantograph found ${found.length} targets in the statement's file`);
            output = first;
          }
          break;
        }
        case "tactic": {
          const id = lookup(states, requireState(call.state));
          await repl.setTimeout(timeoutMs, signal);
          const answer = await repl.request(
            "goal.tactic",
            { stateId: id, ...(call.goal !== undefined ? { goalId: call.goal } : {}), tactic: requireText(call.tactic, "tactic") },
            signal,
          );
          const error = failure(answer);
          if (error !== undefined) throw error;
          const messages = Array.isArray(answer.messages) ? answer.messages.map(renderMessage) : [];
          if (typeof answer.parseError === "string") {
            output = { error: `the tactic does not parse: ${answer.parseError}`, messages };
          } else if (typeof answer.nextStateId !== "number") {
            output = { error: messages.filter((m) => m.startsWith("error")).join("\n") || "the tactic failed", messages };
          } else {
            output = { state: register(states, answer.nextStateId), goals: goalsOf(answer.goals), messages };
          }
          break;
        }
        case "goals": {
          const state = requireState(call.state);
          const answer = await repl.request("goal.print", { stateId: lookup(states, state), goals: true }, signal);
          const error = failure(answer);
          if (error !== undefined) throw error;
          output = { state, goals: goalsOf(answer.goals) };
          break;
        }
      }
      return output as unknown as Json;
    },

    async release(scope, { signal }) {
      const states = scopes.get(scope);
      scopes.delete(scope);
      const ids = [...(states?.states.values() ?? [])].filter((e) => e.generation === repl.generation).map((e) => e.id);
      if (ids.length > 0 && repl.running) await repl.request("goal.delete", { stateIds: ids }, signal);
    },

    async health({ signal }): Promise<HealthCheck> {
      try {
        const answer = await repl.request("stat", {}, signal);
        return typeof answer.nGoals === "number"
          ? { ok: true, detail: `${version}, ${answer.nGoals} goal state(s)` }
          : { ok: false, detail: `Pantograph answered stat with ${JSON.stringify(answer).slice(0, 200)}` };
      } catch (error) {
        return { ok: false, detail: messageOf(error) };
      }
    },

    async close() {
      repl.close();
    },
  };
}

function requireText(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`lean.goals needs ${field} for this op`);
  return value;
}

function requireState(value: number | undefined): number {
  if (value === undefined) throw new Error("lean.goals needs state for this op");
  return value;
}

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    modules: { type: "array", items: { type: "string", minLength: 1 } },
    cwd: { type: "string" },
    env: { type: "object" },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * The registry factory `pantograph`: `lean.goals` over Pantograph's REPL, with the settings
 * `command`, `args`, `modules`, `cwd` and `env` (an empty `cwd` or variable is left out).
 */
export function pantographFactory(): ImplementationFactory {
  return ({ spec, settings }) => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`pantograph: ${problems.join("; ")}`);
    const s = settings as { command: string; args?: string[]; modules?: string[]; cwd?: string; env?: Record<string, Json> };
    const env = Object.fromEntries(Object.entries(s.env ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
    const repl = new PantographRepl({
      command: s.command,
      ...(s.args !== undefined ? { args: s.args } : {}),
      ...(s.modules !== undefined ? { modules: s.modules } : {}),
      ...(s.cwd !== undefined && s.cwd !== "" ? { cwd: s.cwd } : {}),
      env,
    });
    return pantographImplementation(repl, `Pantograph ${spec.version}`);
  };
}
