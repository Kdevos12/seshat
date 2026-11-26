import { CapabilityError, type Registry } from "@seshat/registry";

/**
 * The host's compute tool (CA17, plan change CX3), chosen in one place for every caller: the provers of a run (`RunConfig.autoTool`,
 * `tools.ts` of the orchestrator), the first cases of a statement, and line M10's certificate stage. Documented in
 * documentation/compute.md, "The host's compute tool".
 */

/** The compute capabilities, in the order the harness prefers them: SageMath where it runs, Python on Pyodide without it. */
export const COMPUTE_TOOLS: readonly string[] = ["compute.sage", "compute.python"];

/** The packages a caller may need that only some compute capabilities' pinned sets have. */
export type ComputeNeed = "clarabel" | "pysat";

/** What each compute capability's pinned package set has of `ComputeNeed`: Pyodide's has clarabel and python-sat, Sage's has neither. */
const PROVIDES: Readonly<Record<string, readonly ComputeNeed[]>> = { "compute.python": ["clarabel", "pysat"], "compute.sage": [] };

/** `COMPUTE_TOOLS` with those that have every one of `needs` first, each part in its own order. */
export function computeOrder(needs: readonly ComputeNeed[] = []): string[] {
  const has = (id: string): boolean => needs.every((need) => PROVIDES[id]?.includes(need) === true);
  return [...COMPUTE_TOOLS.filter(has), ...COMPUTE_TOOLS.filter((id) => !has(id))];
}

/** The compute tools a caller may use in place of `id` when it cannot be reached: the others of `computeOrder(needs)` that the host offers, in order. */
export function computeFallbacks(registry: Pick<Registry, "offers">, id: string, needs: readonly ComputeNeed[] = []): string[] {
  const order = computeOrder(needs);
  return order.includes(id) ? order.filter((other) => other !== id && registry.offers(other)) : [];
}

/** What a compute capability (`compute.python`, `compute.sage`) answered: what the code printed, and its last value. */
export interface ComputeAnswer {
  stdout: string;
  result?: string | null;
}

/**
 * The code of one call: one text for whichever compute tool answers, or a text per capability (`{ "compute.python": ..., "compute.sage":
 * ... }`) for a caller whose code differs between them (Python's imports, which Sage refuses; Sage's own rings). A capability the record
 * leaves out cannot run the call: the tool passes over it, for that call only.
 */
export type ComputeCode = string | Readonly<Partial<Record<string, string>>>;

/** The text of `code` for `capability`, or undefined when the record has none for it. */
export const codeFor = (code: ComputeCode, capability: string): string | undefined => (typeof code === "string" ? code : code[capability]);

/**
 * A call whose code no compute tool of the host can run: the capabilities it has code for are not offered, or cannot be reached, and
 * the one that answers (`capability`) has none. Nothing was sent to it.
 */
export class ComputeUnsuited extends Error {
  /** The capabilities the call had code for. */
  readonly wanted: readonly string[];
  /** The compute tool that answers. */
  readonly capability: string;

  constructor(wanted: readonly string[], capability: string) {
    super(`the code is for ${wanted.join(" or ")}, which the host does not offer or cannot reach; its compute tool here is ${capability}`);
    this.name = "ComputeUnsuited";
    this.wanted = wanted;
    this.capability = capability;
  }
}

/** A compute tool as a caller without a prover uses it: one session (scope), and calls in it. */
export interface ComputeTool {
  /** The capability that answers (the one tried next, before the first call), for the notes and for the caller that picks its code. */
  readonly capability: string;
  /**
   * Runs `code` on the first capability that has code for it and answers; the call ends within `timeoutSec`, the interpreter's start
   * included (a new session's first call starts one). Throws `ComputeUnsuited`, with no call made, when none that answers has code.
   */
  run(code: ComputeCode, options: { timeoutSec: number; signal?: AbortSignal }): Promise<ComputeAnswer>;
  /** Ends the session. */
  release?(): Promise<void>;
}

/**
 * The registry's compute tool, as tool runs of `actor` in `scope`: the first of `computeOrder(needs)` that the host offers, and,
 * when a call finds it unavailable (no Pyodide, Sage down), the next one, for this call and the later ones. A call whose code has no
 * text for a capability passes over that one (`ComputeCode`) without marking it unavailable. Undefined when the host offers none. No
 * health check is made: the first call finds out.
 */
export function registryCompute(registry: Pick<Registry, "offers" | "invoke" | "release">, options: { actor: string; scope: string; needs?: readonly ComputeNeed[] }): ComputeTool | undefined {
  const candidates = computeOrder(options.needs).filter((id) => registry.offers(id));
  if (candidates.length === 0) return undefined;
  /** The capabilities a call found unavailable: the later calls pass over them. */
  const down = new Set<string>();
  const current = (): string | undefined => candidates.find((id) => !down.has(id));
  return {
    get capability(): string {
      return current() as string;
    },
    async run(code, { timeoutSec, signal }) {
      for (const capability of candidates) {
        const text = codeFor(code, capability);
        if (down.has(capability) || text === undefined) continue;
        try {
          // The code's own limit, and the registry's over the whole call, which covers the interpreter's start as well.
          const result = await registry.invoke(capability, { code: text, timeout: timeoutSec }, { actor: options.actor, scope: options.scope, timeoutMs: Math.ceil(timeoutSec * 1000), ...(signal !== undefined ? { signal } : {}) });
          const out = (result.output ?? {}) as { stdout?: unknown; result?: unknown };
          return { stdout: typeof out.stdout === "string" ? out.stdout : "", ...(typeof out.result === "string" ? { result: out.result } : {}) };
        } catch (error) {
          if (!(error instanceof CapabilityError && error.code === "unavailable")) throw error;
          // The only one left: the caller reads why it cannot be reached, as before.
          if (candidates.every((id) => id === capability || down.has(id))) throw error;
          down.add(capability);
        }
      }
      // One capability is always left (the refusal of the only one left is thrown above), and it has no code for the call.
      throw new ComputeUnsuited(typeof code === "string" ? [] : Object.keys(code).filter((id) => code[id] !== undefined), current() as string);
    },
    release: () => registry.release(options.scope),
  };
}
