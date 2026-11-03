import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  /** The signal that ended the process, when it was killed. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The time limit passed and the process was killed. */
  timedOut: boolean;
  /** The caller's signal aborted and the process was killed. */
  aborted: boolean;
  /** The output went over the cap and was cut. */
  truncated: boolean;
  elapsedMs: number;
}

export interface ProcessSpec {
  command: string;
  args: readonly string[];
  /** Written to the process's standard input, which is then closed. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The most output bytes kept for each stream. Default 1 MiB. */
  maxOutputBytes?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** What a program needs to start, from the harness's environment; the harness's credentials never reach it. */
const PASSED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"];

/** Thrown when the program cannot be started (it is not installed): the capability is then unavailable. */
export class NotInstalled extends Error {}

/**
 * Runs an external program once: input on its standard input, output kept up to a cap, killed when
 * the time limit passes or the caller aborts. It is never run through a shell. Callers read the
 * program's status line and exit code, never the prose of its output.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const cap = spec.maxOutputBytes ?? 1 << 20;
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, spec.env);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      reject(new NotInstalled(error instanceof Error ? error.message : String(error)));
      return;
    }
    // The program leads its own process group, so that a kill reaches what it started too.
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    const keep = (current: string, chunk: Buffer): string => {
      if (current.length >= cap) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > cap) truncated = true;
      return next.slice(0, cap);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = keep(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      reject(error.code === "ENOENT" || error.code === "EACCES" ? new NotInstalled(`${spec.command}: ${error.message}`) : error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, signal, stdout, stderr, timedOut, aborted, truncated, elapsedMs: Date.now() - started });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin ?? "");
  });
}
