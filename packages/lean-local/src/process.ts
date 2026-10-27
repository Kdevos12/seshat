import { spawn } from "node:child_process";

export interface ProcessOptions {
  cwd?: string;
  /** The whole environment of the process: nothing is inherited. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes kept of each output stream, from its start. Default 1 MiB. */
  maxBytes?: number;
}

export interface ProcessResult {
  /** The exit code; null when a signal ended the process. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when this module stopped the process: the time limit passed, or the caller aborted. */
  stopped?: "timeout" | "aborted";
}

/** The process could not be started: the program is not there, or not executable. */
export class SpawnError extends Error {}

/** How long the output pipes may stay open after the process exited, before what holds them is killed. */
const PIPE_GRACE_MS = 500;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Runs a program to its end, in a group of processes of its own, so that a time limit or an abort
 * kills the program and everything it started. The output is kept up to a limit, since the program
 * may be running code of a model.
 */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const keep = (parts: Buffer[]) => {
      let size = parts.reduce((n, p) => n + p.length, 0);
      return (chunk: Buffer) => {
        if (size >= limit) return;
        const room = chunk.subarray(0, limit - size);
        size += room.length;
        parts.push(room);
      };
    };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));

    let stopped: ProcessResult["stopped"];
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const kill = () => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      stopped ??= "timeout";
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      stopped ??= "aborted";
      kill();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...(stopped !== undefined ? { stopped } : {}),
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new SpawnError(error.message));
    });
    // `close` comes once the pipes are shut. A program that left a process holding them open is
    // killed after a short grace, so that the call cannot wait for it.
    child.on("exit", (code, signal) => {
      grace = setTimeout(() => {
        kill();
        finish(code, signal);
      }, PIPE_GRACE_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
