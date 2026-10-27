import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { Json } from "@seshat/core";
import {
  defaultMcpTransport,
  type FactoryContext,
  type ImplementationFactory,
  type JsonSchema,
  type McpServerSpec,
  UnavailableError,
  validate,
} from "@seshat/registry";
import { LeanLspImplementation } from "./implementation.ts";
import { DISABLED_TOOLS, LEANCLIENT_VERSION } from "./protocol.ts";
import { Scratch } from "./scratch.ts";
import { LeanLspServer } from "./server.ts";

/** Variables of the server that the harness sets itself, and a host's `env` cannot. */
export const RESERVED_ENV: readonly string[] = [
  "LEAN_MCP_DISABLED_TOOLS",
  "LEAN_PROJECT_PATH",
  "LEAN_REPL",
  "LEAN_REPL_PATH",
  "LEAN_REPL_TIMEOUT",
  "LEAN_REPL_MEM_MB",
  "LEAN_LOOGLE_LOCAL",
  "LEAN_LOOGLE_CACHE_DIR",
  "LEAN_MCP_PREWARM_FILES",
  "LEAN_MCP_INSTRUCTIONS",
  "LEAN_MCP_TOOL_DESCRIPTIONS",
  "LEAN_LSP_MCP_TOKEN",
  "LEAN_LSP_MCP_ACTIVE_TRANSPORT",
  "LEAN_LSP_TEST_MODE",
  "LEAN_LOG_FILE_CONFIG",
];

const SETTINGS: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    projectDir: { type: "string" },
    scratchDir: { type: "string", minLength: 1 },
    env: { type: "object" },
    loogleUrl: { type: "string" },
    leanFinderUrl: { type: "string" },
    hammerUrl: { type: "string" },
    leanFinderVersion: { enum: ["", "v4.19.0", "v4.24.0", "v4.28.0"] },
    maxOpenFiles: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^[0-9]*$" }] },
    siteCooldownSec: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^[0-9]*$" }] },
  },
  required: ["command"],
  additionalProperties: false,
};

interface Settings {
  command: string;
  args?: string[];
  projectDir?: string;
  scratchDir?: string;
  env?: Record<string, Json>;
  loogleUrl?: string;
  leanFinderUrl?: string;
  hammerUrl?: string;
  leanFinderVersion?: string;
  maxOpenFiles?: number | string;
  siteCooldownSec?: number | string;
}

export interface LeanLspFactoryOptions {
  /** Opens the transport to a server process. Default: spawn it over stdio with the harness's cleaned environment. */
  transport?: (server: Extract<McpServerSpec, { transport: "stdio" }>) => McpTransport;
  /** Milliseconds; default `Date.now`. */
  now?: () => number;
}

/** A number from a setting that may come as text (a variable of the host profile). */
function whole(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  return typeof value === "number" ? value : Number(value);
}

/**
 * The arguments that start the server when the host gives none: with `uvx`, the pinned release and
 * the pinned leanclient (the other dependencies float: `mcp` is fixed by the release itself, `orjson`
 * and `certifi` do not change what a tool answers); with any other command (an installed server, a
 * wrapper), none.
 */
export function defaultArgs(command: string, version: string): string[] {
  return basename(command) === "uvx" ? ["--from", `lean-lsp-mcp==${version}`, "--with", `leanclient==${LEANCLIENT_VERSION}`, "lean-lsp-mcp"] : [];
}

/** The environment the server gets: what the harness sets, which a host's own variables cannot change. */
export function serverVariables(s: Settings, projectDir: string): Record<string, string> {
  const own = Object.fromEntries(Object.entries(s.env ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const reserved = Object.keys(own).filter((name) => RESERVED_ENV.includes(name));
  if (reserved.length > 0) throw new Error(`lean-lsp: the host cannot set ${reserved.join(", ")}: the harness sets them (documentation/lean-lsp.md)`);
  const open = whole(s.maxOpenFiles, 0);
  return {
    LEAN_LOG_LEVEL: "WARNING",
    ...own,
    LEAN_PROJECT_PATH: projectDir,
    LEAN_MCP_DISABLED_TOOLS: DISABLED_TOOLS.join(","),
    ...(s.loogleUrl ? { LOOGLE_URL: s.loogleUrl } : {}),
    ...(s.leanFinderUrl ? { LEAN_FINDER_URL: s.leanFinderUrl } : {}),
    ...(s.hammerUrl ? { LEAN_HAMMER_URL: s.hammerUrl } : {}),
    ...(open > 0 ? { LEAN_LSP_MAX_OPEN_FILES: String(open) } : {}),
  };
}

/**
 * The registry factory `lean-lsp`: `lean.lsp` over lean-lsp-mcp. Settings: `command` and `args` (the
 * server: by default `uvx` with the pinned release), `projectDir` (the Lean project, required),
 * `scratchDir` (inside it), `env` (more variables for the server, such as HTTPS_PROXY), `loogleUrl`,
 * `leanFinderUrl`, `hammerUrl` (a self-hosted site instead of the public one), `leanFinderVersion`,
 * `maxOpenFiles` (the server's limit on open files) and `siteCooldownSec`. An empty text is no value.
 */
export function leanLspFactory(options: LeanLspFactoryOptions = {}): ImplementationFactory {
  return ({ spec, settings }: FactoryContext) => {
    const problems = validate(SETTINGS, settings, "settings");
    if (problems.length > 0) throw new Error(`lean-lsp: ${problems.join("; ")}`);
    const s = settings as unknown as Settings;
    if (s.projectDir === undefined || s.projectDir === "") {
      throw new UnavailableError("lean.lsp needs the Lean project it works in: set LEAN_PROJECT_DIR, or the setting projectDir of the host profile");
    }
    const projectDir = resolve(s.projectDir);
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new UnavailableError(`the Lean project ${projectDir} is not a directory`);
    const projectReal = realpathSync(projectDir);
    // The server refuses to start on any other directory.
    const file = (name: string) => existsSync(join(projectDir, name)) && statSync(join(projectDir, name)).isFile();
    if (!file("lean-toolchain") || !(file("lakefile.lean") || file("lakefile.toml"))) {
      throw new UnavailableError(`${projectDir} is not a Lean project (it needs lean-toolchain and a lakefile.lean or lakefile.toml)`);
    }
    const command = s.command;
    const args = s.args ?? defaultArgs(command, spec.version);
    const env = serverVariables(s, projectDir);
    const make = options.transport ?? ((server) => defaultMcpTransport(server));
    const server = new LeanLspServer({
      version: spec.version,
      transport: () => make({ transport: "stdio", command, args, env }),
    });
    return new LeanLspImplementation({
      server,
      scratch: new Scratch(projectDir, s.scratchDir ?? ".seshat-lsp"),
      projectDir,
      ...(projectReal !== projectDir ? { projectReal } : {}),
      cooldownMs: whole(s.siteCooldownSec, 60) * 1000,
      ...(s.leanFinderVersion ? { leanFinderVersion: s.leanFinderVersion } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  };
}
