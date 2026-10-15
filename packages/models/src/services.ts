import type { Json } from "@seshat/core";
import {
  CapabilityError,
  type FactoryContext,
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
  type JsonSchema,
  messageOf,
  type Registry,
  UnavailableError,
  validate,
} from "@seshat/registry";
import {
  type ClientOptions,
  type Fetch,
  FindStatClient,
  LmfdbClient,
  LookupError,
  OeisClient,
  type OeisSearch,
  type OeisSource,
} from "./clients.ts";
import { type SequenceTerm, toTerms } from "./identify.ts";

/**
 * The OEIS, FindStat and the LMFDB as capabilities of the registry (`capabilities/oeis.search`,
 * `capabilities/findstat.identify`, `capabilities/lmfdb.query`; documentation/capabilities.md). Each has
 * one implementation, `site`, a factory here around the client of `clients.ts`; the host profile gives
 * the address and the pauses. None has run against its site: this environment cannot reach them, and
 * the tests answer from files (documentation/models.md).
 */
export const OEIS_SEARCH = "oeis.search";
export const LMFDB_QUERY = "lmfdb.query";
export const FINDSTAT_IDENTIFY = "findstat.identify";

/** The settings of a `site` implementation, in the host profile. */
const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    baseUrl: { type: "string", minLength: 1 },
    timeoutSec: { type: "integer", minimum: 1 },
    minIntervalMs: { type: "integer", minimum: 0 },
    userAgent: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

interface Settings {
  baseUrl?: string;
  timeoutSec?: number;
  minIntervalMs?: number;
  userAgent?: string;
}

function clientOptions({ spec, settings }: Pick<FactoryContext, "spec" | "settings">, fetch: Fetch | undefined): ClientOptions {
  const problems = validate(SETTINGS, settings, "settings");
  if (problems.length > 0) throw new Error(`${spec.factory}: ${problems.join("; ")}`);
  const s = settings as Settings;
  return {
    ...(fetch !== undefined ? { fetch } : {}),
    ...(s.baseUrl !== undefined ? { baseUrl: s.baseUrl } : {}),
    ...(s.timeoutSec !== undefined ? { timeoutMs: s.timeoutSec * 1000 } : {}),
    ...(s.minIntervalMs !== undefined ? { minIntervalMs: s.minIntervalMs } : {}),
    ...(s.userAgent !== undefined ? { userAgent: s.userAgent } : {}),
  };
}

/**
 * An implementation around a client: a site that cannot be reached is `unavailable` (the registry
 * tries the host's next implementation, if there is one); a site that answered with something the
 * client cannot read, or an input it refuses, is a failure of that call.
 */
function serve(
  client: { baseUrl: string; ping(signal?: AbortSignal): Promise<void> },
  answer: (input: Json, signal: AbortSignal) => Promise<Json>,
): ImplementationInstance {
  return {
    async invoke(input, { signal }) {
      try {
        return await answer(input, signal);
      } catch (error) {
        if (error instanceof LookupError && error.unreachable) throw new UnavailableError(error.message);
        throw error;
      }
    },
    async health({ signal }): Promise<HealthCheck> {
      try {
        await client.ping(signal);
        return { ok: true, detail: `${client.baseUrl} answers` };
      } catch (error) {
        return { ok: false, detail: messageOf(error) };
      }
    },
  };
}

// --- The OEIS ----------------------------------------------------------------------------------

/** The input of `oeis.search`: the terms of a sequence, or its number. */
export interface OeisSearchInput {
  terms?: Array<number | string>;
  id?: string;
}

/** The output of `oeis.search`: the terms are decimal text, so that none is rounded. */
export interface OeisSearchOutput {
  count: number;
  results: Array<{ id: string; name: string; offset: number; terms: string[]; keywords: string[]; url: string }>;
  url: string;
}

function oeisToWire(found: OeisSearch): OeisSearchOutput {
  return {
    count: found.count,
    results: found.records.map((r) => ({ id: r.id, name: r.name, offset: r.offset, terms: r.terms.map(String), keywords: r.keywords, url: r.url })),
    url: found.url,
  };
}

function oeisFromWire(output: OeisSearchOutput): OeisSearch {
  return { count: output.count, url: output.url, records: output.results.map((r) => ({ ...r, terms: r.terms.map((t) => BigInt(t)) })) };
}

/** The factory `oeis`: `oeis.search` over the OEIS's JSON search. Settings: `baseUrl`, `timeoutSec`, `minIntervalMs`, `userAgent`. */
export function oeisFactory(options: { fetch?: Fetch } = {}): ImplementationFactory {
  return (context) => {
    const client = new OeisClient(clientOptions(context, options.fetch));
    return serve(client, async (input, signal) => {
      const { terms, id } = input as unknown as OeisSearchInput;
      if ((terms === undefined) === (id === undefined)) throw new Error("give the terms of a sequence or its number, one of the two");
      const found = id !== undefined ? await client.byId(id, signal) : await client.search(terms as Array<number | string>, signal);
      return oeisToWire(found) as unknown as Json;
    });
  };
}

/**
 * The OEIS through the registry, for `lookupSequence`: every search is a tool run of `oeis.search` on
 * the host's implementation. Like `RegistryLeanChecker`, it keeps a failure of the service out of the
 * caller's way: a host that does not offer the capability, a site that does not answer, an answer that
 * cannot be read all come as a `LookupError` (which `lookupSequence` turns into a note). Only an
 * input the capability refuses is an error of the caller, and is thrown as it is.
 */
export class RegistryOeis implements OeisSource {
  readonly #registry: Registry;
  readonly #attemptId: string | undefined;
  readonly #actor: string | undefined;

  constructor(registry: Registry, options: { attemptId?: string; actor?: string } = {}) {
    this.#registry = registry;
    this.#attemptId = options.attemptId;
    this.#actor = options.actor;
  }

  async search(terms: readonly SequenceTerm[], signal?: AbortSignal): Promise<OeisSearch> {
    const input = { terms: toTerms(terms).map(String) } satisfies OeisSearchInput;
    try {
      const { output } = await this.#registry.invoke(OEIS_SEARCH, input, {
        ...(this.#attemptId !== undefined ? { attemptId: this.#attemptId } : {}),
        ...(this.#actor !== undefined ? { actor: this.#actor } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      return oeisFromWire(output as unknown as OeisSearchOutput);
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code === "invalid_input") throw error;
      throw new LookupError(`${OEIS_SEARCH}: ${error.details[0] ?? error.message}`, { unreachable: error.code === "unavailable" || error.code === "timeout" });
    }
  }
}

// --- The LMFDB ---------------------------------------------------------------------------------

/** The input of `lmfdb.query`. */
export interface LmfdbQueryInput {
  collection: string;
  fields: Record<string, string | number | boolean>;
  limit?: number;
}

/** The output of `lmfdb.query`: the records as the site gives them. */
export interface LmfdbQueryOutput {
  url: string;
  records: Array<Record<string, Json>>;
}

/** The factory `lmfdb`: `lmfdb.query` over the LMFDB's API. Settings as `oeisFactory`'s. */
export function lmfdbFactory(options: { fetch?: Fetch } = {}): ImplementationFactory {
  return (context) => {
    const client = new LmfdbClient(clientOptions(context, options.fetch));
    return serve(client, async (input, signal) => {
      const { collection, fields, limit } = input as unknown as LmfdbQueryInput;
      const result = await client.query(collection, fields, { signal, ...(limit !== undefined ? { limit } : {}) });
      const output: LmfdbQueryOutput = { url: result.url, records: result.records };
      return output as unknown as Json;
    });
  };
}

// --- FindStat ----------------------------------------------------------------------------------

/** The input of `findstat.identify`: objects of a collection with the value computed on each. */
export interface FindStatIdentifyInput {
  collection: string;
  data: Array<{ object: Json; value: number }>;
}

/** The output of `findstat.identify`: the statistics that agree with the values. */
export interface FindStatIdentifyOutput {
  matches: Array<{ id: string; name: string; url: string }>;
}

/** The factory `findstat`: `findstat.identify` over FindStat's statistic finder. Settings as `oeisFactory`'s. */
export function findstatFactory(options: { fetch?: Fetch } = {}): ImplementationFactory {
  return (context) => {
    const client = new FindStatClient(clientOptions(context, options.fetch));
    return serve(client, async (input, signal) => {
      const { collection, data } = input as unknown as FindStatIdentifyInput;
      const matches = await client.identify(collection, data.map(({ object, value }) => [object, value] as const), signal);
      const output: FindStatIdentifyOutput = { matches };
      return output as unknown as Json;
    });
  };
}
