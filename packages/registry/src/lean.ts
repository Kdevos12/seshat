import {
  type CertificationRequest,
  type CertificationResult,
  CertifyFailedError,
  type Json,
  type LeanCertifier,
  type LeanCertifyOptions,
  type LeanChecker,
  type LeanCheckOptions,
  type LeanCheckResult,
  type LeanSnippet,
} from "@seshat/core";
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

export const LEAN_CERTIFY = "lean.certify";

export interface LeanCertifyInput {
  original: string;
  candidate: string;
  target: string;
  allowedAxioms: string[];
  timeoutSec?: number;
}

/** A `LeanCertifier` that can also say whether its Lean is there, as `LakeCertifier` does. */
export type HealthAwareCertifier = LeanCertifier & { health?(signal?: AbortSignal): Promise<boolean> };

/**
 * `lean.certify` provided by any `LeanCertifier`. A certifier that cannot reach Lean at all
 * (`CertifyFailedError` of reason `unavailable`) makes the registry try the host's next
 * implementation. Any other failure to reach a verdict is the call's failure, and is not a verdict.
 */
export function leanCertifyImplementation(certifier: HealthAwareCertifier): ImplementationInstance {
  const instance: ImplementationInstance = {
    async invoke(input, context) {
      const { original, candidate, target, allowedAxioms, timeoutSec } = input as unknown as LeanCertifyInput;
      const options: LeanCertifyOptions = { signal: context.signal, ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
      try {
        const result = await certifier.certify({ original, candidate, target, allowedAxioms }, options);
        return result as unknown as Json;
      } catch (error) {
        if (error instanceof CertifyFailedError && error.reason === "unavailable") throw new UnavailableError(error.message);
        throw error;
      }
    },
  };
  const probe = certifier.health?.bind(certifier);
  if (probe !== undefined) {
    instance.health = async ({ signal }): Promise<HealthCheck> =>
      (await probe(signal))
        ? { ok: true, detail: `${certifier.implementation} ${certifier.version}` }
        : { ok: false, detail: `${certifier.implementation} cannot run Lean in its project` };
  }
  return instance;
}

/**
 * A `LeanCertifier` that goes through the registry, so that every certification is a recorded tool
 * run of `lean.certify` on the host's implementation. A verdict (`certified` or `rejected`) is the
 * call's output. A call that gave none (the time limit, an abort, Lean not reached, a failure of
 * the checking program) is a `CertifyFailedError`: it says nothing about the candidate.
 */
export class RegistryLeanCertifier implements LeanCertifier {
  readonly implementation: string;
  readonly version: string;
  private readonly registry: Registry;
  private readonly actor: string | undefined;

  constructor(registry: Registry, options: { implementation: string; version: string; actor?: string }) {
    this.registry = registry;
    this.implementation = options.implementation;
    this.version = options.version;
    this.actor = options.actor;
  }

  /**
   * The certifier of the registry's host, named after its first listed implementation of
   * `lean.certify` and that one's pinned version; undefined when the host offers none.
   */
  static forHost(registry: Registry, options: { actor?: string } = {}): RegistryLeanCertifier | undefined {
    if (!registry.offers(LEAN_CERTIFY)) return undefined;
    const first = registry.host.capabilities[LEAN_CERTIFY]?.use[0];
    const spec = registry.capability(LEAN_CERTIFY).manifest.implementations.find((i) => i.id === first);
    if (spec === undefined) return undefined;
    return new RegistryLeanCertifier(registry, {
      implementation: `${LEAN_CERTIFY}/${spec.id}`,
      version: spec.version,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    });
  }

  async certify(request: CertificationRequest, options: LeanCertifyOptions = {}): Promise<CertificationResult> {
    const input: LeanCertifyInput = {
      original: request.original,
      candidate: request.candidate,
      target: request.target,
      allowedAxioms: [...request.allowedAxioms],
      ...(options.timeoutSec !== undefined ? { timeoutSec: Math.max(1, Math.ceil(options.timeoutSec)) } : {}),
    };
    try {
      const { output } = await this.registry.invoke(LEAN_CERTIFY, input as unknown as Json, {
        ...(this.actor !== undefined ? { actor: this.actor } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return output as unknown as CertificationResult;
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code === "invalid_input" || error.code === "unknown_capability") throw error;
      const reason = error.code === "timeout" ? "timeout" : error.code === "aborted" ? "aborted" : error.code === "unavailable" ? "unavailable" : "failed";
      throw new CertifyFailedError(reason, error.message);
    }
  }
}
