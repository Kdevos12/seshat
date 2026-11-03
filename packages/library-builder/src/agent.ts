import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { BuildBudget, LibrarySpec } from "./spec.ts";
import { allowedPrefix } from "./spec.ts";

/** The coding agents the settings name. The harness runs them as external programs; it does not link to any of them. */
export const AGENTS = ["claude-code", "codex", "opencode", "agy", "pi"] as const;
export type AgentName = (typeof AGENTS)[number];

/**
 * The default command of each agent: the program and its flags for one non-interactive run with the prompt on standard input
 * (plan change LC4). A token with a `{placeholder}` that has no value is dropped, and so is a flag just before it, so a
 * run with no model or no dollar cap passes neither. These are the flags as the plan names them; check each against the
 * installed release (documentation/library-builder.md, "Not run").
 */
export const DEFAULT_COMMANDS: Readonly<Record<AgentName, readonly string[]>> = {
  "claude-code": ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "{model}", "--max-budget-usd", "{budget_usd}"],
  codex: ["codex", "exec", "--model", "{model}"],
  opencode: ["opencode", "run", "--model", "{model}"],
  agy: ["agy", "--output-format", "stream-json", "--model", "{model}"],
  pi: ["pi", "-p", "--model", "{model}"],
};

export interface AgentSettings {
  agent: AgentName;
  /** Overrides the default command: the argv, or a string split on whitespace. Placeholders: `{model}`, `{budget_usd}`, `{budget_seconds}`. */
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

/** The argv for one run, placeholders filled, a token or flag with no value dropped, the sandbox in front. */
export function renderCommand(settings: AgentSettings, budget: BuildBudget, timeoutSec: number): string[] {
  const template = settings.command ?? DEFAULT_COMMANDS[settings.agent];
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
  /** The end of what it printed. */
  output: string;
  ms: number;
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
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
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
