import { leanCheckImplementation, validate, type ImplementationFactory, type JsonSchema } from "@seshat/registry";
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
 * The registry factory `kimina`: `lean.check` over Kimina Lean Server. Settings come from the host
 * profile (`url`, `apiKey`, `timeoutSec`, `httpSlackMs`, `retries`); an empty `apiKey` sends no
 * key. The implementation's pinned version is the checker's version.
 */
export function kiminaFactory(options: Pick<KiminaOptions, "fetch" | "sleep"> = {}): ImplementationFactory {
  return ({ spec, settings }) => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`kimina: ${problems.join("; ")}`);
    const s = settings as Settings;
    const checker = new KiminaChecker({
      ...options,
      version: spec.version,
      apiKey: s.apiKey ?? "",
      ...(s.url !== undefined ? { url: s.url } : {}),
      ...(s.timeoutSec !== undefined ? { timeoutSec: s.timeoutSec } : {}),
      ...(s.httpSlackMs !== undefined ? { httpSlackMs: s.httpSlackMs } : {}),
      ...(s.retries !== undefined ? { retries: s.retries } : {}),
    });
    return leanCheckImplementation(checker);
  };
}
