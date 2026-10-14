import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, type Json } from "@seshat/core";
import { CatalogError, type Catalog } from "./manifest.ts";
import { isPlainObject, validate, type JsonSchema } from "./schema.ts";

/** How one host provides a capability. */
export interface CapabilityBinding {
  /** Implementation ids, in order of preference. The next one is tried only when one cannot be reached. */
  use: string[];
  /**
   * Per implementation id: settings of an in-process implementation, or fields of an MCP server
   * that replace the manifest's. Secrets are never written here: `${env:NAME}` reads a variable.
   */
  settings?: Record<string, Record<string, Json>>;
  /** Replaces the manifest's time limit on this host. */
  timeoutMs?: number;
}

/**
 * Where the harness runs (a workstation, the dedicated server) is configuration: a profile names,
 * for each capability the host offers, the implementations to use and how to reach them. A
 * capability that the profile does not name is unavailable on that host.
 */
export interface HostProfile {
  host: string;
  description?: string;
  capabilities: Record<string, CapabilityBinding>;
}

const PROFILE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["host", "capabilities"],
  properties: {
    host: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    description: { type: "string" },
    capabilities: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["use"],
        properties: {
          use: { type: "array", minItems: 1, items: { type: "string" } },
          settings: { type: "object", additionalProperties: { type: "object" } },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export function hostProfilePath(configDir: string, host: string): string {
  return join(configDir, "hosts", `${host}.json`);
}

export function parseHostProfile(value: unknown, origin = "host profile"): HostProfile {
  const problems = validate(PROFILE_SCHEMA, value).map((p) => `${origin} ${p}`);
  if (problems.length > 0) throw new CatalogError(problems);
  return value as HostProfile;
}

export function loadHostProfile(path: string): HostProfile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogError([`${path}: ${(error as Error).message}`]);
  }
  return parseHostProfile(value, path);
}

/** Problems between a profile and a catalog: unknown capabilities, implementations or settings. */
export function checkHostProfile(profile: HostProfile, catalog: Catalog): string[] {
  const problems: string[] = [];
  for (const [id, binding] of Object.entries(profile.capabilities)) {
    const capability = catalog.capabilities.get(id);
    if (!capability) {
      problems.push(`host ${profile.host}: unknown capability ${id}`);
      continue;
    }
    const known = new Set(capability.manifest.implementations.map((i) => i.id));
    for (const impl of binding.use) {
      if (!known.has(impl)) problems.push(`host ${profile.host}: ${id} has no implementation ${impl}`);
    }
    if (new Set(binding.use).size !== binding.use.length) problems.push(`host ${profile.host}: ${id} lists an implementation twice`);
    for (const impl of Object.keys(binding.settings ?? {})) {
      if (!known.has(impl)) problems.push(`host ${profile.host}: settings for unknown implementation ${id}/${impl}`);
    }
  }
  return problems;
}

export function hostProfileHash(profile: HostProfile): string {
  return hashJson(profile);
}

/** A `${env:NAME}` variable that is not set, found while preparing an implementation. */
export class MissingVariableError extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(`environment variable${names.length > 1 ? "s" : ""} ${names.join(", ")} not set`);
    this.names = names;
  }
}

export interface Variables {
  /** Directory of the capability's manifest. */
  dir: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Replaces `${dir}`, `${env:NAME}` and `${env:NAME:-default}` in every string of a value. Throws
 * `MissingVariableError` naming all unset variables that have no default. `$${` stands for a
 * literal `${`.
 */
export function interpolate<T extends Json>(value: T, variables: Variables): T {
  const missing = new Set<string>();
  const result = substitute(value, variables, missing);
  if (missing.size > 0) throw new MissingVariableError([...missing].sort());
  return result as T;
}

function substitute(value: Json, variables: Variables, missing: Set<string>): Json {
  if (typeof value === "string") {
    return value.replace(/\$?\$\{([^}]*)\}/g, (match: string, name: string) => {
      if (match.startsWith("$$")) return match.slice(1);
      if (name === "dir") return variables.dir;
      const env = /^env:([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s.exec(name);
      if (env) {
        const found = variables.env[env[1] as string] ?? env[2];
        if (found === undefined) missing.add(env[1] as string);
        return found ?? "";
      }
      throw new Error(`unknown variable ${match}; use \${dir}, \${env:NAME} or \${env:NAME:-default}`);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables, missing));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v as Json, variables, missing)]));
  }
  return value;
}
