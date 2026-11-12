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
  /** Put the body each backend answered in its entry of `answers` (`raw`); a tool that shows what a site says asks for it. */
  keepRaw?: boolean;
}

export interface LitSearchOutput {
  /** What each backend asked did: the request, how many hits, or why it failed. */
  answers: Array<{ backend: string; url: string; count: number; error?: string; cached?: boolean; raw?: string }>;
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
    cacheDir: { type: "string", minLength: 1 },
    cacheDays: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

interface Settings {
  backends?: Partial<Record<BackendId, { baseUrl?: string; allowedHosts?: string[]; dir?: string }>>;
  timeoutSec?: number;
  minIntervalMs?: number;
  maxBytes?: number;
  userAgent?: string;
  cacheDir?: string;
  cacheDays?: number;
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
    const rejected: { backend: BackendId; reason: string }[] = [];
    for (const id of BACKENDS) {
      const setting = s.backends?.[id];
      if (setting === undefined) continue;
      let made: Backend | undefined;
      try {
        made = makeBackend(id, setting, {
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(s.timeoutSec !== undefined ? { timeoutMs: s.timeoutSec * 1000 } : {}),
        ...(s.minIntervalMs !== undefined ? { minIntervalMs: s.minIntervalMs } : {}),
        ...(s.maxBytes !== undefined ? { maxBytes: s.maxBytes } : {}),
        ...(s.userAgent !== undefined ? { userAgent: s.userAgent } : {}),
        ...(s.cacheDir !== undefined ? { cache: { dir: s.cacheDir, days: s.cacheDays ?? 7 } } : {}),
        });
      } catch (error) {
        rejected.push({ backend: id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (made !== undefined) backends.push(made);
    }
    return {
      async invoke(input, { signal }) {
        const { query, limit, backends: only, keepRaw } = input as unknown as LitSearchInput;
        if (query.trim() === "") throw new Error("give a query to search for");
        const chosen = only === undefined ? backends : backends.filter((b) => only.includes(b.id));
        if (chosen.length === 0) throw new UnavailableError(`${rejected.map((r) => `${r.backend}: ${r.reason}; `).join("")}no backend of lit.search is enabled${only !== undefined ? ` among ${only.join(", ")}` : ""}: give one an address in the host profile`);
        const out: LitSearchOutput = { answers: [], hits: [] };
        for (const r of rejected) if (only === undefined || only.includes(r.backend)) out.answers.push({ backend: r.backend, url: "", count: 0, error: `not enabled: ${r.reason}` });
        let reached = 0;
        for (const backend of chosen) {
          try {
            const found = await backend.search(query, Math.min(limit ?? 5, LIT_MAX_LIMIT), signal);
            reached++;
            out.answers.push({ backend: backend.id, url: found.url, count: found.hits.length, ...(found.cached === true ? { cached: true } : {}), ...(keepRaw === true && found.raw !== undefined ? { raw: found.raw } : {}) });
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
        const bad = rejected.map((r) => `${r.backend} not enabled (${r.reason})`);
        const detail = [...(backends.length > 0 ? [`backends: ${backends.map((b) => b.id).join(", ")}`] : []), ...bad].join("; ");
        return backends.length > 0 ? { ok: true, detail } : { ok: false, detail: detail === "" ? "no backend is enabled" : detail };
      },
    };
  };
}

export { LitError };
