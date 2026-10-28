import type { Json } from "@seshat/core";
import type { Registry } from "@seshat/registry";
import { DECIDE_ASK, type DecideAskInput, type DecideAskOutput } from "./capability.ts";

/** Reaches the Jev and faux backends through the registry, so that each call is a tool run of `decide.ask`. */
export interface RegistryBackends {
  /** Why the host does not offer the backend, or undefined. A key that is missing shows when the call is made. */
  unavailable(backend: "jev" | "faux"): string | undefined;
  call(backend: "jev" | "faux", input: DecideAskInput, signal: AbortSignal): Promise<{ output: DecideAskOutput; toolRunId: string }>;
}

export function registryBackends(registry: Registry, options: { actor: string; attemptId?: string }): RegistryBackends {
  return {
    unavailable(backend) {
      if (!registry.offers(DECIDE_ASK)) return `the host ${registry.host.host} does not offer ${DECIDE_ASK}`;
      if (!(registry.host.capabilities[DECIDE_ASK]?.use ?? []).includes(backend)) {
        return `the host ${registry.host.host} does not list the ${backend} implementation of ${DECIDE_ASK}`;
      }
      return undefined;
    },
    async call(backend, input, signal) {
      const result = await registry.invoke(DECIDE_ASK, input as unknown as Json, {
        actor: options.actor,
        implementation: backend,
        signal,
        ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
      });
      return { output: result.output as unknown as DecideAskOutput, toolRunId: result.toolRunId };
    },
  };
}
