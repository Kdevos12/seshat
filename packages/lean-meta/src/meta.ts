import type { Json } from "@seshat/core";
import { CapabilityError, type Registry } from "@seshat/registry";

/** The capability (documentation/lean-meta.md). */
export const LEAN_META = "lean.meta";

/** The header a statement is read under when it has none. */
export const DEFAULT_HEADER = "import Mathlib";

/** Lean's heartbeat limit for `defeq` (`maxHeartbeats`, in thousands) when the caller gives none. */
export const DEFAULT_HEARTBEATS = 20_000;

/** A fact to compare a statement with (`instances`): a statement, or a declaration of the header. */
export interface MetaFact {
  /** Its name in the answer. Without a statement, the name of a declaration of the header or of its imports. */
  name: string;
  /** In signature form. */
  statement?: string;
}

export type LeanMetaInput =
  | { op: "hash"; statement: string; header?: string; simp?: string[]; timeoutSec?: number }
  | { op: "defeq"; statement: string; other: string; header?: string; heartbeats?: number; timeoutSec?: number }
  | { op: "premises"; code: string; declaration: string; timeoutSec?: number }
  | { op: "profile"; statement: string; header?: string; timeoutSec?: number }
  | { op: "instances"; statement: string; facts: MetaFact[]; header?: string; timeoutSec?: number };

export interface LeanMetaOutput {
  id?: string;
  defeq?: boolean | null;
  premises?: string[];
  classes?: string[];
  instances?: string[];
  instanceOf?: string[];
  covers?: string[];
}

export interface StructureProfile {
  /** The classes of its instance binders and of the instance arguments of the constants it applies. */
  classes: string[];
  /** The instances it uses. */
  instances: string[];
}

export interface FactMatches {
  /** The facts the statement is an instance of: each one, once proved, proves it. */
  instanceOf: string[];
  /** The facts that are instances of the statement: the statement, once proved, proves them. */
  covers: string[];
}

export interface MetaCallOptions {
  /** The imports, `open`s and definitions the statements need. Default: `import Mathlib`. */
  header?: string;
  /** Lean's time limit, in seconds. */
  timeoutSec?: number;
  signal?: AbortSignal;
}

/**
 * Why `lean.meta` gave no answer. `rejected`: Lean or the capability refused this input (an
 * elaboration error, an unknown name, a name the schema does not take, Lean's time limit), so the
 * same call would be refused again. `unreachable`: no answer came back (the host has no `lean.meta`,
 * the server is down or lacks SeshatMeta, the call timed out or was aborted, the answer was
 * malformed); the same call may succeed later.
 */
export type LeanMetaErrorKind = "rejected" | "unreachable";

export class LeanMetaError extends Error {
  readonly kind: LeanMetaErrorKind;
  /** Lean's messages, or the registry's details. */
  readonly details: string[];

  constructor(kind: LeanMetaErrorKind, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "LeanMetaError";
    this.kind = kind;
    this.details = [...details];
  }
}

/** The kind of a failed call of `lean.meta`, from the registry's error code. */
export function errorKindOf(error: CapabilityError): LeanMetaErrorKind {
  return error.code === "failed" || error.code === "invalid_input" ? "rejected" : "unreachable";
}

/**
 * The typed client of `lean.meta`. Every call goes through the registry, so it is a recorded tool
 * run on the host's implementation. A call either answers or throws a `LeanMetaError`.
 */
export class LeanMeta {
  private readonly registry: Registry;
  private readonly attemptId: string | undefined;
  private readonly actor: string | undefined;

  constructor(registry: Registry, options: { attemptId?: string; actor?: string } = {}) {
    this.registry = registry;
    this.attemptId = options.attemptId;
    this.actor = options.actor;
  }

  /** The `st1_` id of a statement: the hash of its elaborated term in canonical form. */
  async hash(statement: string, options: MetaCallOptions & { simp?: readonly string[] } = {}): Promise<string> {
    const output = await this.call(
      {
        op: "hash",
        statement,
        ...headerOf(options),
        ...(options.simp !== undefined && options.simp.length > 0 ? { simp: [...options.simp] } : {}),
        ...timeoutOf(options),
      },
      options,
    );
    if (typeof output.id !== "string") throw malformed("hash", "no id");
    return output.id;
  }

  /** Whether two statements are definitionally equal; null when Lean ran out of heartbeats deciding. */
  async defEq(statement: string, other: string, options: MetaCallOptions & { heartbeats?: number } = {}): Promise<boolean | null> {
    const output = await this.call(
      {
        op: "defeq",
        statement,
        other,
        ...headerOf(options),
        ...(options.heartbeats !== undefined ? { heartbeats: options.heartbeats } : {}),
        ...timeoutOf(options),
      },
      options,
    );
    if (output.defeq === undefined) throw malformed("defeq", "no defeq");
    return output.defeq;
  }

  /** The theorems the proof of `declaration` uses, sorted; `code` is the whole file that declares it. */
  async premises(code: string, declaration: string, options: Omit<MetaCallOptions, "header"> = {}): Promise<string[]> {
    const output = await this.call({ op: "premises", code, declaration, ...timeoutOf(options) }, options);
    if (output.premises === undefined) throw malformed("premises", "no premises");
    return output.premises;
  }

  /** The classes and instances a statement involves, sorted. */
  async profile(statement: string, options: MetaCallOptions = {}): Promise<StructureProfile> {
    const output = await this.call({ op: "profile", statement, ...headerOf(options), ...timeoutOf(options) }, options);
    if (output.classes === undefined || output.instances === undefined) throw malformed("profile", "no classes or no instances");
    return { classes: output.classes, instances: output.instances };
  }

  /** Which facts the statement is an instance of, and which facts it covers, by their names. */
  async instances(statement: string, facts: readonly MetaFact[], options: MetaCallOptions = {}): Promise<FactMatches> {
    const output = await this.call(
      { op: "instances", statement, facts: facts.map((f) => ({ ...f })), ...headerOf(options), ...timeoutOf(options) },
      options,
    );
    if (output.instanceOf === undefined || output.covers === undefined) throw malformed("instances", "no instanceOf or no covers");
    return { instanceOf: output.instanceOf, covers: output.covers };
  }

  private async call(input: LeanMetaInput, options: { signal?: AbortSignal }): Promise<LeanMetaOutput> {
    try {
      const { output } = await this.registry.invoke(LEAN_META, input as unknown as Json, {
        ...(this.attemptId !== undefined ? { attemptId: this.attemptId } : {}),
        ...(this.actor !== undefined ? { actor: this.actor } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return output as LeanMetaOutput;
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
      throw new LeanMetaError(errorKindOf(error), error.message, error.details);
    }
  }
}

function headerOf(options: { header?: string }): { header?: string } {
  return options.header !== undefined ? { header: options.header } : {};
}

function timeoutOf(options: { timeoutSec?: number }): { timeoutSec?: number } {
  return options.timeoutSec !== undefined ? { timeoutSec: Math.max(1, Math.ceil(options.timeoutSec)) } : {};
}

function malformed(op: string, what: string): LeanMetaError {
  return new LeanMetaError("unreachable", `${LEAN_META} answered ${op} with ${what}`);
}
