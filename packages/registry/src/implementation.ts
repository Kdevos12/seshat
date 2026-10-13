import type { Json } from "@math-harness/core";
import type { CapabilityManifest, InprocImplementationSpec } from "./manifest.ts";

export interface InvokeContext {
  /** Aborted when the call times out or its caller gives up. */
  signal: AbortSignal;
  timeoutMs: number;
}

export interface HealthCheck {
  ok: boolean;
  detail?: string;
}

/** A running implementation of one capability. */
export interface ImplementationInstance {
  /** Gets an input valid for the capability's schema; returns its output. */
  invoke(input: Json, context: InvokeContext): Promise<Json>;
  health?(context: { signal: AbortSignal }): Promise<HealthCheck>;
  close?(): Promise<void>;
}

/**
 * Thrown by an implementation that cannot be reached at all (connection refused, wrong version,
 * missing tool). The registry then tries the host's next implementation. Any other error is a
 * failure on this input, and is not retried elsewhere.
 */
export class UnavailableError extends Error {}

export interface FactoryContext {
  capability: CapabilityManifest;
  spec: InprocImplementationSpec;
  /** The manifest's settings, replaced key by key by the host's, with variables substituted. */
  settings: Record<string, Json>;
}

export type ImplementationFactory = (context: FactoryContext) => ImplementationInstance | Promise<ImplementationInstance>;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
