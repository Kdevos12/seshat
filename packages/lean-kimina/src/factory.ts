import { type FactoryContext, leanCheckImplementation, validate, type ImplementationFactory, type JsonSchema } from "@seshat/registry";
import { KiminaChecker, type KiminaOptions } from "./checker.ts";

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1 },
    apiKey: { type: "string" },
    timeoutSec: { type: "integer", minimum: 1 },
    httpSlackMs: { type: "integer", minimum: 0 },
    retries: { type: "integer", minimum: 0, maximum: 10 },
  },
  additionalProperties: false,
};

interface Settings {
  url?: string;
  apiKey?: string;
  timeoutSec?: number;
  httpSlackMs?: number;
  retries?: number;
}

/**
 * The `KiminaChecker` of an implementation, from its settings in the host profile (`url`, `apiKey`,
 * `timeoutSec`, `httpSlackMs`, `retries`); an empty `apiKey` sends no key. The implementation's
 * pinned version is the checker's version. `lean.meta` uses it too (factory `kimina-meta`).
 */
export function kiminaChecker({ spec, settings }: Pick<FactoryContext, "spec" | "settings">, options: Pick<KiminaOptions, "fetch" | "sleep"> = {}): KiminaChecker {
  const problems = validate(SETTINGS, settings, "settings");
  if (problems.length > 0) throw new Error(`kimina: ${problems.join("; ")}`);
  const s = settings as Settings;
  return new KiminaChecker({
    ...options,
    version: spec.version,
    apiKey: s.apiKey ?? "",
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.timeoutSec !== undefined ? { timeoutSec: s.timeoutSec } : {}),
    ...(s.httpSlackMs !== undefined ? { httpSlackMs: s.httpSlackMs } : {}),
    ...(s.retries !== undefined ? { retries: s.retries } : {}),
  });
}

/** The registry factory `kimina`: `lean.check` over Kimina Lean Server (settings: `kiminaChecker`). */
export function kiminaFactory(options: Pick<KiminaOptions, "fetch" | "sleep"> = {}): ImplementationFactory {
  return (context) => leanCheckImplementation(kiminaChecker(context, options));
}
