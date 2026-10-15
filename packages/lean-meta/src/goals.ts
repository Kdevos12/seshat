import type { Json } from "@seshat/core";
import { CapabilityError, type Registry } from "@seshat/registry";
import { errorKindOf, LeanMetaError } from "./meta.ts";

/** The capability (documentation/lean-meta.md#lean-goals). */
export const LEAN_GOALS = "lean.goals";

export interface GoalsInput {
  op: "start" | "tactic" | "goals" | "sketch";
  statement?: string;
  header?: string;
  code?: string;
  state?: number;
  goal?: number;
  tactic?: string;
  timeoutSec?: number;
}

export interface GoalsOutput {
  state?: number;
  goals?: string[];
  targets?: GoalState[];
  messages?: string[];
  error?: string;
}

/** A state of a scope, and its goals as Lean shows them. No goal: that branch is proved. */
export interface GoalState {
  state: number;
  goals: string[];
}

/** What a tactic gave: the next state, or the error that leaves the state as it was. */
export type TacticResult = (GoalState & { messages: string[] }) | { error: string; messages: string[] };

export interface GoalsCallOptions {
  timeoutSec?: number;
  signal?: AbortSignal;
}

/**
 * The typed client of `lean.goals` for one scope: its states are numbered from 0 and stay until
 * `release`. Every call goes through the registry, and a call that gives no answer throws a
 * `LeanMetaError` (`rejected` or `unreachable`, as for `lean.meta`). A tactic Lean refuses is an
 * answer, with its error.
 */
export class LeanGoals {
  readonly scope: string;
  private readonly registry: Registry;
  private readonly attemptId: string | undefined;
  private readonly actor: string | undefined;

  constructor(registry: Registry, options: { scope: string; attemptId?: string; actor?: string }) {
    this.registry = registry;
    this.scope = options.scope;
    this.attemptId = options.attemptId;
    this.actor = options.actor;
  }

  /** The goals of a statement in signature form, read after `header` (opens and definitions). */
  async start(statement: string, options: GoalsCallOptions & { header?: string } = {}): Promise<GoalState> {
    const output = await this.call({ op: "start", statement, ...(options.header !== undefined ? { header: options.header } : {}) }, options);
    return stateOf(output, "start");
  }

  /** One target per declaration of `code` with a `sorry`: its state and the goals of its `sorry`s. */
  async sketch(code: string, options: GoalsCallOptions = {}): Promise<GoalState[]> {
    const output = await this.call({ op: "sketch", code }, options);
    if (output.targets === undefined) throw new LeanMetaError("unreachable", `${LEAN_GOALS} answered sketch without targets`);
    return output.targets;
  }

  /** Runs a tactic on a goal of a state (the first when `goal` is not given). */
  async tactic(state: number, tactic: string, options: GoalsCallOptions & { goal?: number } = {}): Promise<TacticResult> {
    const output = await this.call({ op: "tactic", state, tactic, ...(options.goal !== undefined ? { goal: options.goal } : {}) }, options);
    const messages = output.messages ?? [];
    if (output.error !== undefined) return { error: output.error, messages };
    return { ...stateOf(output, "tactic"), messages };
  }

  /** The goals of a state. */
  async goals(state: number, options: GoalsCallOptions = {}): Promise<string[]> {
    return stateOf(await this.call({ op: "goals", state }, options), "goals").goals;
  }

  /** Drops the scope's states, in every stateful capability. */
  async release(): Promise<void> {
    await this.registry.release(this.scope);
  }

  private async call(input: GoalsInput, options: GoalsCallOptions): Promise<GoalsOutput> {
    try {
      const { output } = await this.registry.invoke(
        LEAN_GOALS,
        { ...input, ...(options.timeoutSec !== undefined ? { timeoutSec: Math.max(1, Math.ceil(options.timeoutSec)) } : {}) } as unknown as Json,
        {
          scope: this.scope,
          ...(this.attemptId !== undefined ? { attemptId: this.attemptId } : {}),
          ...(this.actor !== undefined ? { actor: this.actor } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      return output as GoalsOutput;
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
      throw new LeanMetaError(errorKindOf(error), error.message, error.details);
    }
  }
}

function stateOf(output: GoalsOutput, op: string): GoalState {
  if (output.state === undefined || output.goals === undefined) throw new LeanMetaError("unreachable", `${LEAN_GOALS} answered ${op} without a state and its goals`);
  return { state: output.state, goals: output.goals };
}
