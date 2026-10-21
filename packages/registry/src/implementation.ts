import type { Json } from "@seshat/core";
import type { CapabilityManifest, InprocImplementationSpec } from "./manifest.ts";

export interface InvokeContext {
  /** Aborted when the call times out or its caller gives up. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Of a stateful capability: the state this call reads and changes. */
  scope?: string;
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
  /** Of a stateful capability: drops the state of a scope. A scope it never saw is not an error. */
  release?(scope: string, context: { signal: AbortSignal }): Promise<void>;
  close?(): Promise<void>;
}

/** Why a call of a capability failed (documentation/capabilities.md#calls). */
export const CAPABILITY_ERROR_CODES = [
  "unknown_capability",
  "invalid_input",
  "unavailable",
  "timeout",
  "aborted",
  "failed",
  "invalid_output",
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/**
 * Thrown by an implementation that cannot be reached at all (connection refused, wrong version,
 * missing tool). The registry then tries the host's next implementation. Any other error is a
 * failure on this input, and is not retried elsewhere.
 */
export class UnavailableError extends Error {}

export interface FactoryContext {
  capability: CapabilityManifest;
  spec: InprocImplementationSpec;
  /** The name of the host profile (`local`, `server`), for an implementation whose rules depend on where it runs. */
  host?: string;
  /** The manifest's settings, replaced key by key by the host's, with variables substituted. */
  settings: Record<string, Json>;
}

export type ImplementationFactory = (context: FactoryContext) => ImplementationInstance | Promise<ImplementationInstance>;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
