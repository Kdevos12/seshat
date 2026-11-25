import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import { type FactoryContext, type HealthCheck, type ImplementationFactory, type ImplementationInstance, type InvokeContext, UnavailableError } from "./implementation.ts";

/**
 * `compute.python` on Pyodide (plan change CX3, documentation/compute.md): Python with numpy, scipy, sympy, networkx, mpmath,
 * python-sat, highspy, clarabel and gmpy2, compiled to WebAssembly, in a Node process of its own for each scope. Pyodide is not a
 * dependency of the harness: the host profile points at a local copy (`pyodideDir`, `PYODIDE_DIR` in the `local` profile), and
 * without one the implementation is unavailable and says how to install it.
 */

/** The Pyodide release the manifest pins, whose package set the contract was written for. */
export const PYODIDE_VERSION = "314.0.7";

/** What the implementation says when the host has no Pyodide: the one line `harness health` prints. */
export function pyodideMissing(dir: string): string {
  const where = dir === "" ? "PYODIDE_DIR is not set" : `${dir} has no pyodide.mjs`;
  return `Pyodide is not installed (${where}): unpack the Pyodide ${PYODIDE_VERSION} release with its packages and set PYODIDE_DIR to its directory (documentation/compute.md, "Installing Pyodide")`;
}

export interface PythonSettings {
  /** The directory of the local Pyodide copy: `pyodide.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` and the wheels. */
  pyodideDir: string;
  /** Refuse a Pyodide whose version is not the one the manifest pins. Default true. */
  versionCheck: boolean;
  /** The interpreter's WebAssembly memory, in megabytes: Python's memory, past which an allocation is a `MemoryError`. Default 2048. */
  memoryMb: number;
  /** The V8 heap of the process (`--max-old-space-size`), in megabytes. Default 1024. */
  heapMb: number;
  /** Interpreters open at the same time; a new scope beyond them is refused. Default 8. */
  maxSessions: number;
  /** Seconds a call may run when its input gives no `timeout`. Default 60. */
  timeoutSec: number;
  /** Seconds an interpreter may take to start. Default 60. */
  startSec: number;
  /** Characters of printed output kept per call. Default 20000. */
  maxStdout: number;
}

export const DEFAULT_PYTHON_SETTINGS: Omit<PythonSettings, "pyodideDir"> = {
  versionCheck: true,
  memoryMb: 2048,
  heapMb: 1024,
  maxSessions: 8,
  timeoutSec: 60,
  startSec: 60,
  maxStdout: 20_000,
};

const CHILD = fileURLToPath(new URL("./python-child.ts", import.meta.url));

/** The settings of a factory context, checked: a wrong type is a fault of the host profile, said at once. */
export function pythonSettings(raw: Record<string, Json>): PythonSettings {
  const problems: string[] = [];
  const number = (key: keyof typeof DEFAULT_PYTHON_SETTINGS, min: number): number => {
    const value = raw[key];
    if (value === undefined) return DEFAULT_PYTHON_SETTINGS[key] as number;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) problems.push(`${key} must be a number of at least ${min}`);
    return typeof value === "number" ? value : (DEFAULT_PYTHON_SETTINGS[key] as number);
  };
  const dir = raw.pyodideDir ?? "";
  if (typeof dir !== "string") problems.push("pyodideDir must be a path");
  const versionCheck = raw.versionCheck ?? true;
  if (typeof versionCheck !== "boolean") problems.push("versionCheck must be true or false");
  const settings: PythonSettings = {
    pyodideDir: typeof dir === "string" && dir.trim() !== "" ? resolve(dir.trim()) : "",
    versionCheck: versionCheck !== false,
    memoryMb: number("memoryMb", 64),
    heapMb: number("heapMb", 64),
    maxSessions: number("maxSessions", 1),
    timeoutSec: number("timeoutSec", 1),
    startSec: number("startSec", 1),
    maxStdout: number("maxStdout", 100),
  };
  if (problems.length > 0) throw new Error(`compute.python settings: ${problems.join("; ")}`);
  return settings;
}

type Pending = { resolve: (message: Record<string, Json>) => void; reject: (error: Error) => void };

/** Why an interpreter's process ended, in words, from its exit and what it wrote on standard error. */
function endReason(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  if (/heap out of memory|Reached heap limit|allocation failed/i.test(stderr)) return "it ran out of memory";
  if (signal !== null) return `it was stopped by ${signal}`;
  const line = stderr.trim().split("\n").find((l) => l.trim() !== "");
  return `it exited with code ${code}${line !== undefined ? `: ${line.slice(0, 200)}` : ""}`;
}

/** One interpreter: a child process, its scratch directory, and the calls waiting for an answer. */
class Interpreter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly scratch: string;
  readonly ready: Promise<string>;
  /** Settles once the process has ended and its scratch directory is removed. */
  readonly exited: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private stderr = "";
  private ended: string | undefined;
  private readyAnswer: Pending | undefined;
  private readonly settings: PythonSettings;

  constructor(settings: PythonSettings) {
    this.settings = settings;
    this.scratch = mkdtempSync(join(tmpdir(), "seshat-python-"));
    const dir = settings.pyodideDir;
    this.child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${CHILD}`,
        `--allow-fs-read=${dir}`,
        `--allow-fs-read=${this.scratch}`,
        `--allow-fs-write=${this.scratch}`,
        `--max-old-space-size=${settings.heapMb}`,
        "--disable-warning=ExperimentalWarning",
        CHILD,
      ],
      // An empty environment: none of the harness's keys reaches the process that runs the model's code.
      { stdio: ["pipe", "pipe", "pipe"], env: process.platform === "win32" && process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}, cwd: this.scratch },
    );
    this.ready = new Promise<string>((resolveReady, rejectReady) => {
      this.readyAnswer = { resolve: (m) => resolveReady(typeof m.version === "string" ? m.version : "unknown"), reject: rejectReady };
    });
    this.ready.catch(() => undefined);
    let buffered = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        this.take(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 8000) this.stderr += chunk.toString("utf8");
    });
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise<void>((resolveExit) => {
      this.child.once("error", (error) => {
        this.end(`it did not start: ${error.message}`);
        resolveExit();
      });
      this.child.once("close", (code, signal) => {
        this.end(endReason(code, signal, this.stderr));
        resolveExit();
      });
    });
    this.child.stdin.write(
      `${JSON.stringify({ loader: join(dir, "pyodide.mjs"), indexURL: dir, scratch: this.scratch, wasmMemoryMb: settings.memoryMb, maxStdout: settings.maxStdout })}\n`,
    );
  }

  private take(line: string): void {
    let message: Record<string, Json>;
    try {
      message = JSON.parse(line) as Record<string, Json>;
    } catch {
      return;
    }
    if ("ready" in message) {
      if (message.ready === true) this.readyAnswer?.resolve(message);
      else this.readyAnswer?.reject(new UnavailableError(`Pyodide in ${this.settings.pyodideDir} did not start: ${String(message.error)}`));
      return;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);
    waiting.resolve(message);
  }

  private end(reason: string): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    this.readyAnswer?.reject(new UnavailableError(`Pyodide in ${this.settings.pyodideDir} did not start: ${reason}`));
    for (const waiting of this.pending.values()) waiting.reject(new Error(`the interpreter stopped (${reason}), and this session's variables were discarded`));
    this.pending.clear();
    rmSync(this.scratch, { recursive: true, force: true });
  }

  /** Whether the process has ended; its state is gone then. */
  get dead(): boolean {
    return this.ended !== undefined;
  }

  /** Runs one call; rejects when the process ends first. */
  call(code: string): Promise<Record<string, Json>> {
    if (this.ended !== undefined) return Promise.reject(new Error(`the interpreter stopped (${this.ended}), and this session's variables were discarded`));
    const id = this.next++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.child.stdin.write(`${JSON.stringify({ id, code })}\n`);
    });
  }

  /** Ends the process; its scratch directory is removed when it has exited. */
  kill(): void {
    this.child.kill("SIGKILL");
  }
}

/** Rejects after `ms`, or when `signal` aborts, whichever comes first; settles like `promise` otherwise. */
function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(onTimeout()), ms);
    const onAbort = (): void => rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

/**
 * The interpreters of one registry, one per scope (an attempt, a contract case): what a call defines, the next call of the same
 * scope sees, and `release` ends the scope's interpreter. A call that goes over its time limit, or a process that dies (out of
 * memory), ends the scope's interpreter: the call fails with a message that says the variables were discarded, and the next call
 * of the scope starts a new, empty one.
 */
export class PyodideInterpreters implements ImplementationInstance {
  private readonly sessions = new Map<string, Interpreter>();
  readonly settings: PythonSettings;
  /** The Pyodide version the manifest pins; the interpreter that loads another is refused when `versionCheck` is on. */
  readonly pinned: string | undefined;

  constructor(settings: PythonSettings, pinned: string | undefined) {
    this.settings = settings;
    this.pinned = pinned;
  }

  /** The open interpreters, by scope (tests and `harness health` read it). */
  get open(): number {
    return [...this.sessions.values()].filter((s) => !s.dead).length;
  }

  private async session(scope: string, signal: AbortSignal): Promise<Interpreter> {
    const known = this.sessions.get(scope);
    if (known !== undefined && !known.dead) return known;
    if (known !== undefined) this.sessions.delete(scope);
    if (this.open >= this.settings.maxSessions) {
      throw new Error(`${this.settings.maxSessions} Python sessions are open, the most this host allows (maxSessions); wait for one to end`);
    }
    const started = new Interpreter(this.settings);
    this.sessions.set(scope, started);
    try {
      const version = await within(started.ready, this.settings.startSec * 1000, signal, () => new UnavailableError(`Pyodide did not start within ${this.settings.startSec} s`));
      if (this.settings.versionCheck && this.pinned !== undefined && version !== this.pinned) {
        throw new UnavailableError(`Pyodide ${version} is in ${this.settings.pyodideDir}, and the manifest pins ${this.pinned}: install that release, or set versionCheck to false`);
      }
      return started;
    } catch (error) {
      started.kill();
      this.sessions.delete(scope);
      throw error;
    }
  }

  async invoke(input: Json, context: InvokeContext): Promise<Json> {
    const { code, timeout } = input as { code: string; timeout?: number };
    const scope = context.scope ?? "";
    const seconds = typeof timeout === "number" ? timeout : this.settings.timeoutSec;
    const interpreter = await this.session(scope, context.signal);
    let answer: Record<string, Json>;
    try {
      answer = await within(interpreter.call(code), seconds * 1000, context.signal, () => new Error(`timed out after ${seconds.toFixed(2)}s: the interpreter was stopped, and this session's variables were discarded`));
    } catch (error) {
      // A call that cannot be interrupted is ended with its process; the next call of the scope starts a new interpreter.
      if (!interpreter.dead) interpreter.kill();
      this.sessions.delete(scope);
      throw error;
    }
    if (answer.ok !== true) throw new Error(typeof answer.error === "string" ? answer.error : "the call failed");
    return answer.output as Json;
  }

  async health(context: { signal: AbortSignal }): Promise<HealthCheck> {
    const scope = `health-${process.pid}-${Date.now()}`;
    try {
      const output = (await this.invoke({ code: "1 + 1" }, { signal: context.signal, timeoutMs: this.settings.startSec * 1000, scope })) as { result?: Json };
      if (output.result !== "2") return { ok: false, detail: `1 + 1 gave ${JSON.stringify(output.result)}` };
      return { ok: true, detail: `Pyodide in ${this.settings.pyodideDir}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      await this.release(scope);
    }
  }

  async release(scope: string): Promise<void> {
    const interpreter = this.sessions.get(scope);
    if (interpreter === undefined) return;
    this.sessions.delete(scope);
    interpreter.kill();
    await interpreter.exited;
  }

  async close(): Promise<void> {
    for (const scope of [...this.sessions.keys()]) await this.release(scope);
  }
}

/**
 * The registry factory `pyodide`: `compute.python` over a local Pyodide (settings: `PythonSettings`). With no Pyodide at
 * `pyodideDir` the implementation is unavailable, and the reason says how to install it.
 */
export function pythonFactory(): ImplementationFactory {
  return (context: FactoryContext): ImplementationInstance => {
    const settings = pythonSettings(context.settings);
    if (settings.pyodideDir === "" || !existsSync(join(settings.pyodideDir, "pyodide.mjs"))) throw new UnavailableError(pyodideMissing(settings.pyodideDir));
    return new PyodideInterpreters(settings, context.spec.environment?.pyodide);
  };
}
