import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import { MAX_PROGRAM_LENGTH, sandboxEnvironment } from "@seshat/models";

/** The limits of a run of a program that a model wrote, or that a task declared. */
export interface ProgramLimits {
  /** Time for one call of the program, in milliseconds. Default 500. */
  callMs: number;
  /** Time for the whole run, the start of the process included. Default 30 000. */
  totalMs: number;
  /** The V8 heap of the process (`--max-old-space-size`), in megabytes. Default 128. */
  memoryMb: number;
  /**
   * The resident memory of the whole process, in megabytes, read every 25 ms from `/proc/<pid>/statm` where
   * that exists (Linux); the process is killed above it. It covers what the heap limit does not (the buffers of
   * typed arrays). Default 512. Not enforced where `/proc` is missing, and a program can use more than this
   * between two reads.
   */
  rssMb: number;
  /** The longest JSON text a call may return, in characters. Default 200 000. */
  maxBytes: number;
  /** The seed of the program's `Math.random`. Default 1. */
  seed: number;
}

export const DEFAULT_PROGRAM_LIMITS: ProgramLimits = { callMs: 500, totalMs: 30_000, memoryMb: 128, rssMb: 512, maxBytes: 200_000, seed: 1 };

export interface ValueRun {
  /** One entry for each argument: the program's value, or undefined when it gave none. */
  values: Array<Json | undefined>;
  /** For an argument without a value, why: `timeout`, `no value`, `error: ...`, or why the run stopped. */
  notes: Array<string | undefined>;
  /** Set when the run ended before the last argument: the program did not compile, or the process was killed or died. */
  stopped?: string;
  ms: number;
}

const CHILD = fileURLToPath(new URL("./values-child.ts", import.meta.url));

/** The resident set of a process in megabytes, or undefined where `/proc` cannot say. */
function residentMb(pid: number): number | undefined {
  try {
    const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
    return Number.isFinite(pages) ? (pages * 4096) / (1024 * 1024) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs a JavaScript program on JSON arguments, in a process of its own, and gives its value on each. The
 * program is one function expression, `(n) => n * n` or `function (g) { ... }`, whose value must be JSON.
 *
 * What bounds a program, and what does not (documentation/induction.md, "The sandbox"):
 *
 * - it runs in a `node:vm` context with no global besides the language's, no `eval` or `new Function`, and data
 *   that reaches it as JSON text, so it holds no object of this process; `Math.random` is a seeded generator;
 * - in a Node process started with `--permission`: it reads nothing but its own script, writes no file, starts
 *   no process and no worker; its working directory is a scratch directory made for the run and removed after;
 * - with an empty environment, none of the harness's keys;
 * - with a limit on the V8 heap, on the resident memory of the process (where `/proc` exists), on each call's
 *   time and on the run's total time, which kills the process when it is over.
 *
 * What is not isolated: `node:vm` is not a security boundary, and Node's permission model of the Node version
 * this runs on restricts the file system, processes and workers but not the network, so the program's only
 * barrier against the network is that its context has no API for it. The memory limit is polled, not enforced
 * by the kernel. This guards against the mistakes of a program a model wrote (loops, memory, thrown errors),
 * not against one written to escape.
 */
export async function runValues(source: string, args: readonly Json[], limits: Partial<ProgramLimits> = {}, signal?: AbortSignal): Promise<ValueRun> {
  const { callMs, totalMs, memoryMb, rssMb, maxBytes, seed } = { ...DEFAULT_PROGRAM_LIMITS, ...limits };
  const started = Date.now();
  const values: Array<Json | undefined> = args.map(() => undefined);
  const notes: Array<string | undefined> = args.map(() => undefined);
  const finish = (stopped?: string): ValueRun => {
    if (stopped !== undefined) for (let i = 0; i < notes.length; i++) if (values[i] === undefined && notes[i] === undefined) notes[i] = stopped;
    return { values, notes, ...(stopped !== undefined ? { stopped } : {}), ms: Date.now() - started };
  };
  if (source.trim() === "") return finish("the program is empty");
  if (source.length > MAX_PROGRAM_LENGTH) return finish(`the program has ${source.length} characters; at most ${MAX_PROGRAM_LENGTH}`);
  if (args.length === 0) return finish();
  if (signal?.aborted === true) return finish("the run was cancelled");

  const scratch = mkdtempSync(join(tmpdir(), "seshat-prog-"));
  const child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${CHILD}`, `--max-old-space-size=${memoryMb}`, "--disable-warning=ExperimentalWarning", CHILD],
    { stdio: ["pipe", "pipe", "pipe"], env: sandboxEnvironment(), cwd: scratch },
  );
  let received = 0;
  let buffered = "";
  let compileError: string | undefined;
  let killedFor: string | undefined;
  let stderr = "";
  const take = (line: string): void => {
    if (line.startsWith("x")) {
      compileError = line.slice(1);
      return;
    }
    if (received >= args.length) return;
    const i = received++;
    if (line.startsWith("v")) {
      try {
        values[i] = JSON.parse(line.slice(1)) as Json;
      } catch {
        notes[i] = "unreadable value";
      }
    } else notes[i] = line === "n" ? "no value" : line === "b" ? `value over ${maxBytes} characters` : line === "t" ? `timeout (${callMs} ms)` : line.startsWith("e") ? `error: ${line.slice(1)}` : `unreadable answer ${line.slice(0, 40)}`;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      take(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 2000) stderr += chunk.toString("utf8");
  });
  const kill = (reason: string): void => {
    killedFor ??= reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill(`the run went over its ${totalMs} ms`), totalMs);
  const watcher = setInterval(() => {
    const mb = child.pid === undefined ? undefined : residentMb(child.pid);
    if (mb !== undefined && mb > rssMb) kill(`the process went over ${rssMb} MB of memory`);
  }, 25);
  const onAbort = (): void => kill("the run was cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { failed: string }>((resolve) => {
    child.once("error", (error) => resolve({ failed: error.message }));
    child.once("close", (code, closedBy) => resolve({ code, signal: closedBy }));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${JSON.stringify({ source, args: args.map((a) => JSON.stringify(a)), callMs, maxBytes, seed })}\n`);
  const end = await ended;
  clearTimeout(timer);
  clearInterval(watcher);
  signal?.removeEventListener("abort", onAbort);
  rmSync(scratch, { recursive: true, force: true });
  if (buffered !== "") take(buffered);

  if (compileError !== undefined) return finish(`the program does not compile: ${compileError}`);
  if (received >= args.length) return finish();
  if (killedFor !== undefined) return finish(killedFor);
  if ("failed" in end) return finish(`the process did not start: ${end.failed}`);
  const detail = stderr.includes("heap out of memory") ? "ran out of memory" : stderr.trim().split("\n")[0]?.slice(0, 120);
  return finish(`the process ended after ${received} of ${args.length} calls${end.signal !== null ? ` (${end.signal})` : end.code !== 0 ? ` (exit ${end.code})` : ""}${detail !== undefined && detail !== "" ? `: ${detail}` : ""}`);
}

/** The verdicts of a program that returns a boolean, from a run of it (`null` where it gave none or gave another value). */
export function booleans(run: ValueRun): Array<boolean | null> {
  return run.values.map((v) => (typeof v === "boolean" ? v : null));
}

/** The numbers a program returned, `null` where it gave a value that is not a finite number. */
export function numbers(run: ValueRun): Array<number | null> {
  return run.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}
