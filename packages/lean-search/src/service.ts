import type { Json } from "@seshat/core";
import {
  CapabilityError,
  type FactoryContext,
  type ImplementationFactory,
  type ImplementationInstance,
  type JsonSchema,
  messageOf,
  type Registry,
  validate,
} from "@seshat/registry";
import { type Backend, type BackendId, localBackend, patternBackend, type QueryKind, remoteBackend } from "./backends.ts";
import { DEFAULT_TIMEOUT_MS, type Fetch, MAX_RESPONSE_BYTES, serviceUrl } from "./http.ts";
import { type LocalIndex, loadIndex } from "./local.ts";

/**
 * `lean.search` (plan change CA22, capabilities/lean.search, documentation/lean.md, "Search pushed by the harness"): premise search with three
 * replaceable backends, each optional. The implementation `search` (factory `lean-search`) runs the backends the host profile sets up, at
 * the same time, and merges their hits. What it answers is names: the backends' text (types, doc strings) ranks and is dropped here.
 */
export const LEAN_SEARCH = "lean.search";

/** The input of `lean.search`. */
export interface LeanSearchInput {
  query: string;
  kind: QueryKind;
  limit?: number;
  /** The run is private: no backend that sends the query to a third party is used. */
  private?: boolean;
}

export interface LeanSearchHit {
  name: string;
  backend: BackendId;
}

/** The output of `lean.search`: unverified names, and which backends answered or were left out and why. */
export interface LeanSearchOutput {
  hits: LeanSearchHit[];
  used: BackendId[];
  skipped: Array<{ backend: BackendId; reason: string }>;
}

/** The order the backends' hits are interleaved in. */
const ORDER: readonly BackendId[] = ["remote", "pattern", "local"];

/** Why a private run skips a backend: also how a caller tells that from a failure. */
export const PRIVATE_REASON = "private run: nothing leaves for a third party";

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    allowedHosts: { type: "array", items: { type: "string", minLength: 1 } },
    remoteUrl: { type: "string" },
    patternUrl: { type: "string" },
    index: { type: "string" },
    timeoutSec: { type: "integer", minimum: 1 },
    maxResponseBytes: { type: "integer", minimum: 1024 },
  },
  additionalProperties: false,
};

interface Settings {
  allowedHosts?: string[];
  remoteUrl?: string;
  patternUrl?: string;
  index?: string;
  timeoutSec?: number;
  maxResponseBytes?: number;
}

/** A setting that is the empty text is not set (the profiles say `${env:NAME:-}`). */
const given = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());

export interface LeanSearchFactoryOptions {
  /** Default: the global `fetch`. Tests give a fake service. */
  fetch?: Fetch;
}

/** The backends a context sets up, and the local index it loads (once, when the first call needs it). */
function setUp(
  context: Pick<FactoryContext, "spec" | "settings">,
  options: LeanSearchFactoryOptions,
): { backends: Backend[]; index: () => LocalIndex | undefined; configured: BackendId[]; unavailable: string[] } {
  const problems = validate(SETTINGS, context.settings, "settings");
  if (problems.length > 0) throw new Error(`${context.spec.factory}: ${problems.join("; ")}`);
  const s = context.settings as Settings;
  const http = {
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    timeoutMs: (s.timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
    maxBytes: s.maxResponseBytes ?? MAX_RESPONSE_BYTES,
  };
  const indexPath = given(s.index);
  let loaded: LocalIndex | undefined;
  const index = (): LocalIndex | undefined => {
    if (indexPath !== undefined && loaded === undefined) loaded = loadIndex(indexPath);
    return loaded;
  };
  // A service is used only at a host the profile allows (none: no service); an address that is not allowed, or not usable, makes that
  // backend unavailable, with its reason, and the others go on.
  const allowed = s.allowedHosts ?? [];
  const unavailable: string[] = [];
  const checked = (id: BackendId, raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    try {
      const host = serviceUrl(raw).hostname;
      if (!allowed.includes(host)) throw new Error(`the host ${host} is not among the allowed hosts of this profile (${allowed.join(", ") || "none"})`);
      return raw;
    } catch (error) {
      unavailable.push(`${id}: ${messageOf(error)}`);
      return `!${messageOf(error)}`;
    }
  };
  const remoteUrl = checked("remote", given(s.remoteUrl));
  const patternUrl = checked("pattern", given(s.patternUrl));
  const backends: Backend[] = [];
  if (remoteUrl !== undefined) backends.push(remoteUrl.startsWith("!") ? refused("remote", remoteUrl.slice(1)) : remoteBackend(remoteUrl, http));
  if (patternUrl?.startsWith("!") === true) backends.push(refused("pattern", patternUrl.slice(1), indexPath !== undefined ? lazyPattern(undefined, index, http, true) : undefined));
  else if (patternUrl !== undefined || indexPath !== undefined) {
    // The pattern backend over the index reads it when asked, like the local one.
    backends.push(lazyPattern(patternUrl, index, http, indexPath !== undefined));
  }
  if (indexPath !== undefined) backends.push(lazyLocal(index));
  return { backends, index, configured: backends.map((b) => b.id), unavailable };
}

/** A service backend whose address is refused: it fails with the reason when asked, and in a private run it is what it would be, off (or its offline form). */
function refused(id: BackendId, reason: string, offline?: Backend): Backend {
  return { id, leaves: true, ...(offline !== undefined ? { offline } : {}), search: async () => { throw new Error(reason); } };
}

function lazyPattern(url: string | undefined, index: () => LocalIndex | undefined, http: { fetch?: Fetch; timeoutMs: number; maxBytes: number }, hasIndex: boolean): Backend {
  const asked = (withUrl = true): Backend => {
    const idx = hasIndex ? index() : undefined;
    const backend = patternBackend({ ...(url !== undefined && withUrl ? { url } : {}), ...(idx !== undefined ? { index: idx } : {}), http });
    if (backend === undefined) throw new Error("the pattern backend has neither an address nor an index");
    return backend;
  };
  const offline: Backend | undefined = url !== undefined && hasIndex ? { id: "pattern", leaves: false, search: (request, limit, signal) => asked(false).search(request, limit, signal) } : undefined;
  return { id: "pattern", leaves: url !== undefined, ...(offline !== undefined ? { offline } : {}), search: (request, limit, signal) => asked().search(request, limit, signal) };
}

function lazyLocal(index: () => LocalIndex | undefined): Backend {
  return {
    id: "local",
    leaves: false,
    search: (request, limit, signal) => {
      const idx = index();
      if (idx === undefined) throw new Error("no index");
      return localBackend(idx).search(request, limit, signal);
    },
  };
}

/** The most hits one call returns. */
export const MAX_LIMIT = 20;

/** The factory `lean-search`. Settings: `remoteUrl`, `patternUrl`, `index`, `timeoutSec`, `maxResponseBytes`; none is required. */
export function leanSearchFactory(options: LeanSearchFactoryOptions = {}): ImplementationFactory {
  return (context): ImplementationInstance => {
    const { backends, index, configured, unavailable } = setUp(context, options);
    return {
      async invoke(input, { signal }) {
        const { query, kind, limit = 5, private: isPrivate = false } = input as unknown as LeanSearchInput;
        const skipped: LeanSearchOutput["skipped"] = [];
        // A private run sends nothing to a third party: the backends that would are not asked at all.
        const eligible = backends.flatMap((b) => {
          if (!isPrivate || !b.leaves) return [b];
          if (b.offline !== undefined) return [b.offline];
          skipped.push({ backend: b.id, reason: PRIVATE_REASON });
          return [];
        });
        const answers = await Promise.all(
          eligible.map(async (b) => {
            try {
              return { backend: b.id, found: await b.search({ query, kind }, Math.min(limit, MAX_LIMIT), signal) };
            } catch (error) {
              skipped.push({ backend: b.id, reason: messageOf(error).slice(0, 200) });
              return { backend: b.id, found: [] };
            }
          }),
        );
        // Interleaved, so that no backend crowds the others out; each name once.
        const hits: LeanSearchHit[] = [];
        const seen = new Set<string>();
        const lists = ORDER.map((id) => answers.filter((a) => a.backend === id).flatMap((a) => a.found));
        for (let rank = 0; hits.length < limit && lists.some((l) => rank < l.length); rank += 1) {
          for (const [at, id] of ORDER.entries()) {
            const found = lists[at]?.[rank];
            if (found === undefined || seen.has(found.name) || hits.length >= limit) continue;
            seen.add(found.name);
            hits.push({ name: found.name, backend: id });
          }
        }
        const used = ORDER.filter((id) => eligible.some((b) => b.id === id) && !skipped.some((s) => s.backend === id));
        return { hits, used, skipped } as unknown as Json;
      },
      async health() {
        if (configured.length === 0) return { ok: false, detail: "no backend is set up: give remoteUrl, patternUrl or index (LEAN_SEARCH_URL, LEAN_PATTERN_URL, LEAN_SEARCH_INDEX)" };
        try {
          const idx = index();
          const down = unavailable.length > 0 ? `; not usable: ${unavailable.join("; ")}` : "";
          return { ok: unavailable.length === 0, detail: `${configured.join(", ")} set up${idx === undefined ? "" : ` (${idx.size} declarations in the index)`}${down}; the services are not probed` };
        } catch (error) {
          return { ok: false, detail: messageOf(error) };
        }
      },
    };
  };
}

/** `lean.search` through the registry: a call is a tool run, and a service that fails is no answer (undefined), never a thrown error. */
export class RegistryLeanSearch {
  readonly #registry: Registry;

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  async search(
    request: { query: string; kind: QueryKind; limit?: number; private?: boolean },
    context: { attemptId?: string; actor?: string; signal?: AbortSignal } = {},
  ): Promise<LeanSearchOutput | undefined> {
    try {
      const { output } = await this.#registry.invoke(LEAN_SEARCH, { ...request, ...(request.private === true ? { private: true } : {}) } as unknown as Json, {
        ...(context.attemptId !== undefined ? { attemptId: context.attemptId } : {}),
        ...(context.actor !== undefined ? { actor: context.actor } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      return output as unknown as LeanSearchOutput;
    } catch (error) {
      if (error instanceof CapabilityError && error.code === "invalid_input") throw error;
      return undefined;
    }
  }
}
