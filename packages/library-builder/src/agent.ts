import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { AcpRecord } from "./acp.ts";
import { type AcpMcpServer, TOOL_KINDS as TOOL_KIND_NAMES } from "./acp-protocol.ts";
import type { BuildBudget, LibrarySpec } from "./spec.ts";
import { allowedPrefix } from "./spec.ts";

/** The coding agents the settings name. The harness runs them as external programs; it does not link to any of them. */
export const AGENTS = ["claude-code", "codex", "opencode", "agy", "pi", "gemini", "hermes", "goose"] as const;
export type AgentName = (typeof AGENTS)[number];

/**
 * How Seshat talks to the agent (plan change EA2): `cli` runs one non-interactive command with the prompt on standard input;
 * `acp` runs the agent's Agent Client Protocol command and speaks JSON-RPC to it over its standard input and output.
 */
export const TRANSPORTS = ["cli", "acp"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/**
 * The default command of each agent: the program and its flags for one non-interactive run with the prompt on standard input
 * (plan change LC4). A token with a `{placeholder}` that has no value is dropped, and so is a flag just before it, so a
 * run with no model or no dollar cap passes neither. `claude-code` and `codex` were checked against their published
 * documentation on 2026-11-25 (EA1): in print mode Claude Code denies every permission prompt unless a mode says otherwise, so
 * the agent could not write its files without `--permission-mode acceptEdits`, and `codex exec` runs in a read-only sandbox
 * unless `--sandbox workspace-write` is given. The others are as the plan named them; `harness doctor --agents` checks each
 * against the installed release (documentation/library-builder.md, "Not run").
 */
export const DEFAULT_COMMANDS: Readonly<Partial<Record<AgentName, readonly string[]>>> = {
  "claude-code": ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--model", "{model}", "--max-budget-usd", "{budget_usd}"],
  codex: ["codex", "exec", "--sandbox", "workspace-write", "--model", "{model}"],
  opencode: ["opencode", "run", "--model", "{model}"],
  agy: ["agy", "--output-format", "stream-json", "--model", "{model}"],
  pi: ["pi", "-p", "--model", "{model}"],
};

/**
 * The default ACP command of each agent (plan change EA2): the agent itself where it speaks ACP, an adapter where it does not
 * (`claude-agent-acp`, `codex-acp`, `pi-acp`), as the plan names them. An agent with no entry needs `command`. None has been run;
 * `harness doctor --agents` sends each installed one `initialize` and nothing else.
 */
export const DEFAULT_ACP_COMMANDS: Readonly<Partial<Record<AgentName, readonly string[]>>> = {
  "claude-code": ["claude-agent-acp"],
  codex: ["codex-acp"],
  opencode: ["opencode", "acp"],
  pi: ["pi-acp"],
  gemini: ["gemini", "--experimental-acp"],
  hermes: ["hermes", "acp"],
  goose: ["goose", "acp"],
};

/** The settings of the ACP transport. All optional. */
export interface AcpSettings {
  /**
   * The MCP servers the agent is asked to connect to (`session/new`), stdio only; `{clone}` in a value is the clone's directory.
   * `harness library build` gives the `lean-lsp-mcp` command that `lean.lsp` wraps, pointed at the clone, when this is absent; `[]` gives none.
   */
  mcpServers?: readonly AcpMcpServer[];
  /**
   * The tool kinds whose permission requests are denied (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`,
   * `fetch`, `switch_mode`, `other`). Default `["fetch"]`: the network is the sandbox's to allow, and a fetch is denied here as
   * Claude Code's print mode denies it on the CLI transport. Every other kind is allowed inside the clone; a request that names a
   * path outside the clone is denied whatever its kind.
   */
  deny?: readonly string[];
  /** How long the agent has to answer `session/cancel` before its process group is killed, in seconds. Default 5. */
  cancelGraceSec?: number;
}

export interface AgentSettings {
  agent: AgentName;
  /** `cli` (default) or `acp` (plan change EA2). */
  transport?: Transport;
  /** The ACP transport's settings; read only with `transport: "acp"`. */
  acp?: AcpSettings;
  /**
   * Overrides the default command of the transport: the argv, or a string split on whitespace. Placeholders: `{model}`,
   * `{budget_usd}`, `{budget_seconds}`.
   */
  command?: string | readonly string[];
  /** Passed to the agent as the value of `{model}`, exactly as configured. */
  model?: string;
  /**
   * The environment variables the agent gets, and no others: not the harness's own keys, not its `HOME`. The agent's own
   * credentials are named here by the person who configures it.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * A command that wraps the agent (`["bwrap", "--ro-bind", "/", "/", ...]`): the program and its arguments are appended to
   * it. Required unless `unsandboxed` is true, the rule of the certifier (documentation/certifier.md#where-untrusted-code-runs).
   */
  sandbox?: readonly string[];
  unsandboxed?: boolean;
}

/** The refusal to run an agent the settings do not sandbox, or undefined. */
export function sandboxProblem(settings: AgentSettings): string | undefined {
  if (!AGENTS.includes(settings.agent)) return `unknown agent ${String(settings.agent)}`;
  if ((settings.sandbox?.length ?? 0) === 0 && settings.unsandboxed !== true) {
    return "the coding agent writes and runs code, so it needs a sandbox command (settings.sandbox) or an explicit unsandboxed: true";
  }
  return undefined;
}

/** The command template of the settings: their own, or the default of the agent for the transport; undefined when there is none. */
export function commandTemplate(settings: AgentSettings): string | readonly string[] | undefined {
  if (settings.command !== undefined) return settings.command;
  return (settings.transport ?? "cli") === "acp" ? DEFAULT_ACP_COMMANDS[settings.agent] : DEFAULT_COMMANDS[settings.agent];
}

/** The refusal to make a builder from these settings (the sandbox rule, the transport, a command to run), or undefined. */
export function settingsProblem(settings: AgentSettings): string | undefined {
  const sandbox = sandboxProblem(settings);
  if (sandbox !== undefined) return sandbox;
  const transport = settings.transport ?? "cli";
  if (!TRANSPORTS.includes(transport)) return `unknown transport ${String(transport)} (cli or acp)`;
  const template = commandTemplate(settings);
  if (template === undefined || (typeof template === "string" ? template.trim() === "" : template.length === 0)) {
    return `${settings.agent} has no default ${transport} command: set command`;
  }
  const deny = settings.acp?.deny ?? [];
  const unknown = deny.filter((k) => !(TOOL_KIND_NAMES as readonly string[]).includes(k));
  if (unknown.length > 0) return `acp.deny names unknown tool kinds: ${unknown.join(", ")}`;
  return undefined;
}

/** The argv for one run, placeholders filled, a token or flag with no value dropped, the sandbox in front. */
export function renderCommand(settings: AgentSettings, budget: BuildBudget, timeoutSec: number): string[] {
  const template = commandTemplate(settings) ?? [];
  const tokens = typeof template === "string" ? template.split(/\s+/).filter((t) => t !== "") : [...template];
  const values: Record<string, string | undefined> = {
    model: settings.model,
    budget_usd: budget.usd === undefined ? undefined : String(budget.usd),
    budget_seconds: String(budget.seconds ?? timeoutSec),
  };
  const out: string[] = [];
  for (const token of tokens) {
    let missing = false;
    const filled = token.replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = values[key];
      if (v === undefined) missing = true;
      return v ?? "";
    });
    if (missing) {
      if (out.length > 0 && (out[out.length - 1] as string).startsWith("-") && !(out[out.length - 1] as string).includes("=")) out.pop();
      continue;
    }
    out.push(filled);
  }
  return [...(settings.sandbox ?? []), ...out];
}

/** What `harness doctor` runs to check an agent as it is installed (plan change EA1): no prompt, no session, no model call. */
export interface AgentProbePlan {
  transport: Transport;
  /** The command a build would run, the sandbox in front, every placeholder given a value so that every flag shows. */
  argv: string[];
  /** The agent's program: the first token after the sandbox. */
  program: string;
  /** Prints the version: the program (or, for a command of the person's, its tokens before the first flag) and `--version`. */
  version: string[];
  /** CLI only: the help of the non-interactive mode (the tokens before the first flag, and `--help`). */
  help?: string[];
  /** CLI only: the flags the command passes, which that help should name. */
  flags: string[];
}

export function probePlan(settings: AgentSettings): AgentProbePlan {
  const transport = settings.transport ?? "cli";
  const sandbox = settings.sandbox ?? [];
  const argv = renderCommand({ ...settings, model: settings.model ?? "MODEL" }, { usd: 1, seconds: 60 }, 60);
  const own = argv.slice(sandbox.length);
  const firstFlag = own.findIndex((t) => t.startsWith("-"));
  const leading = firstFlag < 0 ? own : own.slice(0, firstFlag);
  const program = own[0] ?? "";
  const versionBase = settings.command === undefined ? [program] : leading;
  return {
    transport,
    argv,
    program,
    version: [...sandbox, ...versionBase, "--version"],
    ...(transport === "cli" ? { help: [...sandbox, ...leading, "--help"] } : {}),
    flags: transport === "cli" ? [...new Set(own.filter((t) => t.startsWith("-")).map((t) => t.split("=")[0] as string))] : [],
  };
}

/** The environment of the agent's process: `PATH` and what the settings name. */
export function agentEnvironment(settings: AgentSettings, home: string, parent: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = { HOME: home, TMPDIR: home };
  if (parent.PATH !== undefined) env.PATH = parent.PATH;
  for (const [key, value] of Object.entries(settings.env ?? {})) env[key] = value;
  return env;
}

/** The prompt: the spec's job, the rules the gate will apply, and the tests the agent must prove. It names no secret. */
export function renderPrompt(spec: LibrarySpec): string {
  const prefix = allowedPrefix(spec);
  const lines: string[] = [];
  if (spec.job === "fill") {
    lines.push(`Formalize the following in Lean 4 with Mathlib, in new files under ${prefix} only.`);
  } else if (spec.port !== undefined) {
    lines.push(`Port the Lean package ${spec.port.name} (${spec.port.git} at ${spec.port.rev}) to this project's Lean toolchain and Mathlib, in new files under ${prefix} only. Libraries to build: ${spec.port.libs.join(", ")}.`);
  }
  lines.push(`Reason: ${spec.reason}`, "", "Rules. A program outside your control checks all of them after you stop, and a build that breaks one is thrown away:");
  lines.push(
    `- Add files only under ${prefix}. Do not change or delete any existing file, and do not create links.`,
    "- The project must build with `lake build` from a fresh checkout. No `sorry`, `admit`, `axiom`, `native_decide` or `unsafe`.",
    "- A theorem may use only the axioms propext, Classical.choice and Quot.sound.",
    ...(spec.job === "fill" ? ["- No `elab`, `macro`, `syntax`, `notation` or other command that runs code or changes the syntax, and no `import Lean`."] : []),
    `- Imports allowed: ${spec.imports.join(", ") || "none"} and your own files under ${prefix}.`,
    "- Every definition you write is checked against the test lemmas below, which you must prove with exactly these names and statements.",
  );
  if (spec.items.length > 0) {
    lines.push("", "Items:");
    for (const item of spec.items) lines.push(`- ${item.kind} ${item.expectedName}: ${item.informal}`);
  }
  if (spec.testLemmas.length > 0) {
    lines.push("", "Test lemmas (state and prove each, in the namespace of the file that defines the items):");
    for (const t of spec.testLemmas) lines.push(`theorem ${t.name} ${t.statement}`);
  }
  return `${lines.join("\n")}\n`;
}

export const promptHash = (prompt: string): string => `sha256:${createHash("sha256").update(prompt).digest("hex")}`;

export interface AgentRun {
  /** The exit code; null when the program did not start, was killed or timed out. */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The end of what it printed (over ACP: the agent's messages and its standard error). */
  output: string;
  ms: number;
  /** What an ACP run recorded: the session, the permission answers, the usage the agent reported. Absent on the CLI transport. */
  acp?: AcpRecord;
}

/** Kills a process started with `detached: true` and everything in its group. */
export function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Starts the agent. The tests give a fake; `spawnAgent` is the real one. */
export type AgentRunner = (argv: readonly string[], options: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number; signal?: AbortSignal }) => Promise<AgentRun>;

const TAIL = 8000;

/** Runs the argv with exactly `env`, the prompt on standard input, in a process group that is killed at the time limit or on abort. */
export const spawnAgent: AgentRunner = (argv, { cwd, env, stdin, timeoutMs, signal }) =>
  new Promise<AgentRun>((resolvePromise) => {
    const started = performance.now();
    let tail = "";
    let timedOut = false;
    let aborted = false;
    const [program, ...args] = argv;
    if (program === undefined) {
      resolvePromise({ code: null, timedOut, aborted, output: "no command", ms: 0 });
      return;
    }
    const child = spawn(program, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const killGroup = () => killProcessGroup(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const done = (code: number | null, extra = "") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, timedOut, aborted, output: `${tail}${extra}`.slice(-TAIL), ms: Math.round(performance.now() - started) });
    };
    child.on("error", (error) => done(null, error.message));
    child.on("close", (code) => done(timedOut || aborted ? null : code));
    // A descendant that left the process group keeps the pipes open and `close` never comes: a second after the program exits, or is killed, the pipes are cut.
    child.on("exit", (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done(timedOut || aborted ? null : code);
      }, 1000).unref();
    });
  });
