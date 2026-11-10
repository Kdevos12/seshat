import type { Json } from "@seshat/core";
import { type FactoryContext, type HealthCheck, type ImplementationFactory, type ImplementationInstance, type JsonSchema, UnavailableError, validate } from "@seshat/registry";
import { type Backend, type BackendId, BACKENDS, type Hit, makeBackend } from "./backends.ts";
import { type Fetch, LitError } from "./http.ts";

/** `lit.search` (capabilities/lit.search): a query to every backend the host profile enables. */
export const LIT_SEARCH = "lit.search";
/** The most hits one call returns per backend: the manifest's `maximum` (a test keeps the two equal). */
export const LIT_MAX_LIMIT = 10;

export interface LitSearchInput {
  query: string;
  limit?: number;
  backends?: string[];
}

export interface LitSearchOutput {
  /** What each backend asked did: the request, how many hits, or why it failed. */
  answers: Array<{ backend: string; url: string; count: number; error?: string }>;
  hits: Hit[];
}

const BACKEND_SETTING: JsonSchema = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    allowedHosts: { type: "array", items: { type: "string", minLength: 1 } },
    dir: { type: "string" },
  },
  additionalProperties: false,
};

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    backends: { type: "object", properties: Object.fromEntries(BACKENDS.map((b) => [b, BACKEND_SETTING])), additionalProperties: false },
    timeoutSec: { type: "integer", minimum: 1 },
    minIntervalMs: { type: "integer", minimum: 0 },
    maxBytes: { type: "integer", minimum: 1024 },
    userAgent: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

interface Settings {
  backends?: Partial<Record<BackendId, { baseUrl?: string; allowedHosts?: string[]; dir?: string }>>;
  timeoutSec?: number;
  minIntervalMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

/**
 * The factory `lit`: the backends the host's settings enable (an address, or a directory for `bench-metadata`; a backend with an
 * empty setting is off), each with the hosts it may reach. A backend that does not answer is named in `answers` and the others
 * still give their hits; the call is `unavailable` when none answered, and the registry then tries the host's next implementation.
 */
export function litFactory(options: { fetch?: Fetch } = {}): ImplementationFactory {
  return ({ spec, settings }: Pick<FactoryContext, "spec" | "settings">): ImplementationInstance => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`${spec.factory}: ${problems.join("; ")}`);
    const s = settings as unknown as Settings;
    const backends: Backend[] = [];
    for (const id of BACKENDS) {
      const setting = s.backends?.[id];
      if (setting === undefined) continue;
      const made = makeBackend(id, setting, {
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(s.timeoutSec !== undefined ? { timeoutMs: s.timeoutSec * 1000 } : {}),
        ...(s.minIntervalMs !== undefined ? { minIntervalMs: s.minIntervalMs } : {}),
        ...(s.maxBytes !== undefined ? { maxBytes: s.maxBytes } : {}),
        ...(s.userAgent !== undefined ? { userAgent: s.userAgent } : {}),
      });
      if (made !== undefined) backends.push(made);
    }
    return {
      async invoke(input, { signal }) {
        const { query, limit, backends: only } = input as unknown as LitSearchInput;
        if (query.trim() === "") throw new Error("give a query to search for");
        const chosen = only === undefined ? backends : backends.filter((b) => only.includes(b.id));
        if (chosen.length === 0) throw new UnavailableError(`no backend of lit.search is enabled${only !== undefined ? ` among ${only.join(", ")}` : ""}: give one an address in the host profile`);
        const out: LitSearchOutput = { answers: [], hits: [] };
        let reached = 0;
        for (const backend of chosen) {
          try {
            const found = await backend.search(query, Math.min(limit ?? 5, LIT_MAX_LIMIT), signal);
            reached++;
            out.answers.push({ backend: backend.id, url: found.url, count: found.hits.length });
            out.hits.push(...found.hits);
          } catch (error) {
            if (signal.aborted) throw error;
            out.answers.push({ backend: backend.id, url: "", count: 0, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (reached === 0) throw new UnavailableError(out.answers.map((a) => `${a.backend}: ${a.error ?? "no answer"}`).join("; "));
        return out as unknown as Json;
      },
      async health(): Promise<HealthCheck> {
        return backends.length > 0 ? { ok: true, detail: `backends: ${backends.map((b) => b.id).join(", ")}` } : { ok: false, detail: "no backend is enabled" };
      },
    };
  };
}

export { LitError };
