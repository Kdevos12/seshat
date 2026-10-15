import type { Json } from "@seshat/core";
import { type Identification, type IdentifyOptions, identifySequence, type SequenceMatch, strengthOf, type SequenceTerm, toTerms } from "./identify.ts";

/**
 * Clients for the services that recognize what a computation found: the OEIS (integer sequences),
 * FindStat (combinatorial statistics) and the LMFDB (number fields, curves, modular forms). They
 * take a `fetch` so that a test can answer from a file; none of them ran against its site, which
 * this environment cannot reach, and the FindStat and LMFDB requests and answers are written from
 * their documentation as remembered and may need adjusting ([documentation/models.md]).
 */
export type Fetch = typeof fetch;

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export interface ClientOptions {
  /** Default: the global `fetch`. */
  fetch?: Fetch;
  /** The site's address, without a final slash. Each client has its default. */
  baseUrl?: string;
  /** Time for a request. Default 20 000 ms. */
  timeoutMs?: number;
  /** The least time between two requests, to stay polite to the site. Default 1 000 ms; the tests use 0. */
  minIntervalMs?: number;
  /** Sent as `User-Agent`. */
  userAgent?: string;
}

/** What the three clients share: a request with a time limit, a pause between requests, and a cache of the answers. */
class JsonClient {
  readonly baseUrl: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #userAgent: string;
  readonly #cache = new Map<string, unknown>();
  #lastRequest = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ClientOptions, defaultBase: string) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? defaultBase).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#minIntervalMs = options.minIntervalMs ?? 1_000;
    this.#userAgent = options.userAgent ?? "seshat-harness (research tool; contact the project's maintainers)";
  }

  /** The JSON an address (or a POST to it) answers. The same request is answered once. */
  async request(url: string, init: { body?: Json; signal?: AbortSignal } = {}): Promise<unknown> {
    const key = `${init.body === undefined ? "GET" : "POST"} ${url} ${init.body === undefined ? "" : JSON.stringify(init.body)}`;
    if (this.#cache.has(key)) return this.#cache.get(key);
    // One request at a time, with a pause after the last.
    const turn = this.#queue.then(async () => {
      const wait = this.#lastRequest + this.#minIntervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#lastRequest = Date.now();
    });
    this.#queue = turn.catch(() => undefined);
    await turn;
    // A timer that keeps the process alive (AbortSignal.timeout's does not), cleared when the answer is read.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${this.#timeoutMs} ms`)), this.#timeoutMs);
    const signal = init.signal === undefined ? timeout.signal : AbortSignal.any([init.signal, timeout.signal]);
    const why = () => (signal.reason instanceof Error ? signal.reason.message : String(signal.reason));
    let json: unknown;
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: init.body === undefined ? "GET" : "POST",
          headers: { Accept: "application/json", "User-Agent": this.#userAgent, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal,
        });
      } catch (error) {
        throw new LookupError(`${url}: ${signal.aborted ? why() : error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) throw new LookupError(`${url}: HTTP ${response.status}`);
      try {
        json = await response.json();
      } catch {
        throw new LookupError(`${url}: ${signal.aborted ? why() : "the answer is not JSON"}`);
      }
    } finally {
      clearTimeout(timer);
    }
    this.#cache.set(key, json);
    return json;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- The OEIS ----------------------------------------------------------------------------------

export interface OeisRecord {
  /** `A000045`. */
  id: string;
  name: string;
  /** The index of the first term. */
  offset: number;
  /** The terms the site shows (the first few hundred characters of its data). */
  terms: bigint[];
  keywords: string[];
  url: string;
}

export interface OeisSearch {
  /** How many sequences the site says match; the records are the first page. */
  count: number;
  records: OeisRecord[];
  url: string;
}

function parseOeisRecord(raw: unknown, baseUrl: string): OeisRecord | undefined {
  if (!isRecord(raw) || typeof raw.number !== "number") return undefined;
  const id = `A${String(raw.number).padStart(6, "0")}`;
  const terms = typeof raw.data === "string" && raw.data.trim() !== "" ? raw.data.split(",").flatMap((t) => (/^\s*-?\d+\s*$/.test(t) ? [BigInt(t.trim())] : [])) : [];
  const offset = typeof raw.offset === "string" ? Number.parseInt(raw.offset.split(",")[0] ?? "0", 10) : 0;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    offset: Number.isFinite(offset) ? offset : 0,
    terms,
    keywords: typeof raw.keyword === "string" ? raw.keyword.split(",").filter((k) => k !== "") : [],
    url: `${baseUrl}/${id}`,
  };
}

/**
 * The On-Line Encyclopedia of Integer Sequences, through its JSON search
 * (`/search?q=1,2,3,5&fmt=json`). Both shapes of answer are read: the list of records that the site
 * once gave, and the object with `count` and `results` that it gives now.
 */
export class OeisClient {
  readonly #http: JsonClient;

  constructor(options: ClientOptions = {}) {
    this.#http = new JsonClient(options, "https://oeis.org");
  }

  async #search(query: string, signal?: AbortSignal): Promise<OeisSearch> {
    const url = `${this.#http.baseUrl}/search?q=${encodeURIComponent(query)}&fmt=json`;
    const json = await this.#http.request(url, signal !== undefined ? { signal } : {});
    const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.results) ? json.results : isRecord(json) && json.results === null ? [] : undefined;
    if (list === undefined) throw new LookupError(`${url}: the answer has no list of results`);
    const records = list.flatMap((raw) => parseOeisRecord(raw, this.#http.baseUrl) ?? []);
    const count = isRecord(json) && typeof json.count === "number" ? json.count : records.length;
    return { count, records, url };
  }

  /** The sequences that have these consecutive terms. */
  async search(terms: readonly SequenceTerm[], signal?: AbortSignal): Promise<OeisSearch> {
    if (terms.length === 0) throw new RangeError("an OEIS search needs terms");
    return this.#search(toTerms(terms).join(","), signal);
  }

  /** The sequence with this number, or undefined. */
  async lookup(id: string, signal?: AbortSignal): Promise<OeisRecord | undefined> {
    if (!/^A\d{6}$/.test(id)) throw new RangeError(`${JSON.stringify(id)} is not an OEIS number such as A000045`);
    return (await this.#search(`id:${id}`, signal)).records.find((r) => r.id === id);
  }
}

/** The OEIS records as matches of a query: where the query falls in the terms the site shows, if it does. */
export function oeisMatches(query: readonly bigint[], records: readonly OeisRecord[]): SequenceMatch[] {
  return records.map((record) => {
    let at = -1;
    outer: for (let i = 0; i + query.length <= record.terms.length; i++) {
      for (let k = 0; k < query.length; k++) if (record.terms[i + k] !== query[k]) continue outer;
      at = i;
      break;
    }
    return {
      id: record.id,
      name: record.name,
      source: "oeis" as const,
      offset: record.offset,
      start: at < 0 ? null : record.offset + at,
      next: at < 0 ? [] : record.terms.slice(at + query.length, at + query.length + 5),
      prefix: at === 0,
    };
  });
}

/**
 * Recognizes a sequence: the table shipped with the package first, and the OEIS when the table has no
 * strong match and a client is given. A service that does not answer does not fail the lookup; the
 * local answer comes back with a note saying so.
 */
export async function lookupSequence(
  values: readonly SequenceTerm[],
  services: { oeis?: OeisClient } = {},
  options: IdentifyOptions & { signal?: AbortSignal; always?: boolean } = {},
): Promise<Identification> {
  const local = identifySequence(values, options);
  if (services.oeis === undefined || local.query.length < (options.minTerms ?? 4) || (local.strength === "strong" && options.always !== true)) return local;
  try {
    const found = await services.oeis.search(local.query, options.signal);
    const remote = oeisMatches(local.query, found.records);
    const known = new Set(local.matches.map((m) => m.id));
    const matches = [...local.matches, ...remote.filter((m) => !known.has(m.id))].slice(0, options.maxMatches ?? 8);
    const note = found.count > matches.length ? `the OEIS has ${found.count} sequences with these terms` : undefined;
    return { query: local.query, matches, strength: matches.length === 0 ? "none" : strengthOf(local.query), ...(note !== undefined ? { note } : {}) };
  } catch (error) {
    if (!(error instanceof LookupError)) throw error;
    return { ...local, note: `${local.note !== undefined ? `${local.note}; ` : ""}the OEIS did not answer (${error.message})` };
  }
}

// --- The LMFDB ---------------------------------------------------------------------------------

export interface LmfdbResult {
  url: string;
  records: Array<Record<string, Json>>;
}

/**
 * The L-functions and modular forms database, through its API
 * (`/api/<collection>/?<field>=<value>&_format=json`): a collection such as `nf_fields`, and the
 * fields to match. The answer's list of records is read from `data`, `records`, `results` or the
 * top level.
 */
export class LmfdbClient {
  readonly #http: JsonClient;

  constructor(options: ClientOptions = {}) {
    this.#http = new JsonClient(options, "https://www.lmfdb.org");
  }

  async query(collection: string, fields: Readonly<Record<string, string | number | boolean>>, options: { limit?: number; signal?: AbortSignal } = {}): Promise<LmfdbResult> {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(collection)) throw new RangeError(`${JSON.stringify(collection)} is not the name of a collection`);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, String(value));
    params.set("_format", "json");
    params.set("_limit", String(options.limit ?? 10));
    const url = `${this.#http.baseUrl}/api/${collection}/?${params.toString()}`;
    const json = await this.#http.request(url, options.signal !== undefined ? { signal: options.signal } : {});
    const list = Array.isArray(json) ? json : isRecord(json) ? [json.data, json.records, json.results].find(Array.isArray) : undefined;
    if (list === undefined) throw new LookupError(`${url}: the answer has no list of records`);
    return { url, records: list.filter(isRecord) as Array<Record<string, Json>> };
  }
}

// --- FindStat ----------------------------------------------------------------------------------

export interface FindStatMatch {
  /** `St000001`. */
  id: string;
  name: string;
  url: string;
}

/**
 * FindStat, the database of combinatorial statistics: given a collection (`Permutations`, `Dyck
 * paths`...) and pairs of an object and the value computed on it, the statistics that agree. The
 * request is a POST of `{collection, data}` to `/StatisticFinder/`; the answer's list is read from
 * `results`, `matches` or `statistics`. Not checked against the site.
 */
export class FindStatClient {
  readonly #http: JsonClient;

  constructor(options: ClientOptions = {}) {
    this.#http = new JsonClient(options, "https://www.findstat.org");
  }

  async identify(collection: string, data: ReadonlyArray<readonly [Json, number]>, signal?: AbortSignal): Promise<FindStatMatch[]> {
    if (data.length === 0) throw new RangeError("FindStat needs objects with their values");
    const url = `${this.#http.baseUrl}/StatisticFinder/`;
    const json = await this.#http.request(url, { body: { collection, data: data.map(([object, value]) => [object, value]) }, ...(signal !== undefined ? { signal } : {}) });
    const list = Array.isArray(json) ? json : isRecord(json) ? [json.results, json.matches, json.statistics].find(Array.isArray) : undefined;
    if (list === undefined) throw new LookupError(`${url}: the answer has no list of statistics`);
    return list.flatMap((raw): FindStatMatch[] => {
      if (!isRecord(raw)) return [];
      const id = [raw.id, raw.Id, raw.identifier].find((v): v is string => typeof v === "string" && /^St\d+$/.test(v));
      if (id === undefined) return [];
      const name = [raw.name, raw.Name, raw.description].find((v): v is string => typeof v === "string") ?? "";
      return [{ id, name, url: `${this.#http.baseUrl}/StatisticsDatabase/${id}` }];
    });
  }
}
