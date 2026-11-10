import { type Declaration, isDeclarationName } from "./names.ts";
import { type HttpOptions, requestJson, serviceUrl } from "./http.ts";
import type { LocalIndex } from "./local.ts";

/** The three backends of `lean.search`, each optional and replaceable: what they share is `Backend`. */
export type BackendId = "remote" | "pattern" | "local";
export type QueryKind = "name" | "goal";

export interface SearchRequest {
  query: string;
  kind: QueryKind;
}

export interface Backend {
  readonly id: BackendId;
  /** Whether the backend sends the query to a third party (it is then off when the run is private). */
  readonly leaves: boolean;
  /** The same backend without the service, for a private run: a backend that leaves and has no such form is not asked then. */
  readonly offline?: Backend;
  search(request: SearchRequest, limit: number, signal?: AbortSignal): Promise<Declaration[]>;
}

const MAX_ITEMS = 50;
const MAX_TEXT = 2_000;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value.slice(0, MAX_TEXT) : undefined);

function nameOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.every((p) => typeof p === "string") ? value.join(".") : undefined;
  return typeof value === "string" ? value : undefined;
}

function itemOf(value: unknown): Declaration | undefined {
  if (typeof value === "string") return isDeclarationName(value) ? { name: value } : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inner = typeof record.result === "object" && record.result !== null ? (record.result as Record<string, unknown>) : record;
  const name = nameOf(inner.name);
  if (!isDeclarationName(name)) return undefined;
  const type = text(inner.type) ?? text(inner.signature);
  const doc = text(inner.doc) ?? text(inner.docstring) ?? text(inner.informal_description);
  return { name, ...(type !== undefined ? { type } : {}), ...(doc !== undefined ? { doc } : {}) };
}

/**
 * The declarations in a service's answer: a list, or an object with the list under `hits`, `results`, `declarations` or `data`; each element a
 * name, an object with `name` (text, or a list of parts), or such an object under `result`; one level of lists inside the list is flattened.
 * Whatever does not read as a declaration, or has a name that is not one, is left out; at most 50 are kept.
 */
export function parseHits(answer: unknown): Declaration[] {
  let list: unknown = answer;
  if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
    const record = answer as Record<string, unknown>;
    list = record.hits ?? record.results ?? record.declarations ?? record.data;
  }
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((element) => (Array.isArray(element) ? element : [element]))
    .slice(0, MAX_ITEMS)
    .flatMap((element) => itemOf(element) ?? []);
}

/** The conclusion of a goal: what follows the last `⊢`, on one line. */
export function conclusionOf(goal: string): string {
  const at = goal.lastIndexOf("⊢");
  return (at >= 0 ? goal.slice(at + 1) : goal).replace(/\s+/g, " ").trim();
}

/**
 * `remote`: an HTTP search service that takes a natural-language or goal query. The request is `POST URL` with `{"query": TEXT, "num_results":
 * N}`; the answer is read by `parseHits`. A service with another shape is a replacement of this backend, behind the same capability.
 */
export function remoteBackend(url: string, options: HttpOptions = {}): Backend {
  const target = serviceUrl(url);
  return {
    id: "remote",
    leaves: true,
    async search(request, limit, signal) {
      const answer = await requestJson(target, { body: { query: request.query, num_results: limit }, ...(signal !== undefined ? { signal } : {}) }, options);
      return parseHits(answer);
    },
  };
}

/**
 * `pattern`: a pattern search. With a URL, a Loogle-like service: `GET URL?q=PATTERN`, answered as `{"hits": [{"name", "type"}]}`; a name is
 * sent as a quoted string, a goal by its conclusion. Without one, a pattern match of a goal's conclusion over the local index, which leaves the machine nowhere.
 */
export function patternBackend(options: { url?: string; index?: LocalIndex; http?: HttpOptions }): Backend | undefined {
  const target = options.url === undefined ? undefined : serviceUrl(options.url);
  const index = options.index;
  if (target === undefined && index === undefined) return undefined;
  return {
    id: "pattern",
    leaves: target !== undefined,
    ...(target !== undefined && index !== undefined ? { offline: patternBackend({ index }) as Backend } : {}),
    async search(request, limit, signal) {
      const pattern = request.kind === "name" ? `"${request.query}"` : conclusionOf(request.query);
      if (pattern === "" || pattern === '""') return [];
      // Over the index, a pattern is matched against types: a name is the local backend's.
      if (target === undefined) return request.kind === "name" ? [] : (index as LocalIndex).matchPattern(pattern, limit);
      const url = new URL(target.href);
      url.searchParams.set("q", pattern);
      return parseHits(await requestJson(url, signal !== undefined ? { signal } : {}, options.http));
    },
  };
}

/** `local`: BM25 over the local index. */
export function localBackend(index: LocalIndex): Backend {
  return { id: "local", leaves: false, search: async (request, limit) => index.search(request.query, limit) };
}
