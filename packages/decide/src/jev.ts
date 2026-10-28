import type { Json } from "@seshat/core";
import {
  type FactoryContext,
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
  type JsonSchema,
  UnavailableError,
  validate,
} from "@seshat/registry";
import type { DecideAskInput, DecideAskOutput } from "./capability.ts";
import { normalize } from "./distribution.ts";
import { DecisionTooLargeError } from "./errors.ts";
import { checkRequest, JEV_MAX_TOKENS, requestTokens } from "./question.ts";

/**
 * The Jev backend: an HTTP client of OpenRouter's Decisions endpoint (or TypeSafe's own API), since
 * pi-ai covers chat models and not this endpoint. The request and the answer are written from the
 * plan change's description of the endpoint (documentation/decide.md) and have never been made: this
 * environment cannot reach the host, and the tests answer from a fake server.
 *
 * What it sends is the state and the question: proof states leave the machine for a third party.
 */
export type Fetch = typeof fetch;

export interface JevOptions {
  /** Address of the API, without a final slash, such as `https://openrouter.ai/api/alpha`. */
  baseUrl: string;
  apiKey: string;
  /** The pinned model, never the `latest` alias. */
  model: string;
  /** The hosts the client may send to. A `baseUrl` on another host is refused. */
  allowedHosts: readonly string[];
  timeoutMs?: number;
  fetch?: Fetch;
}

export class JevClient {
  readonly options: JevOptions;
  readonly host: string;

  constructor(options: JevOptions) {
    if (options.apiKey.trim() === "") throw new UnavailableError("Jev: no API key (set JEV_API_KEY)");
    if (/^(latest|.*[/:-]latest)$/i.test(options.model.trim()) || options.model.trim() === "") {
      throw new UnavailableError(`Jev: the model must be pinned to a version, not ${JSON.stringify(options.model)}`);
    }
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new UnavailableError(`Jev: ${JSON.stringify(options.baseUrl)} is not an address`);
    }
    if (!options.allowedHosts.includes(url.hostname)) {
      throw new UnavailableError(`Jev: the host ${url.hostname} is not among the allowed hosts of this profile (${options.allowedHosts.join(", ") || "none"})`);
    }
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
    this.host = url.hostname;
  }

  /** One decision. A host that cannot be reached, or is busy, is `UnavailableError`; anything else that goes wrong is a failure of the call. */
  async decide(input: DecideAskInput, signal: AbortSignal): Promise<DecideAskOutput> {
    checkRequest(input);
    const tokens = requestTokens(input);
    if (tokens > JEV_MAX_TOKENS) throw new DecisionTooLargeError(tokens, JEV_MAX_TOKENS);
    const q = input.question;
    const body: Json = {
      model: this.options.model,
      type: q.type,
      input: input.state,
      instructions: q.instructions,
      ...(q.type === "choice" ? { options: q.options } : {}),
      ...(q.type === "score" ? { levels: q.levels } : {}),
    };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${this.options.timeoutMs ?? 30_000} ms`)), this.options.timeoutMs ?? 30_000);
    const joined = AbortSignal.any([signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify(body),
          signal: joined,
        });
      } catch (error) {
        const why = joined.aborted ? String(joined.reason instanceof Error ? joined.reason.message : joined.reason) : error instanceof Error ? error.message : String(error);
        throw new UnavailableError(`Jev at ${this.host}: ${why}`);
      }
      if (!response.ok) {
        const busy = response.status >= 500 || response.status === 408 || response.status === 429;
        if (busy) throw new UnavailableError(`Jev at ${this.host}: HTTP ${response.status}`);
        throw new Error(`Jev at ${this.host} refused the request: HTTP ${response.status}`);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new UnavailableError(`Jev at ${this.host}: the answer is not JSON`);
      }
      return this.read(input, json);
    } finally {
      clearTimeout(timer);
    }
  }

  private read(input: DecideAskInput, json: unknown): DecideAskOutput {
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("Jev answered something that is not an object");
    const body = json as Record<string, unknown>;
    const distribution = body.distribution;
    if (typeof distribution !== "object" || distribution === null || Array.isArray(distribution)) throw new Error("Jev's answer has no distribution");
    const answered = normalize(input.question, body.answer, distribution as Record<string, unknown>);
    const usage = typeof body.usage === "object" && body.usage !== null ? (body.usage as Record<string, unknown>) : {};
    const cost = usage.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new Error("Jev's answer has no usage.cost: the decision cannot be charged");
    const promptTokens = usage.prompt_tokens;
    return {
      answer: answered.answer,
      probabilities: answered.probabilities,
      backend: "jev",
      model: typeof body.model === "string" && body.model !== "" ? body.model : this.options.model,
      costUsd: cost,
      ...(typeof promptTokens === "number" && Number.isFinite(promptTokens) ? { inputTokens: promptTokens } : {}),
    };
  }
}

const SETTINGS: JsonSchema = {
  type: "object",
  required: ["baseUrl", "apiKey", "model", "allowedHosts"],
  properties: {
    baseUrl: { type: "string", minLength: 1 },
    apiKey: { type: "string" },
    model: { type: "string", minLength: 1 },
    allowedHosts: { type: "array", items: { type: "string", minLength: 1 } },
    timeoutSec: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

/** The `jev` implementation of `decide.ask`; `fetch` is for tests. A missing key, model or host makes it unavailable, which makes the caller fall back to the run's model. */
export function jevFactory(fetch?: Fetch): ImplementationFactory {
  return ({ settings }: FactoryContext): ImplementationInstance => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new UnavailableError(`jev: ${problems.join("; ")}`);
    const s = settings as { baseUrl: string; apiKey: string; model: string; allowedHosts: string[]; timeoutSec?: number };
    const client = new JevClient({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      allowedHosts: s.allowedHosts,
      ...(s.timeoutSec !== undefined ? { timeoutMs: s.timeoutSec * 1000 } : {}),
      ...(fetch !== undefined ? { fetch } : {}),
    });
    return {
      async invoke(input, { signal }) {
        return (await client.decide(input as unknown as DecideAskInput, signal)) as unknown as Json;
      },
      async health(): Promise<HealthCheck> {
        // A request costs money and sends nothing useful to check, so health only says what is configured.
        return { ok: true, detail: `configured for ${client.host}, model ${client.options.model}; no request made` };
      },
    };
  };
}
