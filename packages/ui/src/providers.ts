import type { AuthContext, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { KeyStore } from "./keys.ts";

/**
 * The providers and models of the settings screen (documentation/ui.md, "Provider settings"). Nothing here names a provider: the list is
 * what the pi-ai library holds at run time, and the environment variable a provider reads its key from is found by asking the library,
 * which reports every variable it looks at while it checks a provider's credentials.
 */

export interface ProviderInfo {
  id: string;
  name: string;
  models: number;
  /** The environment variable a key is passed in, or null when the provider has none to give (ambient credentials, a local server). */
  variable: string | null;
  /** Credentials are found, from a stored key or from the environment. */
  configured: boolean;
  /** Where they come from, in words: `stored in the key file`, or what the library says (`OPENAI_API_KEY`). */
  source: string | null;
  /** A key for this provider is in the key file. */
  stored: boolean;
}

export interface ModelInfo {
  id: string;
  /** `provider/id`, the form `--model` takes. */
  name: string;
  context: number;
  reasoning: boolean;
  /** Dollars per million tokens, input and output, from the library's table. */
  inputPrice: number;
  outputPrice: number;
}

/** An environment read as the library asks for it: the names it asks for are recorded, the values come from `values`. */
function recordingContext(values: () => Readonly<Record<string, string | undefined>>, asked: string[]): AuthContext {
  return {
    env: async (name) => {
      asked.push(name);
      return values()[name];
    },
    fileExists: async () => false,
  };
}

/** The environment a key is looked up in: the stored keys first, then the process's own. */
export function overlayEnv(store: KeyStore, base: Readonly<Record<string, string | undefined>> = process.env): () => Record<string, string | undefined> {
  return () => ({ ...base, ...(safeEnv(store)) });
}

function safeEnv(store: KeyStore): Record<string, string> {
  try {
    return store.env();
  } catch {
    // A key file that cannot be read is reported by the settings screen; a check of credentials sees none from it.
    return {};
  }
}

/** The models the server and its doctor use: pi-ai's providers, with the stored keys counted as credentials. */
export function serverModels(store: KeyStore, base: Readonly<Record<string, string | undefined>> = process.env): Models {
  const values = overlayEnv(store, base);
  return builtinModels({ authContext: { env: async (name) => values()[name], fileExists: async () => false } });
}

/**
 * Finds the variable that carries a provider's key: of the names the library reads while it checks the provider, the first ending in
 * `API_KEY` (then `TOKEN`) with which the library says the provider is configured. Undefined when there is none.
 */
export class VariableFinder {
  private readonly asked: string[] = [];
  private readonly given: Record<string, string> = {};
  private readonly models: Models;
  private readonly cache = new Map<string, string | null>();

  constructor() {
    this.models = builtinModels({ authContext: recordingContext(() => this.given, this.asked) });
  }

  async variable(providerId: string): Promise<string | null> {
    const known = this.cache.get(providerId);
    if (known !== undefined) return known;
    this.asked.length = 0;
    for (const k of Object.keys(this.given)) delete this.given[k];
    await this.models.checkAuth(providerId).catch(() => undefined);
    const names = [...new Set(this.asked)];
    const candidates = [...names.filter((n) => /API_KEY$/.test(n)), ...names.filter((n) => /TOKEN$/.test(n) && !/AUTH_TOKEN$/.test(n))];
    let found: string | null = null;
    for (const name of candidates) {
      for (const k of Object.keys(this.given)) delete this.given[k];
      this.given[name] = "probe-value-only";
      const auth = await this.models.checkAuth(providerId).catch(() => undefined);
      if (auth !== undefined) {
        found = name;
        break;
      }
    }
    for (const k of Object.keys(this.given)) delete this.given[k];
    this.cache.set(providerId, found);
    return found;
  }
}

/** The providers of the library, with whether each has credentials. No key is in the answer. */
export async function describeProviders(models: Models, finder: VariableFinder, store: KeyStore): Promise<ProviderInfo[]> {
  let stored: string[] = [];
  try {
    stored = store.providers();
  } catch {
    stored = [];
  }
  const out: ProviderInfo[] = [];
  for (const p of models.getProviders()) {
    const auth = await models.checkAuth(p.id).catch(() => undefined);
    const isStored = stored.includes(p.id);
    out.push({
      id: p.id,
      name: p.name,
      models: models.getModels(p.id).length,
      variable: await finder.variable(p.id),
      configured: auth !== undefined,
      source: isStored ? "stored in the key file" : (auth?.source ?? null),
      stored: isStored,
    });
  }
  return out.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
}

/** The chat models of one provider, as the library lists them now. */
export function describeModels(models: Models, providerId: string): ModelInfo[] | undefined {
  if (models.getProvider(providerId) === undefined) return undefined;
  return models.getModels(providerId).map((m) => ({
    id: m.id,
    name: `${providerId}/${m.id}`,
    context: m.contextWindow,
    reasoning: m.reasoning,
    inputPrice: m.cost.input,
    outputPrice: m.cost.output,
  }));
}
