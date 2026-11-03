import type { CommandRunner } from "@seshat/lean-env";
import { type AgentSettings, sandboxProblem } from "./agent.ts";

/** The variables a build command may read from the harness's environment: where the programs are, and the locale. Nothing else. */
const PARENT_KEYS = ["PATH", "LANG", "LC_ALL", "ELAN_HOME", "ELAN_TOOLCHAIN"] as const;

export interface GateRunnerOptions {
  settings: Pick<AgentSettings, "agent" | "sandbox" | "unsandboxed">;
  /** A directory of its own, empty, that is the commands' `HOME` and `TMPDIR`. */
  home: string;
  /** The environment `PATH` and the other allowed variables are read from. Default: the process's. */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** What a build needs besides those, named by the person who configures it (`MATHLIB_CACHE_DIR`, a proxy): exactly these, no others. */
  env?: Readonly<Record<string, string>>;
  /** The time limit of a git command, in seconds. Default 300. */
  gitTimeoutSec?: number;
}

/** The environment of a command of the gate: the allowlisted variables, a home of its own, and what the plan names. */
export function gateEnvironment(o: GateRunnerOptions, program: "git" | "build"): Record<string, string> {
  const parent = o.parentEnv ?? process.env;
  const env: Record<string, string> = { HOME: o.home, TMPDIR: o.home };
  for (const key of PARENT_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  // `lake` finds its toolchains through elan, which looks in the real home when ELAN_HOME is unset.
  if (program === "build" && env.ELAN_HOME === undefined && parent.HOME !== undefined) env.ELAN_HOME = `${parent.HOME}/.elan`;
  if (program === "git") Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" });
  else for (const [key, value] of Object.entries(o.env ?? {})) env[key] = value;
  return env;
}

/**
 * The runner of the gate's commands (review C3, I6). `git` runs with the allowlisted environment and a time limit, outside the sandbox:
 * it reads only the project the harness owns. Every other program (`lake build`, the plan's `prepare` commands) compiles and runs
 * the agent's code, so it runs with the allowlisted environment, in a process group that is killed at the limit, behind the
 * same sandbox command as the agent, or it does not run: with neither a sandbox nor an explicit `unsandboxed: true` the result is a
 * command that did not run. Network isolation is the sandbox's: Seshat itself cuts no network (documentation/library-builder.md).
 */
export function gateRunner(base: CommandRunner, o: GateRunnerOptions): CommandRunner {
  const refusal = sandboxProblem(o.settings);
  return async (command, args, options) => {
    if (command === "git") {
      const limit = AbortSignal.timeout((o.gitTimeoutSec ?? 300) * 1000);
      const signal = options.signal !== undefined ? AbortSignal.any([options.signal, limit]) : limit;
      return await base(command, args, { ...options, signal, env: gateEnvironment(o, "git"), group: true });
    }
    if (refusal !== undefined) return { code: null, output: `refused: ${refusal}` };
    const wrapped = (o.settings.sandbox?.length ?? 0) > 0 ? [...(o.settings.sandbox as readonly string[]), command, ...args] : [command, ...args];
    const [program, ...rest] = wrapped as [string, ...string[]];
    return await base(program, rest, { ...options, env: gateEnvironment(o, "build"), group: true });
  };
}
