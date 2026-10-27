import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import type { BatteryObject } from "./objects.ts";

/** The limits of a run of a predicate program. */
export interface PredicateLimits {
  /** Time for one call of the program, in milliseconds. Default 200. */
  callMs: number;
  /** Time for the whole run, the start of the process included. Default 30 000. */
  totalMs: number;
  /**
   * The V8 heap of the process that runs the program (`--max-old-space-size`), in megabytes. Default
   * 128. It is a limit on the heap only: the buffers of typed arrays and of other objects outside it
   * are not limited, and a program can ask for more memory than this.
   */
  memoryMb: number;
}

export const DEFAULT_LIMITS: PredicateLimits = { callMs: 200, totalMs: 30_000, memoryMb: 128 };

/** The longest program accepted, in characters. */
export const MAX_PROGRAM_LENGTH = 20_000;

export interface PredicateRun {
  /** One entry for each argument: the program's verdict, or null when it gave none. */
  verdicts: Array<boolean | null>;
  /** For a null verdict, why: `timeout`, `not a boolean`, `error: ...`, or why the run stopped. */
  notes: Array<string | undefined>;
  /** Set when the run ended before the last argument: the program did not compile, or the process was killed or died. */
  stopped?: string;
  ms: number;
}

const CHILD = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url));

/**
 * The environment of the process that runs a program: none of the harness's. Its environment holds
 * the model providers' keys and the Lean server's, and `node:vm` is not a security boundary, so a
 * program that got out of its context would otherwise read them. The process is started from its
 * absolute path and needs nothing; on Windows Node does not start without `SystemRoot`.
 */
export function sandboxEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.platform === "win32" ? process.env.SystemRoot : undefined;
  return systemRoot !== undefined ? { SystemRoot: systemRoot } : {};
}

/**
 * Runs a JavaScript predicate on JSON arguments, in a process of its own, and gives its verdict on
 * each. The program is one function expression, `(n) => n % 2 === 0` or `function (graph) { ... }`,
 * which must return `true` or `false`.
 *
 * What bounds a program: it runs in a `node:vm` context with no global besides the language's and no
 * `eval` or `new Function`, in a Node process started with `--permission` (it reads nothing but its
 * own script, writes no file, starts no process and no worker), with an empty environment
 * (`sandboxEnvironment`) and a limit on the V8 heap, which is killed when the run goes over its total
 * time. A call that goes over its time, throws, or returns something other than a boolean has no
 * verdict and the next call goes on. A program that fills the heap or loops past the total time ends
 * the run: the verdicts so far are kept and the others have none. The process does not isolate the
 * network, and the limit does not cover memory outside the heap (typed arrays); the context offers
 * no network, and `vm` is not a security boundary. This is not a defense against a program written
 * to escape it, only against the mistakes of a program a model wrote; documentation/trust.md says
 * what runs where.
 */
export async function runPredicate(
  source: string,
  args: readonly Json[],
  limits: Partial<PredicateLimits> = {},
  signal?: AbortSignal,
): Promise<PredicateRun> {
  const { callMs, totalMs, memoryMb } = { ...DEFAULT_LIMITS, ...limits };
  const started = Date.now();
  const verdicts: Array<boolean | null> = args.map(() => null);
  const notes: Array<string | undefined> = args.map(() => undefined);
  const finish = (stopped?: string): PredicateRun => {
    if (stopped !== undefined) for (let i = 0; i < notes.length; i++) if (verdicts[i] === null && notes[i] === undefined) notes[i] = stopped;
    return { verdicts, notes, ...(stopped !== undefined ? { stopped } : {}), ms: Date.now() - started };
  };
  if (source.trim() === "") return finish("the program is empty");
  if (source.length > MAX_PROGRAM_LENGTH) return finish(`the program has ${source.length} characters; at most ${MAX_PROGRAM_LENGTH}`);
  if (args.length === 0) return finish();
  if (signal?.aborted === true) return finish("the run was cancelled");

  const child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${CHILD}`, `--max-old-space-size=${memoryMb}`, "--disable-warning=ExperimentalWarning", CHILD],
    { stdio: ["pipe", "pipe", "pipe"], env: sandboxEnvironment() },
  );
  let received = 0;
  let buffered = "";
  let compileError: string | undefined;
  let killedFor: string | undefined;
  let stderr = "";

  const take = (line: string) => {
    if (line.startsWith("x")) {
      compileError = line.slice(1);
      return;
    }
    if (received >= args.length) return;
    const i = received++;
    if (line === "1" || line === "0") verdicts[i] = line === "1";
    else notes[i] = line === "n" ? "not a boolean" : line === "t" ? `timeout (${callMs} ms)` : line.startsWith("e") ? `error: ${line.slice(1)}` : `unreadable answer ${line.slice(0, 40)}`;
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
  const kill = (reason: string) => {
    killedFor ??= reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill(`the run went over its ${totalMs} ms`), totalMs);
  const onAbort = () => kill("the run was cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });

  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { failed: string }>((resolve) => {
    child.once("error", (error) => resolve({ failed: error.message }));
    child.once("close", (code, closedBy) => resolve({ code, signal: closedBy }));
  });
  // The process may end before it reads its input: that is reported by `ended`, not by the pipe.
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${JSON.stringify({ source, args: args.map((a) => JSON.stringify(a)), callMs })}\n`);
  const end = await ended;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (buffered !== "") take(buffered);

  if (compileError !== undefined) return finish(`the program does not compile: ${compileError}`);
  if (received >= args.length) return finish();
  if (killedFor !== undefined) return finish(killedFor);
  if ("failed" in end) return finish(`the process did not start: ${end.failed}`);
  const detail = stderr.includes("heap out of memory") ? "ran out of memory" : stderr.trim().split("\n")[0]?.slice(0, 120);
  return finish(`the process ended after ${received} of ${args.length} calls${end.signal !== null ? ` (${end.signal})` : end.code !== 0 ? ` (exit ${end.code})` : ""}${detail !== undefined && detail !== "" ? `: ${detail}` : ""}`);
}

/** What a predicate program receives for an object: a number, `{size, table}` for a magma, `{n, edges}` for a graph. */
export function programArgument(object: BatteryObject): Json {
  switch (object.kind) {
    case "integer":
      return object.value;
    case "magma":
      return { size: object.size, table: [...object.table] };
    case "graph":
      return { n: object.n, edges: object.edges };
  }
}

/** The verdicts of a predicate program on the objects of a battery, in order. */
export function runProgram(source: string, objects: readonly BatteryObject[], limits?: Partial<PredicateLimits>, signal?: AbortSignal): Promise<PredicateRun> {
  return runPredicate(source, objects.map(programArgument), limits, signal);
}
