import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CLAIM_STATUSES, hashJson, type ClaimStatus, type Json } from "@math-harness/core";
import { CAPABILITY_ERROR_CODES, type CapabilityErrorCode } from "./implementation.ts";
import { checkPath } from "./paths.ts";
import { checkSchema, isPlainObject, validate, type JsonSchema } from "./schema.ts";

/**
 * How the agent reaches a capability (documentation/capabilities.md#exposure): `auto` only through
 * the orchestrator, `direct` as one of the few tools always declared to the model, `deferred` on
 * demand, through tool search or code.
 */
export type Exposure = "auto" | "direct" | "deferred";

export interface CapabilityExample {
  title: string;
  input: Json;
  output?: Json;
  note?: string;
}

interface ImplementationSpecBase {
  /** Unique within the capability, e.g. `kimina`. */
  id: string;
  /** The pinned version, recorded in every tool run. */
  version: string;
  description?: string;
  /** What the results depend on besides the input, e.g. `{ "lean": "v4.27.0" }`. */
  environment?: Record<string, string>;
}

/** Code in this process, built by a factory that the composition root registers under `factory`. */
export interface InprocImplementationSpec extends ImplementationSpecBase {
  kind: "inproc";
  factory: string;
  /** Default settings, which a host profile can override. */
  settings?: Record<string, Json>;
}

export type McpServerSpec =
  | { transport: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { transport: "http"; url: string; headers?: Record<string, string> };

/** How an MCP server keeps a separate state for each scope of a stateful capability. */
export interface McpScopeSpec {
  /** The tool argument that receives the scope's name on every call, e.g. `session`. */
  argument: string;
  /** The tool that ends a scope's state, and its argument that receives the scope's name. */
  release?: { tool: string; argument: string };
}

/** A tool of an MCP server, in its own process or behind a URL. */
export interface McpImplementationSpec extends ImplementationSpecBase {
  kind: "mcp";
  /** The MCP tool to call. The capability's input is passed as its arguments. */
  tool: string;
  /** Default server; a host profile can override any of its fields. */
  server: McpServerSpec;
  /** Refuse a server whose `serverInfo.version` is not `version`. Default true. */
  versionCheck?: boolean;
  /** Required for a stateful capability: how the server separates the scopes. */
  scope?: McpScopeSpec;
}

export type ImplementationSpec = InprocImplementationSpec | McpImplementationSpec;

export interface CapabilityManifest {
  /** `namespace.name`, e.g. `lean.check`. Stable: callers name capabilities, never tools. */
  id: string;
  /** Version of the contract (input, output, meaning). A breaking change is a new version. */
  version: number;
  title: string;
  /** Written for the model: what it does and what it returns. */
  description: string;
  when: string[];
  whenNot: string[];
  exposure: Exposure;
  /**
   * Calls in the same scope share state, as the variables of a computer algebra session do; calls
   * in different scopes never see each other's. Callers pass a scope and release it when done.
   */
  stateful?: boolean;
  input: JsonSchema;
  output: JsonSchema;
  /** Claim statuses a result can justify. `proved` and `refuted` need a `certificate`. */
  produces?: ClaimStatus[];
  /** What makes a result trustworthy, e.g. "finite model, checked in Lean by decide". */
  certificate?: string;
  /** Default time limit of one call, in milliseconds. */
  timeoutMs: number;
  /**
   * An optional numeric input field, in seconds, that sets the tool's own time limit. A call that
   * gives it is allowed that long plus a margin, so that the tool stops itself and says so first.
   */
  timeoutField?: string;
  /** Paths of the output recorded in each tool run, e.g. `results.*.status`. */
  summary?: string[];
  examples?: CapabilityExample[];
  implementations: ImplementationSpec[];
}

/** One check of a contract case, on the value at `path` of the output (documentation/capabilities.md#contract-tests). */
export type Expectation = { path: string } & (
  | { equals: Json }
  | { matches: string }
  | { length: number }
  | { atLeast: number }
  | { atMost: number }
  | { exists: boolean }
  | { some: Expectation[] }
  | { every: Expectation[] }
);

export const EXPECTATION_OPERATORS = ["equals", "matches", "length", "atLeast", "atMost", "exists", "some", "every"] as const;

export interface ContractCase {
  name: string;
  /** What the harness relies on that this case checks. */
  purpose?: string;
  /** Of a stateful capability: inputs called first, in the case's scope, which must succeed. */
  before?: Json[];
  input: Json;
  /** Checks on the output. */
  expect?: Expectation[];
  /** Instead of `expect`: the call must fail with this error code, and a message matching `matches`. */
  fails?: { code: CapabilityErrorCode; matches?: string };
  timeoutMs?: number;
}

export interface Capability {
  manifest: CapabilityManifest;
  contract: ContractCase[];
  /** Directory of the manifest; `${dir}` in settings and server fields stands for it. */
  dir: string;
  /** sha256 of the canonical manifest, files included. */
  hash: string;
}

export interface Catalog {
  dir: string;
  capabilities: ReadonlyMap<string, Capability>;
  /** sha256 over every capability's id and hash: pins the contracts and implementation versions of a run. */
  hash: string;
}

export class CatalogError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid capability catalog:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

const ID_PATTERN = "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$";

const SERVER_SCHEMA: JsonSchema = {
  type: "object",
  required: ["transport"],
  properties: {
    transport: { enum: ["stdio", "http"] },
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    url: { type: "string", minLength: 1 },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: false,
};

const IMPLEMENTATION_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "version", "kind"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    version: { type: "string", minLength: 1 },
    kind: { enum: ["inproc", "mcp"] },
    description: { type: "string" },
    environment: { type: "object", additionalProperties: { type: "string" } },
    factory: { type: "string", minLength: 1 },
    settings: { type: "object" },
    tool: { type: "string", minLength: 1 },
    server: SERVER_SCHEMA,
    versionCheck: { type: "boolean" },
    scope: {
      type: "object",
      required: ["argument"],
      properties: {
        argument: { type: "string", minLength: 1 },
        release: {
          type: "object",
          required: ["tool", "argument"],
          properties: { tool: { type: "string", minLength: 1 }, argument: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "version", "title", "description", "when", "whenNot", "exposure", "input", "output", "timeoutMs", "implementations"],
  properties: {
    id: { type: "string", pattern: ID_PATTERN },
    version: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", minLength: 1 },
    when: { type: "array", items: { type: "string", minLength: 1 } },
    whenNot: { type: "array", items: { type: "string", minLength: 1 } },
    exposure: { enum: ["auto", "direct", "deferred"] },
    stateful: { type: "boolean" },
    input: { type: "object" },
    output: { type: "object" },
    produces: { type: "array", items: { enum: [...CLAIM_STATUSES] } },
    certificate: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    timeoutField: { type: "string", minLength: 1 },
    summary: { type: "array", items: { type: "string" } },
    examples: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "input"],
        properties: { title: { type: "string", minLength: 1 }, input: {}, output: {}, note: { type: "string" } },
        additionalProperties: false,
      },
    },
    implementations: { type: "array", minItems: 1, items: IMPLEMENTATION_SCHEMA },
  },
  additionalProperties: false,
};

const CONTRACT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["capability", "cases"],
  properties: {
    capability: { type: "string" },
    cases: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "input"],
        properties: {
          name: { type: "string", minLength: 1 },
          purpose: { type: "string" },
          before: { type: "array", minItems: 1 },
          input: {},
          expect: { type: "array", items: { type: "object" } },
          fails: {
            type: "object",
            required: ["code"],
            properties: { code: { enum: [...CAPABILITY_ERROR_CODES] }, matches: { type: "string" } },
            additionalProperties: false,
          },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/**
 * Loads every `<dir>/<capability id>/manifest.json`, with its optional `contract.json`. Any object
 * of the form `{"$file": "path"}` is replaced by the text of that file, relative to the
 * capability's directory, so that Lean code and long texts live in their own files. All problems
 * of the catalog are reported together.
 */
export function loadCatalog(dir: string): Catalog {
  const root = resolve(dir);
  const problems: string[] = [];
  const capabilities = new Map<string, Capability>();
  const names = existsSync(root) ? readdirSync(root).sort() : [];
  if (!existsSync(root)) problems.push(`${root}: no such directory`);
  for (const name of names) {
    const capabilityDir = join(root, name);
    if (!statSync(capabilityDir).isDirectory()) continue;
    const manifestPath = join(capabilityDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      problems.push(`${name}: no manifest.json`);
      continue;
    }
    const before = problems.length;
    const manifest = readJson(manifestPath, capabilityDir, problems);
    const contractPath = join(capabilityDir, "contract.json");
    const id = isPlainObject(manifest) && typeof manifest.id === "string" ? manifest.id : name;
    const contract = existsSync(contractPath) ? readJson(contractPath, capabilityDir, problems) : { capability: id, cases: [] };
    if (problems.length > before) continue;
    const found = checkCapability(name, manifest, contract);
    problems.push(...found);
    if (found.length > 0) continue;
    const m = manifest as unknown as CapabilityManifest;
    capabilities.set(m.id, {
      manifest: m,
      contract: (contract as { cases: ContractCase[] }).cases,
      dir: capabilityDir,
      hash: hashJson(manifest),
    });
  }
  if (problems.length > 0) throw new CatalogError(problems);
  return {
    dir: root,
    capabilities,
    hash: hashJson([...capabilities.values()].map((c) => [c.manifest.id, c.hash])),
  };
}

function readJson(path: string, base: string, problems: string[]): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`${path}: ${(error as Error).message}`);
    return undefined;
  }
  return resolveFiles(value, base, path, problems);
}

function resolveFiles(value: unknown, base: string, origin: string, problems: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveFiles(item, base, origin, problems));
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$file") {
    const file = value.$file;
    if (typeof file !== "string") {
      problems.push(`${origin}: $file must be a path`);
      return "";
    }
    const target = resolve(base, file);
    const rel = relative(base, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      problems.push(`${origin}: $file ${JSON.stringify(file)} is outside the capability's directory`);
      return "";
    }
    try {
      return readFileSync(target, "utf8");
    } catch (error) {
      problems.push(`${origin}: $file ${JSON.stringify(file)}: ${(error as Error).message}`);
      return "";
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFiles(v, base, origin, problems)]));
}

/** Every problem of one capability; empty when it can be loaded. */
export function checkCapability(dirName: string, manifest: unknown, contract: unknown): string[] {
  const shape = validate(MANIFEST_SCHEMA, manifest).map((p) => `${dirName}/manifest.json ${p}`);
  if (shape.length > 0) return shape;
  const m = manifest as CapabilityManifest;
  const at = `${m.id}:`;
  const problems: string[] = [];
  if (dirName !== m.id) problems.push(`${at} the directory must be named after the id, not ${JSON.stringify(dirName)}`);
  const inputProblems = checkSchema(m.input, "input");
  const outputProblems = checkSchema(m.output, "output");
  problems.push(...inputProblems.map((p) => `${at} ${p}`), ...outputProblems.map((p) => `${at} ${p}`));

  const ids = new Set<string>();
  for (const impl of m.implementations) {
    if (ids.has(impl.id)) problems.push(`${at} implementation ${impl.id} is declared twice`);
    ids.add(impl.id);
    const raw = impl as unknown as Record<string, unknown>;
    if (impl.kind === "inproc") {
      if (raw.factory === undefined) problems.push(`${at} implementation ${impl.id} (inproc) needs a factory`);
      for (const key of ["tool", "server", "versionCheck", "scope"]) {
        if (raw[key] !== undefined) problems.push(`${at} implementation ${impl.id} (inproc) cannot have ${key}`);
      }
    } else {
      if (raw.tool === undefined || raw.server === undefined) problems.push(`${at} implementation ${impl.id} (mcp) needs a tool and a server`);
      for (const key of ["factory", "settings"]) {
        if (raw[key] !== undefined) problems.push(`${at} implementation ${impl.id} (mcp) cannot have ${key}`);
      }
      if (raw.server !== undefined) problems.push(...checkServer(impl.server).map((p) => `${at} implementation ${impl.id}: ${p}`));
      if (m.input.type !== "object") problems.push(`${at} an MCP implementation needs an object input`);
      if (m.stateful === true && impl.scope === undefined) {
        problems.push(`${at} implementation ${impl.id} (mcp) of a stateful capability needs a scope`);
      }
      if (m.stateful !== true && impl.scope !== undefined) {
        problems.push(`${at} implementation ${impl.id} has a scope, but the capability is not stateful`);
      }
      if (impl.scope !== undefined && Object.hasOwn(m.input.properties ?? {}, impl.scope.argument)) {
        problems.push(`${at} implementation ${impl.id}: the scope argument ${impl.scope.argument} is also a field of the input`);
      }
    }
  }

  if (m.timeoutField !== undefined) {
    const field = m.input.properties?.[m.timeoutField];
    const numeric = field !== undefined && (field.type === "number" || field.type === "integer");
    if (!numeric || field.maximum === undefined || field.minimum === undefined || field.minimum <= 0) {
      problems.push(`${at} timeoutField ${m.timeoutField} must be a number field of the input, with a positive minimum and a maximum`);
    }
  }

  const settles = (m.produces ?? []).filter((s) => s === "proved" || s === "refuted");
  if (settles.length > 0 && m.certificate === undefined) {
    problems.push(`${at} produces ${settles.join(" and ")}, so it must say what certifies it (certificate)`);
  }
  for (const path of m.summary ?? []) problems.push(...checkPath(path).map((p) => `${at} summary: ${p}`));

  if (inputProblems.length === 0 && outputProblems.length === 0) {
    for (const example of m.examples ?? []) {
      problems.push(...validate(m.input, example.input, "input").map((p) => `${at} example "${example.title}": ${p}`));
      if (example.output !== undefined) {
        problems.push(...validate(m.output, example.output, "output").map((p) => `${at} example "${example.title}": ${p}`));
      }
    }
  }

  const contractShape = validate(CONTRACT_SCHEMA, contract).map((p) => `${dirName}/contract.json ${p}`);
  if (contractShape.length > 0) return [...problems, ...contractShape];
  const c = contract as { capability: string; cases: ContractCase[] };
  if (c.capability !== m.id) problems.push(`${at} contract.json is for ${JSON.stringify(c.capability)}`);
  const names = new Set<string>();
  for (const testCase of c.cases) {
    if (names.has(testCase.name)) problems.push(`${at} contract case "${testCase.name}" is declared twice`);
    names.add(testCase.name);
    const where = `${at} contract case "${testCase.name}":`;
    if (inputProblems.length === 0) {
      for (const input of [...(testCase.before ?? []), testCase.input]) {
        problems.push(...validate(m.input, input, "input").map((p) => `${where} ${p}`));
      }
    }
    if (testCase.before !== undefined && m.stateful !== true) problems.push(`${where} before needs a stateful capability`);
    if ((testCase.expect === undefined) === (testCase.fails === undefined)) problems.push(`${where} needs either expect or fails`);
    problems.push(...(testCase.expect ?? []).flatMap((e) => checkExpectation(e)).map((p) => `${where} ${p}`));
    if (testCase.fails?.matches !== undefined) {
      try {
        new RegExp(testCase.fails.matches, "u");
      } catch (error) {
        problems.push(`${where} fails.matches: ${(error as Error).message}`);
      }
    }
  }
  return problems;
}

/** Problems with an MCP server spec (after a host's overrides are applied). */
export function checkServer(server: unknown): string[] {
  const problems = validate(SERVER_SCHEMA, server, "server");
  if (problems.length > 0) return problems;
  const s = server as Record<string, unknown>;
  if (s.transport === "stdio") {
    if (s.command === undefined) problems.push("server: a stdio server needs a command");
    for (const key of ["url", "headers"]) if (s[key] !== undefined) problems.push(`server: a stdio server cannot have ${key}`);
  } else {
    if (s.url === undefined) problems.push("server: an http server needs a url");
    for (const key of ["command", "args", "cwd", "env"]) if (s[key] !== undefined) problems.push(`server: an http server cannot have ${key}`);
  }
  return problems;
}

function checkExpectation(expectation: unknown): string[] {
  if (!isPlainObject(expectation) || typeof expectation.path !== "string") return ["an expectation needs a path"];
  const operators = Object.keys(expectation).filter((k) => k !== "path");
  if (operators.length !== 1 || !(EXPECTATION_OPERATORS as readonly string[]).includes(operators[0] as string)) {
    return [`expectation at ${JSON.stringify(expectation.path)} needs exactly one of ${EXPECTATION_OPERATORS.join(", ")}`];
  }
  const problems = checkPath(expectation.path);
  const operator = operators[0] as (typeof EXPECTATION_OPERATORS)[number];
  const operand = expectation[operator];
  switch (operator) {
    case "matches":
      if (typeof operand !== "string") return [...problems, "matches needs a regular expression"];
      try {
        new RegExp(operand, "u");
      } catch (error) {
        problems.push(`matches: ${(error as Error).message}`);
      }
      return problems;
    case "length":
    case "atLeast":
    case "atMost":
      return typeof operand === "number" ? problems : [...problems, `${operator} needs a number`];
    case "exists":
      return typeof operand === "boolean" ? problems : [...problems, "exists needs true or false"];
    case "some":
    case "every":
      if (!Array.isArray(operand) || operand.length === 0) return [...problems, `${operator} needs a list of expectations`];
      return [...problems, ...operand.flatMap((e) => checkExpectation(e))];
    case "equals":
      return problems;
  }
}
