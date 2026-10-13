import type { Json, LeanChecker, LeanCheckOptions, LeanCheckResult, LeanSnippet } from "@math-harness/core";
import { UnavailableError, type HealthCheck, type ImplementationInstance } from "./implementation.ts";
import { CapabilityError, type Registry } from "./registry.ts";

export const LEAN_CHECK = "lean.check";

export interface LeanCheckInput {
  snippets: LeanSnippet[];
  timeoutSec?: number;
}

export interface LeanCheckOutput {
  results: LeanCheckResult[];
}

/** A `LeanChecker` that can also say whether its server answers, as `KiminaChecker` does. */
export type HealthAwareChecker = LeanChecker & { health?(signal?: AbortSignal): Promise<boolean> };

/**
 * `lean.check` provided by any `LeanChecker`. When no snippet reached Lean (every result is a
 * `server_error`), the checker counts as unreachable, so that the registry tries the host's next
 * implementation and the call is not mistaken for Lean's answer.
 */
export function leanCheckImplementation(checker: HealthAwareChecker): ImplementationInstance {
  const instance: ImplementationInstance = {
    async invoke(input, context) {
      const { snippets, timeoutSec } = input as unknown as LeanCheckInput;
      const options: LeanCheckOptions = { signal: context.signal, ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
      const results = await checker.check(snippets, options);
      if (results.length > 0 && results.every((r) => r.status === "server_error")) {
        throw new UnavailableError(results[0]?.error ?? "the Lean server did not answer");
      }
      return { results } as unknown as Json;
    },
  };
  const probe = checker.health?.bind(checker);
  if (probe !== undefined) {
    instance.health = async ({ signal }): Promise<HealthCheck> =>
      (await probe(signal))
        ? { ok: true, detail: `${checker.implementation} ${checker.version}` }
        : { ok: false, detail: `${checker.implementation} does not answer its health check` };
  }
  return instance;
}

/**
 * A `LeanChecker` that goes through the registry, so that every check is a recorded tool run of
 * `lean.check` on the host's implementation. Like any `LeanChecker`, it reports a failure to
 * reach Lean as results (`server_error`, `timeout`), never as an exception.
 */
export class RegistryLeanChecker implements LeanChecker {
  readonly implementation = "registry";
  readonly version: string;
  private readonly registry: Registry;
  private readonly attemptId: string | undefined;
  private readonly actor: string | undefined;

  constructor(registry: Registry, options: { attemptId?: string; actor?: string } = {}) {
    this.registry = registry;
    this.version = registry.hash.slice(0, 12);
    this.attemptId = options.attemptId;
    this.actor = options.actor;
  }

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    if (snippets.length === 0) return [];
    const input = {
      snippets: snippets.map(({ id, code }) => ({ id, code })),
      ...(options.timeoutSec !== undefined ? { timeoutSec: Math.max(1, Math.ceil(options.timeoutSec)) } : {}),
    };
    let results: LeanCheckResult[];
    try {
      const { output } = await this.registry.invoke(LEAN_CHECK, input, {
        ...(this.attemptId !== undefined ? { attemptId: this.attemptId } : {}),
        ...(this.actor !== undefined ? { actor: this.actor } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      results = (output as unknown as LeanCheckOutput).results;
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code === "invalid_input" || error.code === "unknown_capability") throw error;
      const status = error.code === "timeout" ? "timeout" : "server_error";
      return snippets.map((s) => ({ id: s.id, status, messages: [], sorries: [], timeMs: 0, error: error.message }));
    }
    // One result per snippet, in order, whatever order the implementation used.
    const byId = new Map(results.map((r) => [r.id, r]));
    return snippets.map(
      (s) => byId.get(s.id) ?? { id: s.id, status: "server_error", messages: [], sorries: [], timeMs: 0, error: "no result for this snippet" },
    );
  }
}
