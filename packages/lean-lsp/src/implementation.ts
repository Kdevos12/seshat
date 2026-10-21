import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { Json } from "@seshat/core";
import {
  defaultMcpTransport,
  type FactoryContext,
  type HealthCheck,
  type ImplementationFactory,
  type ImplementationInstance,
  type InvokeContext,
  type JsonSchema,
  type McpServerSpec,
  messageOf,
  UnavailableError,
  validate,
} from "@seshat/registry";
import { checkColumn, fileLine, firstColumn, type Layout, layoutOf, lineText } from "./layout.ts";
import {
  type AllowedTool,
  DISABLED_TOOLS,
  LEANCLIENT_VERSION,
  type LeanLspInput,
  type LeanLspOutput,
  type Op,
  OPS,
  type Region,
  SITE_NAMES,
  SITE_OF_TOOL,
  type Site,
} from "./protocol.ts";
import { asRecord, attemptsOf, classify, clip, goalList, hitsOf, messagesOf, stripToolPrefix, unwrapDiagnostics } from "./results.ts";
import { RefusedError, screenAttempts, screenQuery, screenRegions, screenTactics } from "./screen.ts";
import { Scratch } from "./scratch.ts";
import { LeanLspServer, ServerFailure } from "./server.ts";

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

/** Messages of Lean shown by `diagnostics`, and results of a search by default and at most. */
const MAX_MESSAGES = 25;
const DEFAULT_LIMIT: Partial<Record<Op, number>> = { loogle: 8, leansearch: 5, state_search: 5, hammer_premise: 16 };
/** The goal sent to Lean Finder: its end, which holds the target. */
const GOAL_QUERY_CHARS = 1500;

export interface LeanLspOptions {
  server: LeanLspServer;
  scratch: Scratch;
  /** The Lean project, as it must not appear in what a prover reads. */
  projectDir: string;
  /** Its real path, when that is another (a link in the path): the server may name the project by it. */
  projectReal?: string;
  /** After a site fails, it is not asked again for this long. */
  cooldownMs: number;
  /** The Mathlib snapshot Lean Finder searches, when the host names one. */
  leanFinderVersion?: string;
  /** Milliseconds; default `Date.now`. */
  now?: () => number;
}

interface Down {
  until: number;
  reason: string;
}

/** Where in the sketch file a call works, before the file is written. */
interface Located {
  layout: Layout;
  region: Region;
  /** The line asked, in the region; and in the file. */
  line: number;
  fileLine: number;
  text: string;
}

/** What a call that reads the sketch file works on: the place, and the file the server reads. */
interface Spot extends Located {
  file: string;
}

type Asked = { value: Json } | { unavailable: string } | { noGoal: string };

/**
 * `lean.lsp` over a lean-lsp-mcp server: eight of its tools behind an allowlist, on one scratch
 * file per scope that the harness writes from the problem's sketch and the prover's regions. The
 * answers are read back in the prover's terms (a region and its line), and what the sites do not
 * answer is a note in the answer, not a failure of the call.
 */
export class LeanLspImplementation implements ImplementationInstance {
  private readonly o: LeanLspOptions;
  private readonly now: () => number;
  private readonly down = new Map<Site, Down>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(options: LeanLspOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  async invoke(input: Json, context: InvokeContext): Promise<Json> {
    const call = input as unknown as LeanLspInput;
    if (!(OPS as readonly string[]).includes(call.op)) throw new Error(`lean.lsp has no operation ${String(call.op)}`);
    const scope = context.scope;
    if (scope === undefined) throw new Error("lean.lsp keeps a file for each scope, so a call needs a scope");
    try {
      // One call at a time per scope: the file holds the regions of the call that is running.
      return (await this.exclusive(scope, () => this.run(call, scope, context))) as unknown as Json;
    } catch (error) {
      // What the server said as it stopped is for the journal, with the project's path left out.
      if (error instanceof UnavailableError) throw new UnavailableError(this.sanitize(error.message));
      throw error;
    }
  }

  async health({ signal }: { signal: AbortSignal }): Promise<HealthCheck> {
    try {
      return { ok: true, detail: `${await this.o.server.health(signal)}; project ${this.o.projectDir}` };
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }

  async release(scope: string): Promise<void> {
    this.o.scratch.remove(scope);
    this.tails.delete(scope);
  }

  async close(): Promise<void> {
    this.o.scratch.removeAll();
    await this.o.server.close();
  }

  private async exclusive<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(scope) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.tails.set(scope, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(scope) === tail) this.tails.delete(scope);
    }
  }

  private async run(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    switch (call.op) {
      case "loogle":
        return this.search(call, "lean_loogle", context);
      case "leansearch":
        return this.search(call, "lean_leansearch", context);
      case "goal":
        return this.goal(call, scope, context);
      case "term_goal":
        return this.termGoal(call, scope, context);
      case "diagnostics":
        return this.diagnostics(call, scope, context);
      case "multi_attempt":
        return this.multiAttempt(call, scope, context);
      case "state_search":
        return this.stateSearch(call, scope, context);
      case "hammer_premise":
        return this.hammer(call, scope, context);
    }
  }

  // --- the operations that read the sketch file ---

  private async goal(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const at = this.place(call, scope, { needsLine: true });
    const raw = asRecord(
      await this.tool(
        "lean_goal",
        { file_path: at.file, line: at.fileLine, ...(call.column !== undefined ? { column: call.column } : {}), ...this.timeout(call) },
        context,
      ),
    );
    const where = this.where(call, at);
    const status = typeof raw?.status === "string" ? raw.status : undefined;
    // The server waits for the elaboration before it looks at the column, so on a time limit it
    // answers `still_elaborating` with no goals, in the line form as in the position form.
    if (status === "still_elaborating") return compact({ op: "goal", status: "still_elaborating", ...where });
    if (call.column === undefined) {
      return compact({ op: "goal", status: "ok", ...where, goalsBefore: goalList(raw?.goals_before), goalsAfter: goalList(raw?.goals_after) });
    }
    return compact({ op: "goal", status: GOAL_STATUS[status ?? "goals"] ?? status ?? "goals", ...where, goals: goalList(raw?.goals) });
  }

  private async termGoal(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const at = this.place(call, scope, { needsLine: true });
    const raw = asRecord(
      await this.tool("lean_term_goal", { file_path: at.file, line: at.fileLine, ...(call.column !== undefined ? { column: call.column } : {}) }, context),
    );
    const expected = typeof raw?.expected_type === "string" && raw.expected_type !== "" ? clip(raw.expected_type, 2000) : undefined;
    return compact({
      op: "term_goal",
      status: expected === undefined ? "no_term_goal" : "ok",
      ...this.where(call, at),
      ...(expected !== undefined ? { expectedType: expected } : {}),
    });
  }

  private async diagnostics(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const at = this.place(call, scope, { needsLine: false });
    const raw = unwrapDiagnostics(
      await this.tool("lean_diagnostic_messages", { file_path: at.file, ...(call.severity !== undefined ? { severity: call.severity } : {}), ...this.timeout(call) }, context),
    );
    const all = messagesOf(raw?.items, at.layout, { code: true, scrub: (text) => this.sanitize(text) }).filter((m) => call.region === undefined || m.region === call.region);
    const failed = Array.isArray(raw?.failed_dependencies) ? raw.failed_dependencies.filter((d): d is string => typeof d === "string") : [];
    const partial = raw?.partial === true || raw?.timed_out === true;
    const shown = all.slice(0, MAX_MESSAGES);
    const notes = [
      ...(partial ? ["Lean was still elaborating when the time limit came, so the list may be incomplete: ask again."] : []),
      ...(failed.length > 0 ? [this.sanitize(`${failed.length} import(s) of the file did not build: ${failed.slice(0, 3).join(", ")}`)] : []),
    ];
    return compact({
      op: "diagnostics",
      status: partial ? "partial" : "ok",
      ...(call.region !== undefined ? { region: call.region } : {}),
      messages: shown,
      errors: all.filter((m) => m.severity === "error").length,
      warnings: all.filter((m) => m.severity === "warning").length,
      ...(all.length > shown.length ? { more: all.length - shown.length } : {}),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    });
  }

  private async multiAttempt(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const given = call.tactics;
    if (given === undefined || given.length === 0) throw new Error("multi_attempt needs tactics, the list of tactics to try");
    // The file has line feeds only, and so do the tactics that the server joins to it.
    const tactics = given.map((tactic) => tactic.replace(/\r\n/g, "\n"));
    const reasons = screenTactics(tactics);
    if (reasons.length > 0) throw new RefusedError(reasons);
    // The server joins a tactic to the start of the line, up to a column (by default the first
    // non-blank character). The harness names the column, so that the text it screens is the text
    // the server joins, whatever the server counts as blank.
    const column = (found: Located) => call.column ?? firstColumn(found.text);
    const at = this.place(call, scope, {
      needsLine: true,
      screen: (found) => screenAttempts(found.layout, found, column(found), tactics),
    });
    const raw = asRecord(
      await this.tool("lean_multi_attempt", { file_path: at.file, line: at.fileLine, snippets: tactics, column: column(at) }, context),
    );
    return compact({ op: "multi_attempt", status: "ok", ...this.where(call, at), attempts: attemptsOf(raw?.items, at.layout, (text) => this.sanitize(text)) });
  }

  private async stateSearch(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const at = this.place(call, scope, { needsLine: true });
    const column = call.column ?? firstColumn(at.text);
    const where = this.where({ ...call, column }, at);
    const raw = asRecord(await this.tool("lean_goal", { file_path: at.file, line: at.fileLine, column, ...this.timeout(call) }, context));
    const status = typeof raw?.status === "string" ? raw.status : "goals";
    const goal = goalList(raw?.goals)[0];
    // The goal is not there yet: nothing to search for, and nothing to say about the position.
    if (status === "still_elaborating") return compact({ op: "state_search", status: "still_elaborating", ...where });
    if (status !== "goals" || goal === undefined) {
      return compact({ op: "state_search", status: GOAL_STATUS[status] ?? status, ...where, note: "There is no goal here to search for." });
    }
    const query = goal.length > GOAL_QUERY_CHARS ? goal.slice(-GOAL_QUERY_CHARS) : goal;
    const asked = await this.ask(
      "lean_leanfinder",
      { query, num_results: call.limit ?? DEFAULT_LIMIT.state_search, ...(this.o.leanFinderVersion !== undefined ? { version: this.o.leanFinderVersion } : {}) },
      context,
    );
    if ("unavailable" in asked) return compact({ op: "state_search", status: "unavailable", ...where, goal: query, unavailable: asked.unavailable });
    if ("noGoal" in asked) throw new Error("Lean Finder answered as if there were no goal");
    return compact({ op: "state_search", status: "ok", ...where, goal: query, results: hitsOf("lean_leanfinder", asRecord(asked.value)?.items) });
  }

  private async hammer(call: LeanLspInput, scope: string, context: InvokeContext): Promise<LeanLspOutput> {
    const at = this.place(call, scope, { needsLine: true });
    const column = call.column ?? firstColumn(at.text);
    const where = this.where({ ...call, column }, at);
    const asked = await this.ask(
      "lean_hammer_premise",
      { file_path: at.file, line: at.fileLine, column, num_results: call.limit ?? DEFAULT_LIMIT.hammer_premise },
      context,
    );
    if ("unavailable" in asked) return compact({ op: "hammer_premise", status: "unavailable", ...where, unavailable: asked.unavailable });
    if ("noGoal" in asked) {
      return compact({ op: "hammer_premise", status: GOAL_STATUS[asked.noGoal] ?? "no_goal_here", ...where, note: "There is no open goal here to find premises for." });
    }
    const items = asRecord(asked.value)?.items;
    const premises = Array.isArray(items) ? items.flatMap((item) => (typeof asRecord(item)?.name === "string" ? [asRecord(item)?.name as string] : [])) : [];
    return compact({ op: "hammer_premise", status: "ok", ...where, premises });
  }

  // --- the operations that only ask a search site ---

  private async search(call: LeanLspInput, tool: "lean_loogle" | "lean_leansearch", context: InvokeContext): Promise<LeanLspOutput> {
    if (call.query === undefined) throw new Error(`${call.op} needs a query`);
    const query = screenQuery(call.query);
    const asked = await this.ask(tool, { query, num_results: call.limit ?? DEFAULT_LIMIT[call.op] }, context);
    if ("unavailable" in asked) return compact({ op: call.op, status: "unavailable", unavailable: asked.unavailable });
    if ("noGoal" in asked) throw new Error(`${call.op} answered as if there were a goal`);
    return compact({ op: call.op, status: "ok", results: hitsOf(tool, asRecord(asked.value)?.items) });
  }

  // --- the server ---

  /** Calls a tool that does not ask a site: its refusal is a failure of the call, in words a prover can read. */
  private async tool(tool: AllowedTool, args: Record<string, unknown>, context: InvokeContext): Promise<Json> {
    try {
      return await this.o.server.call(tool, args, context);
    } catch (error) {
      if (error instanceof ServerFailure) throw new Error(this.sanitize(stripToolPrefix(tool, error.said)));
      throw error;
    }
  }

  /**
   * Calls a tool that asks a network site. A site that cannot be reached, or that refuses the rate,
   * is not a failure: the answer says so and the site is left alone for a while. A refusal of the
   * query itself is a failure of the call.
   */
  private async ask(tool: AllowedTool, args: Record<string, unknown>, context: InvokeContext): Promise<Asked> {
    const site = SITE_OF_TOOL[tool] as Site;
    const down = this.down.get(site);
    if (down !== undefined) {
      const left = Math.ceil((down.until - this.now()) / 1000);
      if (left > 0) return { unavailable: `${SITE_NAMES[site]} is out of reach (${down.reason}); it is not asked again for ${left} more second(s). Go on without it.` };
      this.down.delete(site);
    }
    try {
      const value = await this.o.server.call(tool, args, context);
      return { value };
    } catch (error) {
      if (!(error instanceof ServerFailure)) throw error;
      const failure = classify(tool, error.said);
      switch (failure.kind) {
        case "site": {
          const reason = this.sanitize(failure.reason);
          this.down.set(site, { until: this.now() + this.o.cooldownMs, reason });
          const seconds = Math.ceil(this.o.cooldownMs / 1000);
          return { unavailable: `${SITE_NAMES[site]} cannot be reached (${reason}); it is not asked again for ${seconds} second(s). Go on without it.` };
        }
        case "no_goal":
          return { noGoal: failure.status };
        case "query":
        case "tool":
          throw new Error(this.sanitize(failure.message));
      }
    }
  }

  // --- the sketch file ---

  /**
   * Builds the file from the sketch and the regions, finds the line asked about, lets `screen` refuse
   * the call, and then writes the file: a refused call writes nothing.
   */
  private place(call: LeanLspInput, scope: string, o: { needsLine: boolean; screen?: (found: Located) => string[] }): Spot {
    const sketch = call.sketch;
    if (sketch === undefined) throw new Error(`${call.op} works on the problem's sketch, which the harness gives to the tool of a run; a direct call passes it as sketch`);
    const regions = { aux: call.aux ?? "", proof: call.proof ?? sketch.originalProof };
    const reasons = screenRegions(regions);
    if (reasons.length > 0) throw new RefusedError(reasons);
    const layout = layoutOf(sketch, regions);
    const region = call.region ?? "proof";
    let line = 1;
    let line0 = 0;
    let text = "";
    if (o.needsLine) {
      if (call.line === undefined) throw new Error(`${call.op} needs a line of the ${region.toUpperCase()} region`);
      line = call.line;
      line0 = fileLine(layout, region, line);
      text = lineText(layout, line0);
      if (call.column !== undefined) checkColumn(text, call.column);
    }
    const found: Located = { layout, region, line, fileLine: line0, text };
    const more = o.screen?.(found) ?? [];
    if (more.length > 0) throw new RefusedError(more);
    return { ...found, file: this.o.scratch.write(scope, layout.text) };
  }

  /** The position asked, for the answer. */
  private where(call: LeanLspInput, at: Spot): Pick<LeanLspOutput, "region" | "line" | "column" | "lineText"> {
    return {
      region: at.region,
      line: at.line,
      ...(call.column !== undefined ? { column: call.column } : {}),
      lineText: clip(at.text, 200),
    };
  }

  private timeout(call: LeanLspInput): Record<string, number> {
    return call.timeoutSec !== undefined ? { timeout_s: call.timeoutSec } : {};
  }

  /**
   * The project and the scratch file are not for a prover to read: the project's directory, as it
   * was given and by its real path, becomes `<project>`, and the scratch file `the sketch file`. Other
   * paths in the words of Lean or of the server (the home directory, the toolchain) are not touched.
   */
  private sanitize(text: string): string {
    const { projectDir, projectReal, scratch } = this.o;
    // The longer path first, in case one holds the other.
    const projects = [...new Set([projectDir, projectReal ?? projectDir])].sort((a, b) => b.length - a.length);
    let clean = text;
    for (const project of projects) clean = clean.split(join(project, scratch.relativeDir)).join("<scratch>");
    clean = clean.split(scratch.relativeDir).join("<scratch>");
    for (const project of projects) clean = clean.split(project).join("<project>");
    return clean.replace(/<scratch>\/[A-Za-z0-9_-]+\.lean/g, "the sketch file");
  }
}

/** How the server's goal statuses read in an answer. */
const GOAL_STATUS: Record<string, string> = {
  goals: "goals",
  complete: "complete",
  no_goal_at_position: "no_goal_here",
  still_elaborating: "still_elaborating",
};

/** An output without the fields that have no value. */
function compact(output: LeanLspOutput): LeanLspOutput {
  return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined)) as unknown as LeanLspOutput;
}

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
