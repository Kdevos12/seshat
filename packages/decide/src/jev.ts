import type { Json } from "@seshat/core";
import type { DecideQuestion } from "@seshat/lines";
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
import { normalize, topLabel } from "./distribution.ts";
import { DecisionTooLargeError } from "./errors.ts";
import { checkRequest, JEV_MAX_TOKENS, labelsOf, requestTokens } from "./question.ts";

/**
 * The Jev backend: a small HTTP client of TypeSafe's System One protocol, which TypeSafe serves at its own
 * API (`POST {base}/systemone`) and OpenRouter serves twice, as System One (`POST /api/v1/systemone`) and as
 * its Decisions endpoint (`POST /api/alpha/decisions`), with the same body: `{ model, state, questions }`,
 * answered with `{ model, answers, usage }` (documentation/decide.md, "The wire"). The shapes are those of the
 * providers' published references; this environment cannot reach either host, and the tests answer from a
 * fake server.
 *
 * It is not pi-ai's classifier client because this one keeps three guards of its own: the hosts a profile
 * allows, no redirect, and a request too long for the provider's normal mode refused before it is sent.
 *
 * What it sends is the state and the question: proof states leave the machine for a third party.
 */
export type Fetch = typeof fetch;

export interface JevOptions {
  /** Address of the API, without a final slash, such as `https://api.typesafe.ai/v1`. */
  baseUrl: string;
  /** The endpoint under `baseUrl`, such as `/systemone` (the default) or `/decisions`. */
  path?: string;
  apiKey: string;
  /** The pinned model, never a `latest` or `preview` alias. */
  model: string;
  /** The hosts the client may send to. A `baseUrl` on another host is refused. */
  allowedHosts: readonly string[];
  /** Dollars per million input tokens, for an answer whose usage gives tokens and no cost (TypeSafe's own API). */
  inputUsdPerMillion?: number;
  /** Dollars per million output tokens; Jev's are free, so the default is 0. */
  outputUsdPerMillion?: number;
  /** The name of the provider preset, for messages. */
  provider?: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

/** Booked for an answer that says neither its cost nor its tokens (or has no price to multiply them by): a deliberately high figure for one short decision. */
export const JEV_UNREPORTED_COST_USD = 0.01;

/** The name under which the one question of a request is sent and answered. */
export const JEV_QUESTION = "decision";

/** A model name that moves: `latest`, `preview`, or a name ending in either. */
const MOVING_ALIAS = /^(latest|preview|.*[/:~-](latest|preview))$/i;

/** Whether a model name is pinned: not a moving alias, and a version (a digit) in its last segment, so `jev` alone is refused too. */
export function isPinnedModel(model: string): boolean {
  const name = model.trim();
  return name !== "" && !MOVING_ALIAS.test(name) && /\d/.test(name.split("/").pop() ?? "");
}

export class JevClient {
  readonly options: JevOptions;
  readonly host: string;
  readonly url: string;

  constructor(options: JevOptions) {
    const keyHint = options.provider === "openrouter" ? "JEV_API_KEY or OPENROUTER_API_KEY" : options.provider === "typesafe" ? "JEV_API_KEY or TYPESAFE_API_KEY" : "JEV_API_KEY";
    if (options.apiKey.trim() === "") throw new UnavailableError(`Jev: no API key (set ${keyHint})`);
    if (!isPinnedModel(options.model)) {
      throw new UnavailableError(`Jev: the model must be pinned to a version (JEV_MODEL), not ${JSON.stringify(options.model)}`);
    }
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new UnavailableError(`Jev: ${JSON.stringify(options.baseUrl)} is not an address`);
    }
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new UnavailableError(`Jev: ${url.origin} is not https: the key and the state would travel in clear`);
    }
    if (!options.allowedHosts.includes(url.hostname)) {
      throw new UnavailableError(`Jev: the host ${url.hostname} is not among the allowed hosts of this profile (${options.allowedHosts.join(", ") || "none"})`);
    }
    // OpenRouter's keys say what they are: one is never sent to another company.
    if (options.apiKey.trim().startsWith("sk-or-") && url.hostname !== "openrouter.ai") {
      throw new UnavailableError(`Jev: the key is an OpenRouter key, and the address is ${url.hostname}: set the key of that provider (TYPESAFE_API_KEY for typesafe)`);
    }
    const path = options.path === undefined || options.path === "" ? "/systemone" : options.path.startsWith("/") ? options.path : `/${options.path}`;
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, ""), path };
    this.host = url.hostname;
    this.url = `${this.options.baseUrl}${path}`;
  }

  /** One decision. A host that cannot be reached, or is busy, is `UnavailableError`; anything else that goes wrong is a failure of the call. */
  async decide(input: DecideAskInput, signal: AbortSignal): Promise<DecideAskOutput> {
    checkRequest(input);
    const tokens = requestTokens(input);
    if (tokens > JEV_MAX_TOKENS) throw new DecisionTooLargeError(tokens, JEV_MAX_TOKENS);
    const body = { model: this.options.model, state: input.state, questions: { [JEV_QUESTION]: wireQuestion(input.question) } };
    const limit = this.options.timeoutMs ?? 30_000;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no answer within ${limit} ms`)), limit);
    const joined = AbortSignal.any([signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify(body),
          signal: joined,
          // A redirect would send the proof state to a host that was never checked against allowedHosts.
          redirect: "error",
        });
      } catch (error) {
        const why = joined.aborted ? String(joined.reason instanceof Error ? joined.reason.message : joined.reason) : error instanceof Error ? error.message : String(error);
        throw new UnavailableError(`Jev at ${this.host}: ${why}`);
      }
      if (!response.ok) {
        const busy = response.status >= 500 || response.status === 408 || response.status === 429;
        const said = (await errorMessage(response)).split(this.options.apiKey).join("[key]");
        if (busy) throw new UnavailableError(`Jev at ${this.host}: HTTP ${response.status}${said}`);
        throw new Error(`Jev at ${this.host} refused the request: HTTP ${response.status}${said}`);
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
    if (!isRecord(json)) throw new Error("Jev answered something that is not an object");
    const answers = json.answers;
    if (!isRecord(answers)) throw new Error("Jev's answer has no answers");
    const answer = answers[JEV_QUESTION];
    if (!isRecord(answer)) throw new Error(`Jev's answer has no answer for ${JEV_QUESTION}`);
    const answered = readAnswer(input.question, answer);
    const usage = isRecord(json.usage) ? json.usage : {};
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    return {
      answer: answered.answer,
      probabilities: answered.probabilities,
      backend: "jev",
      model: typeof json.model === "string" && json.model !== "" ? json.model : this.options.model,
      costUsd: this.costOf(usage.cost, inputTokens, outputTokens),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }

  /**
   * The dollars of one answer: the cost the provider reports (OpenRouter's `usage.cost`); otherwise its tokens at the profile's
   * prices (TypeSafe's own API reports tokens and no cost); otherwise the conservative estimate, because Jev charged for the call
   * whether or not it said how much.
   */
  private costOf(cost: unknown, inputTokens: number | undefined, outputTokens: number | undefined): number {
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
    const price = this.options.inputUsdPerMillion;
    if (inputTokens !== undefined && price !== undefined) return (inputTokens * price + (outputTokens ?? 0) * (this.options.outputUsdPerMillion ?? 0)) / 1e6;
    return JEV_UNREPORTED_COST_USD;
  }
}

/** The question on the wire: options become a choice's criteria, levels a score's (lowest first), and a yes or no a noul. */
export function wireQuestion(q: DecideQuestion): Record<string, Json> {
  switch (q.type) {
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: { ...q.options } };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: [...q.levels] };
    case "noul":
      // TypeSafe's API takes a noul without criteria, OpenRouter's Decisions endpoint requires both keys.
      return { type: "noul", instructions: q.instructions, criteria: { true: "yes", false: "no" } };
  }
}

/** A provider's answer to the one question, as a label and a distribution over the question's labels. */
function readAnswer(q: DecideQuestion, answer: Record<string, unknown>): ReturnType<typeof normalize> {
  if (answer.type !== q.type) throw new Error(`Jev answered a ${String(answer.type)} to a ${q.type}`);
  if (q.type === "choice") {
    if (!isRecord(answer.probabilities)) throw new Error("Jev's choice has no probabilities");
    return normalize(q, answer.choice, answer.probabilities);
  }
  if (q.type === "score") {
    // Probabilities are keyed by the level's position from 0 ("0", "1", ...), which `legend` names: with a legend, a key is read
    // through it and its name must be the level at that position; without one, a numeric key is a position and any other a level's name.
    const levels = labelsOf(q);
    if (!isRecord(answer.probabilities)) throw new Error("Jev's score has no probabilities");
    const legend = isRecord(answer.legend) ? answer.legend : undefined;
    const distribution: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answer.probabilities)) {
      let level: string | undefined;
      if (legend !== undefined && key in legend) {
        level = typeof legend[key] === "string" && levels.includes(legend[key]) ? legend[key] : undefined;
        if (level !== undefined && /^\d+$/.test(key) && levels[Number(key)] !== level) throw new Error(`Jev's score legend puts ${JSON.stringify(level)} at position ${key}, not where the question has it`);
      } else {
        level = /^\d+$/.test(key) ? levels[Number(key)] : levels.includes(key) ? key : undefined;
      }
      if (level === undefined) throw new Error(`Jev's score has a probability for ${JSON.stringify(key)}, which is not one of the question's levels`);
      if (level in distribution) throw new Error(`Jev's score gives ${JSON.stringify(level)} two probabilities`);
      distribution[level] = value;
    }
    const numeric = Object.fromEntries(Object.entries(distribution).map(([k, v]) => [k, typeof v === "number" ? v : Number.NaN]));
    return normalize(q, topLabel(levels, numeric), distribution);
  }
  const p = answer.noul;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error("Jev's noul is not a probability");
  return normalize(q, p >= 0.5, { yes: p, no: 1 - p });
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    let message: unknown = text;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) message = isRecord(parsed.error) ? parsed.error.message : (parsed.detail ?? parsed.message ?? text);
    } catch {
      // not JSON: the text as it is
    }
    const said = (typeof message === "string" ? message : JSON.stringify(message)).replace(/\s+/g, " ").trim().slice(0, 200);
    return said === "" ? "" : ` (${said})`;
  } catch {
    return "";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

/** One provider of Jev in a host profile: its address, endpoint, key, pinned model and price. */
export interface JevProviderSettings {
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  model?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

const PROVIDER: JsonSchema = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    path: { type: "string" },
    apiKey: { type: "string" },
    model: { type: "string" },
    inputUsdPerMillion: { type: "number", minimum: 0 },
    outputUsdPerMillion: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

const SETTINGS: JsonSchema = {
  type: "object",
  required: ["allowedHosts"],
  properties: {
    provider: { type: "string" },
    providers: { type: "object", additionalProperties: PROVIDER },
    ...(PROVIDER.properties as Record<string, JsonSchema>),
    allowedHosts: { type: "array", items: { type: "string", minLength: 1 } },
    timeoutSec: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * The client's options from a host profile's settings: the preset named by `provider` (from `providers`), with each
 * non-empty top-level field (`baseUrl`, `path`, `apiKey`, `model`, the prices) in its place. An empty string is unset,
 * which is what `${env:NAME:-}` gives for a variable that is not set.
 */
export function jevOptionsFrom(settings: Record<string, unknown>): Omit<JevOptions, "fetch"> {
  const problems = validate(SETTINGS, settings as Json, "settings");
  if (problems.length > 0) throw new UnavailableError(`jev: ${problems.join("; ")}`);
  const s = settings as unknown as JevProviderSettings & { provider?: string; providers?: Record<string, JevProviderSettings>; allowedHosts: string[]; timeoutSec?: number };
  const name = s.provider?.trim() ?? "";
  const presets = s.providers ?? {};
  let preset: JevProviderSettings = {};
  if (name !== "") {
    const found = presets[name];
    if (found === undefined) {
      throw new UnavailableError(`jev: the provider ${JSON.stringify(name)} (JEV_PROVIDER) is not one of this profile's: ${Object.keys(presets).join(", ") || "none"}`);
    }
    preset = found;
  }
  const pick = (key: "baseUrl" | "path" | "apiKey" | "model"): string => {
    const own = s[key];
    return own !== undefined && own.trim() !== "" ? own.trim() : (preset[key] ?? "").trim();
  };
  // The key: the provider's own variable first, so that switching JEV_PROVIDER never sends one company's key to the other;
  // JEV_API_KEY is the key of whichever provider is chosen.
  const presetKey = (preset.apiKey ?? "").trim();
  const price = (key: "inputUsdPerMillion" | "outputUsdPerMillion"): number | undefined => s[key] ?? preset[key];
  const input = price("inputUsdPerMillion");
  const output = price("outputUsdPerMillion");
  const baseUrl = pick("baseUrl");
  if (baseUrl === "") throw new UnavailableError("jev: no address (set JEV_PROVIDER to openrouter or typesafe, or JEV_BASE_URL)");
  return {
    baseUrl,
    path: pick("path"),
    apiKey: presetKey !== "" ? presetKey : pick("apiKey"),
    model: pick("model"),
    allowedHosts: s.allowedHosts,
    ...(name !== "" ? { provider: name } : {}),
    ...(input !== undefined ? { inputUsdPerMillion: input } : {}),
    ...(output !== undefined ? { outputUsdPerMillion: output } : {}),
    ...(s.timeoutSec !== undefined ? { timeoutMs: s.timeoutSec * 1000 } : {}),
  };
}

/** The `jev` implementation of `decide.ask`; `fetch` is for tests. A missing key, model or host makes it unavailable, which makes the caller fall back to the run's model. */
export function jevFactory(fetch?: Fetch): ImplementationFactory {
  return ({ settings }: FactoryContext): ImplementationInstance => {
    const client = new JevClient({ ...jevOptionsFrom(settings as Record<string, unknown>), ...(fetch !== undefined ? { fetch } : {}) });
    return {
      async invoke(input, { signal }) {
        return (await client.decide(input as unknown as DecideAskInput, signal)) as unknown as Json;
      },
      async health(): Promise<HealthCheck> {
        // A request costs money and sends nothing useful to check, so health only says what is configured.
        return { ok: true, detail: `configured for ${client.url}${client.options.provider !== undefined ? ` (${client.options.provider})` : ""}, model ${client.options.model}; no request made` };
      },
    };
  };
}
