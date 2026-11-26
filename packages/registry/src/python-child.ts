/**
 * The process that holds one Python interpreter of `compute.python` (see python.ts): Pyodide, in a Node process that
 * its parent started with `--permission` (it reads only this script, the Pyodide directory and its scratch directory,
 * writes only the scratch directory, starts no process and no worker), an empty environment and a limit on the V8 heap.
 *
 * The protocol is one JSON object a line. The first line on standard input is the setup,
 * `{loader, prelude, indexURL, scratch, wasmMemoryMb, maxStdout}`; the process answers `{"ready": true, "version": ...}` once
 * the interpreter is up, or `{"ready": false, "error": ...}` and exits. Each later line is a call, `{id, code}`,
 * answered by `{id, ok: true, output}` (the capability's output) or `{id, ok: false, error}`. Standard output carries
 * nothing else: what Python prints is captured into the call's output, and the console goes to standard error.
 *
 * `loader` is a module that exports `loadPyodide` (Pyodide's `pyodide.mjs`; a test gives a stand-in). Once Pyodide
 * is loaded and before any Python runs, the process is sealed (`seal`): the Node modules that reach the network or
 * another process cannot be imported any more, `process.getBuiltinModule`, `process.binding` and the other routes to
 * Node's internals throw, and the JavaScript globals that reach the network are deleted, so that JavaScript code that
 * Python reaches all the same reaches no socket. Then the prelude refuses to the call's code every module of Pyodide's
 * and the JavaScript modules (python.ts), and WebAssembly memory cannot grow past `wasmMemoryMb`. While Python runs,
 * the process ends itself when its parent is gone (`orphanWatch`). This guards against the mistakes of code a model
 * wrote, not against code written to escape (documentation/compute.md, "What isolates it").
 */
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface Setup {
  loader: string;
  /** The Python run once before any call (`PYTHON_PRELUDE` of python.ts): the import guard, and `__seshat_run`. */
  prelude: string;
  indexURL: string;
  scratch: string;
  wasmMemoryMb: number;
  maxStdout: number;
}

interface Call {
  id: number;
  code: string;
}

/** The part of Pyodide's API this process uses; a stand-in implements the same. */
interface Pyodide {
  version?: string;
  runPython(code: string): unknown;
  loadPackagesFromImports(code: string, options?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  unregisterJsModule?(name: string): void;
  mountNodeFS?(emscriptenPath: string, hostPath: string): void;
  setStdout?(options: { batched: (text: string) => void }): void;
  setStderr?(options: { batched: (text: string) => void }): void;
  /** Python reads `buffer[0]` every few bytecodes while it runs, and a 2 there is a `KeyboardInterrupt`. */
  setInterruptBuffer?(buffer: { 0: number }): void;
}

type LoadPyodide = (options: Record<string, unknown>) => Promise<Pyodide>;

/** Where the scratch directory appears inside Python, and its working directory. */
const SCRATCH_MOUNT = "/scratch";

// The protocol owns standard output: anything a library logs goes to standard error.
const toStderr = (...parts: unknown[]): void => {
  process.stderr.write(`${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`);
};
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

/** WebAssembly memory may not grow past `mb`: a refused growth is a `MemoryError` in Python, not a dead process. */
function capWasmMemory(mb: number): void {
  const limit = mb * 1024 * 1024;
  // The ES2023 library of the type check has no WebAssembly types: the part used here, by hand.
  interface WasmMemory {
    buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  const memory = (globalThis as unknown as { WebAssembly: { Memory: { prototype: WasmMemory } } }).WebAssembly.Memory;
  const grow = memory.prototype.grow;
  memory.prototype.grow = function (this: WasmMemory, delta: number): number {
    if (this.buffer.byteLength + delta * 65536 > limit) throw new RangeError(`WebAssembly memory is limited to ${mb} MB`);
    return grow.call(this, delta);
  };
}

/** The Node modules that reach the network, another process or the module loader: none is imported once the process is sealed. */
const SEALED_MODULES: readonly string[] = [
  "child_process", "cluster", "dgram", "dns", "dns/promises", "http", "http2", "https", "inspector", "inspector/promises", "module", "net", "tls", "worker_threads",
];

/** The members of `process` that reach Node's internals, a native module or another process: each throws once the process is sealed. */
const SEALED_PROCESS: readonly string[] = ["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "kill", "_kill", "execve"];

/**
 * Seals the process before Python runs: Node 22's permission model does not restrict the network, and JavaScript that
 * Python reaches (through a JavaScript object of Pyodide's, `[].constructor.constructor("return process")()`) could
 * otherwise import `node:net`. The loader refuses `SEALED_MODULES` from now on (`import()` included), the members of
 * `SEALED_PROCESS` throw and cannot be put back, and the globals that reach the network are deleted. What this process
 * itself needs (its standard streams, `process.exit`) is untouched.
 */
function seal(): void {
  const refused = new Set(SEALED_MODULES);
  registerHooks({
    resolve(specifier, context, next) {
      if (refused.has(specifier.replace(/^node:/u, ""))) throw new Error(`the module ${specifier} is not available in this sandbox`);
      return next(specifier, context);
    },
  });
  for (const name of SEALED_PROCESS) {
    if (!(name in process)) continue;
    const refuse = (): never => {
      throw new Error(`process.${name} is not available in this sandbox`);
    };
    Object.defineProperty(process, name, { value: refuse, writable: false, configurable: false, enumerable: false });
  }
  const globals = globalThis as unknown as Record<string | symbol, unknown>;
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) delete globals[name];
  // The dispatcher `fetch` made, if it made one.
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) if (String(symbol.description).startsWith("undici.")) delete globals[symbol];
}

/**
 * The interrupt buffer Pyodide reads while Python runs: every second at most, it checks that the process's parent is
 * still the one that started it, and ends the process when it is not, so that a harness that died leaves no
 * interpreter busy in a Python loop (an idle one ends when its standard input closes). A loop inside a compiled
 * library (numpy, clarabel) reads no buffer until it returns.
 */
function orphanWatch(parent: number, exit: (code: number) => void): { 0: number } {
  let checked = Date.now();
  return {
    get 0(): number {
      const now = Date.now();
      if (now - checked >= 1000) {
        checked = now;
        if (process.ppid !== parent) exit(1);
      }
      return 0;
    },
    set 0(_value: number) {},
  };
}

async function start(setup: Setup): Promise<{ pyodide: Pyodide; printed: { text: string } }> {
  capWasmMemory(setup.wasmMemoryMb);
  const printed = { text: "" };
  const capture = (text: string): void => {
    if (printed.text.length < setup.maxStdout) printed.text += text.endsWith("\n") ? text : `${text}\n`;
  };
  const { loadPyodide } = (await import(pathToFileURL(setup.loader).href)) as { loadPyodide: LoadPyodide };
  const pyodide = await loadPyodide({
    indexURL: setup.indexURL.endsWith("/") ? setup.indexURL : `${setup.indexURL}/`,
    // Packages come from the local copy only: one that is not there is an error, never a download.
    packageCacheDir: setup.indexURL,
    packageBaseUrl: setup.indexURL.endsWith("/") ? setup.indexURL : `${setup.indexURL}/`,
    env: { HOME: SCRATCH_MOUNT },
    // The `js` module Python would see is an empty object, not this process's globals.
    jsglobals: {},
    stdout: capture,
    stderr: capture,
  });
  pyodide.setStdout?.({ batched: capture });
  pyodide.setStderr?.({ batched: capture });
  for (const name of ["js", "pyodide_js"]) {
    try {
      pyodide.unregisterJsModule?.(name);
    } catch {
      // Not registered under this version: nothing to remove.
    }
  }
  pyodide.mountNodeFS?.(SCRATCH_MOUNT, setup.scratch);
  const parent = process.ppid;
  const exit = process.exit.bind(process);
  pyodide.setInterruptBuffer?.(orphanWatch(parent, exit));
  // Nothing in this process may reach the network or another process once Python runs.
  seal();
  pyodide.runPython(setup.prelude);
  pyodide.runPython(`import os\nos.chdir(${JSON.stringify(SCRATCH_MOUNT)})`);
  return { pyodide, printed };
}

const lines = createInterface({ input: process.stdin });
let ready: Promise<{ pyodide: Pyodide; printed: { text: string } }> | undefined;
let setup: Setup | undefined;
// Calls run one at a time, in the order they came.
let queue: Promise<void> = Promise.resolve();

async function answer(call: Call, session: { pyodide: Pyodide; printed: { text: string } }, max: number): Promise<void> {
  session.printed.text = "";
  try {
    // A module the code imports that is in the local package set is loaded first (numpy, sympy, pysat...).
    await session.pyodide.loadPackagesFromImports(call.code, { messageCallback: () => {}, errorCallback: toStderr });
    const meta = JSON.parse(String(session.pyodide.runPython(`__seshat_run(${JSON.stringify(call.code)}, ${max})`))) as Record<string, unknown>;
    const stdout = session.printed.text.length > max ? `${session.printed.text.slice(0, max)}\n[output cut at ${max} characters]\n` : session.printed.text;
    send({ id: call.id, ok: true, output: { result_type: meta.result_type, result: meta.result, stdout, elapsed_ms: meta.elapsed_ms } });
  } catch (error) {
    send({ id: call.id, ok: false, error: pythonError(messageOf(error)) });
  }
}

/** Python's traceback without the frames of this sandbox: the error's last lines, which the model reads. */
function pythonError(text: string): string {
  const rows = text.trim().split("\n");
  const at = rows.findIndex((l) => l.includes('File "<code>"'));
  return (at >= 0 ? ["Traceback (most recent call last):", ...rows.slice(at)] : rows).join("\n");
}

lines.on("line", (line) => {
  if (setup === undefined) {
    setup = JSON.parse(line) as Setup;
    ready = start(setup);
    ready.then(
      (session) => send({ ready: true, version: session.pyodide.version ?? "unknown" }),
      (error: unknown) => {
        send({ ready: false, error: messageOf(error) });
        process.exitCode = 1;
        lines.close();
      },
    );
    return;
  }
  const call = JSON.parse(line) as Call;
  const max = setup.maxStdout;
  queue = queue.then(async () => answer(call, await (ready as Promise<{ pyodide: Pyodide; printed: { text: string } }>), max));
});
lines.on("close", () => {
  void queue.then(() => process.exit(process.exitCode ?? 0));
});
