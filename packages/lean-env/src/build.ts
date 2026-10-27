import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FILE, type BuildStamp, lookupEnvironment, type LookupOptions, readLock } from "./lock.ts";
import { EnvSpecError } from "./spec.ts";

export interface CommandResult {
  /** The exit code; null when the program was killed or did not start. */
  code: number | null;
  /** The end of what it printed (stdout and stderr together). */
  output: string;
}

/** Runs a program in a directory. A failure to start is a result (`code: null`), not an exception. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal; onLine?: (line: string) => void },
) => Promise<CommandResult>;

const TAIL_CHARS = 6000;

/** The runner that starts the program, streaming each line it prints to `onLine`. */
export const spawnRunner: CommandRunner = (command, args, { cwd, signal, onLine }) =>
  new Promise<CommandResult>((resolvePromise) => {
    let tail = "";
    let pending = "";
    const keep = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-TAIL_CHARS);
      if (onLine === undefined) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };
    const child = spawn(command, [...args], { cwd, ...(signal !== undefined ? { signal } : {}), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => resolvePromise({ code: null, output: `${tail}${error.message}`.slice(-TAIL_CHARS) }));
    child.on("close", (code) => {
      if (pending !== "") onLine?.(pending);
      resolvePromise({ code, output: tail });
    });
  });

/** One command of a build, and how long it took. */
export interface BuildStep {
  /** The package it builds; null for the steps of the project (`lake update`, the Mathlib cache). */
  package: string | null;
  command: string;
  ms: number;
  ok: boolean;
}

export interface BuildReport {
  ok: boolean;
  /** The environment hash that was built. */
  hash: string;
  steps: BuildStep[];
  /** Seconds in each package's `lake build`, in the order built, and the project's own steps under `null`. */
  perPackage: Array<{ package: string | null; ms: number }>;
  /** Why the build stopped, with the end of what the command printed. */
  failure?: string;
}

export interface BuildOptions extends LookupOptions {
  run: CommandRunner;
  /** The `lake` program. Default: `lake`. */
  lake?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Milliseconds, for the timings. Default: `performance.now`. */
  now?: () => number;
}

/**
 * Builds a resolved environment's project: `lake update` when Lake has not resolved it yet, `lake
 * exe cache get` when Mathlib is among its dependencies, then `lake build <package>/<lib>` for each
 * library of each package, the base project first, timing each package. A build that succeeds writes
 * a stamp with the environment hash. Stops at the first command that fails. Written against Lake's
 * command line and run only with a fake `lake` here (documentation/lean-env.md, "Not run").
 */
export async function buildEnvironment(name: string, options: BuildOptions): Promise<BuildReport> {
  const pin = lookupEnvironment(name, options);
  if (pin.status !== "resolved" || pin.hash === null || pin.dir === undefined) {
    throw new EnvSpecError(`the environment ${name} cannot be built: ${pin.detail ?? pin.status ?? "it is not resolved"}`);
  }
  const dir = pin.dir;
  const lock = readLock(dir);
  if (lock === undefined) throw new EnvSpecError(`the environment ${name} has no lock in ${dir}`);
  const lake = options.lake ?? "lake";
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? (() => {});

  const plan: Array<{ package: string | null; args: string[] }> = [];
  if (!existsSync(join(dir, "lake-manifest.json"))) plan.push({ package: null, args: ["update"] });
  if (lock.dependencies.some((d) => d.name.toLowerCase() === "mathlib")) plan.push({ package: null, args: ["exe", "cache", "get"] });
  for (const pkg of lock.packages) {
    for (const lib of pkg.leanLibs) plan.push({ package: pkg.name, args: ["build", `${pkg.name}/${lib}`] });
  }

  const steps: BuildStep[] = [];
  const report = (ok: boolean, failure?: string): BuildReport => {
    const perPackage: BuildReport["perPackage"] = [];
    for (const step of steps) {
      const entry = perPackage.find((p) => p.package === step.package);
      if (entry === undefined) perPackage.push({ package: step.package, ms: step.ms });
      else entry.ms += step.ms;
    }
    return { ok, hash: lock.hash, steps, perPackage, ...(failure !== undefined ? { failure } : {}) };
  };
  for (const { package: owner, args } of plan) {
    const command = `${lake} ${args.join(" ")}`;
    log(`${command}   (in ${dir})`);
    const started = now();
    const result = await options.run(lake, args, { cwd: dir, ...(options.signal !== undefined ? { signal: options.signal } : {}), onLine: (line) => log(`  ${line}`) });
    const ok = result.code === 0;
    steps.push({ package: owner, command, ms: Math.round(now() - started), ok });
    if (!ok) {
      const how = result.code === null ? "did not run" : `exited with ${result.code}`;
      return report(false, `${command} ${how}:\n${result.output.trimEnd()}`);
    }
  }
  const stamp: BuildStamp = {
    hash: lock.hash,
    finishedAt: new Date().toISOString(),
    steps: steps.map((s) => ({ name: s.command, ms: s.ms })),
  };
  const target = join(dir, BUILD_FILE);
  writeFileSync(`${target}.tmp`, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
  return report(true);
}
