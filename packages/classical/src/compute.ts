import { CapabilityError, type Registry } from "@seshat/registry";

/**
 * The host's compute tool (CA17, plan change CX3), chosen in one place for every caller: the provers of a run (`RunConfig.autoTool`,
 * `tools.ts` of the orchestrator), the first cases of a statement, and line M10's certificate stage. Documented in
 * documentation/compute.md, "The host's compute tool".
 */

/** The compute capabilities, in the order the harness prefers them: SageMath where it runs, Python on Pyodide without it. */
export const COMPUTE_TOOLS: readonly string[] = ["compute.sage", "compute.python"];

/** The packages a caller may need that only some compute capabilities' pinned sets have. */
export type ComputeNeed = "clarabel";

/** What each compute capability's pinned package set has of `ComputeNeed`: Pyodide's has clarabel, Sage's has not. */
const PROVIDES: Readonly<Record<string, readonly ComputeNeed[]>> = { "compute.python": ["clarabel"], "compute.sage": [] };

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

/** A compute tool as a caller without a prover uses it: one session (scope), and calls in it. */
export interface ComputeTool {
  /** The capability that answers (the one tried next, before the first call), for the notes. */
  readonly capability: string;
  /** Runs `code`; the call ends within `timeoutSec`, the interpreter's start included (a new session's first call starts one). */
  run(code: string, options: { timeoutSec: number; signal?: AbortSignal }): Promise<ComputeAnswer>;
  /** Ends the session. */
  release?(): Promise<void>;
}

/**
 * The registry's compute tool, as tool runs of `actor` in `scope`: the first of `computeOrder(needs)` that the host offers, and,
 * when a call finds it unavailable (no Pyodide, Sage down), the next one, for this call and the later ones. Undefined when the
 * host offers none. No health check is made: the first call finds out.
 */
export function registryCompute(registry: Pick<Registry, "offers" | "invoke" | "release">, options: { actor: string; scope: string; needs?: readonly ComputeNeed[] }): ComputeTool | undefined {
  const candidates = computeOrder(options.needs).filter((id) => registry.offers(id));
  if (candidates.length === 0) return undefined;
  let at = 0;
  return {
    get capability(): string {
      return candidates[at] as string;
    },
    async run(code, { timeoutSec, signal }) {
      for (;;) {
        const capability = candidates[at] as string;
        try {
          // The code's own limit, and the registry's over the whole call, which covers the interpreter's start as well.
          const result = await registry.invoke(capability, { code, timeout: timeoutSec }, { actor: options.actor, scope: options.scope, timeoutMs: Math.ceil(timeoutSec * 1000), ...(signal !== undefined ? { signal } : {}) });
          const out = (result.output ?? {}) as { stdout?: unknown; result?: unknown };
          return { stdout: typeof out.stdout === "string" ? out.stdout : "", ...(typeof out.result === "string" ? { result: out.result } : {}) };
        } catch (error) {
          if (!(error instanceof CapabilityError && error.code === "unavailable") || at + 1 >= candidates.length) throw error;
          at++;
        }
      }
    },
    release: () => registry.release(options.scope),
  };
}
