/**
 * The process that holds one Python interpreter of `compute.python` (see python.ts): Pyodide, in a Node process that
 * its parent started with `--permission` (it reads only this script, the Pyodide directory and its scratch directory,
 * writes only the scratch directory, starts no process and no worker), an empty environment and a limit on the V8 heap.
 *
 * The protocol is one JSON object a line. The first line on standard input is the setup,
 * `{loader, indexURL, scratch, wasmMemoryMb, maxStdout}`; the process answers `{"ready": true, "version": ...}` once
 * the interpreter is up, or `{"ready": false, "error": ...}` and exits. Each later line is a call, `{id, code}`,
 * answered by `{id, ok: true, output}` (the capability's output) or `{id, ok: false, error}`. Standard output carries
 * nothing else: what Python prints is captured into the call's output, and the console goes to standard error.
 *
 * `loader` is a module that exports `loadPyodide` (Pyodide's `pyodide.mjs`; a test gives a stand-in). Before the
 * first call, the `js`, `pyodide_js`, `pyodide.ffi` and `pyodide.http` modules are removed from `sys.modules` and
 * refused by an import hook, so that Python reaches no JavaScript object; the JavaScript globals that reach the
 * network are deleted; WebAssembly memory cannot grow past `wasmMemoryMb`. This guards against the mistakes of
 * code a model wrote, not against code written to escape (documentation/compute.md, "What isolates it").
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface Setup {
  loader: string;
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

/** The Python run once before any call: the import guard, and the function that runs a call's code. */
const PRELUDE = String.raw`
def __seshat_setup():
    import ast, builtins, importlib.abc, json, sys, time
    blocked = ("js", "pyodide_js", "pyodide.ffi", "pyodide.http")
    def refused(name):
        return any(name == b or name.startswith(b + ".") for b in blocked)
    for name in list(sys.modules):
        if refused(name):
            del sys.modules[name]
    try:
        import pyodide
        for attr in ("ffi", "http"):
            if hasattr(pyodide, attr):
                delattr(pyodide, attr)
    except ImportError:
        pass
    class Refuse(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if refused(name):
                raise ImportError("the module " + name + " is not available in this sandbox: it would reach JavaScript")
            return None
    sys.meta_path.insert(0, Refuse())
    plain_import = builtins.__import__
    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and refused(name):
            raise ImportError("the module " + name + " is not available in this sandbox: it would reach JavaScript")
        return plain_import(name, globals, locals, fromlist, level)
    builtins.__import__ = guarded_import
    user = {"__name__": "__main__", "__builtins__": builtins}
    def run(code, max_stdout):
        tree = ast.parse(code, "<code>", "exec")
        last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        if last is not None:
            tree.body.pop()
        started = time.perf_counter()
        exec(compile(tree, "<code>", "exec"), user)
        value = None
        if last is not None:
            value = eval(compile(ast.Expression(last.value), "<code>", "eval"), user)
        elapsed = (time.perf_counter() - started) * 1000
        return json.dumps({
            "result_type": "expression" if last is not None else "statement",
            "result": None if last is None else repr(value),
            "elapsed_ms": round(elapsed, 3),
        })
    return run
__seshat_run = __seshat_setup()
del __seshat_setup
`;

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
  // Nothing in this process may reach the network once Python runs.
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) delete (globalThis as Record<string, unknown>)[name];
  pyodide.runPython(PRELUDE);
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
  const lines = text.trim().split("\n");
  const at = lines.findIndex((l) => l.includes('File "<code>"'));
  return (at >= 0 ? ["Traceback (most recent call last):", ...lines.slice(at)] : lines).join("\n");
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
