// A stand-in for Pyodide's `pyodide.mjs`, for the tests of `compute.python` (python.ts and python-child.ts): it exports
// `loadPyodide` with the part of Pyodide's API the child process uses, and runs a tiny language of its own in place of
// Python, so that the protocol, the time and memory limits, the scopes and the sandbox of the process can be tested
// without Pyodide. A line of code is one of:
//
//   NAME = INTEGER        a statement: the session keeps NAME
//   NAME                  an expression: the value of NAME, or a NameError
//   INTEGER + INTEGER     an expression
//   print TEXT            prints TEXT
//   loop                  never returns (the time limit), reading the interrupt buffer as Python does
//   pid                   the process's id
//   escape PORT           reaches `process` from a JavaScript object, as Python could through Pyodide's FFI, and tries
//                         every route to a socket to 127.0.0.1:PORT: the value lists what each route did
//   hog                   fills the JavaScript heap (the memory limit kills the process)
//   grow MB               grows a WebAssembly memory by MB megabytes (the WebAssembly cap refuses it)
//   read PATH / write PATH  reads or writes a file of the host (the permission model)
//   env                   the names of the environment variables, as a list
//   net                   the type of the global fetch
//   jsglobals             the keys of the object Pyodide was given for the `js` module
//   import js             refused, as the import guard of python.ts refuses it
//   raise TEXT            a Python error with TEXT
//
// Several lines run in order; the value is the last line's when it is an expression.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function loadPyodide(options) {
  // As Pyodide's Emscripten file system does while it loads (NODEFS's staticInit): the open flags from Node's bindings.
  const flags = process.binding("constants")["fs"];
  if (typeof flags?.O_APPEND !== "number") throw new Error("process.binding(\"constants\").fs has no O_APPEND");
  const versionFile = join(here, "fake-version.txt");
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "314.0.7";
  let stdout = options.stdout ?? (() => {});
  const names = new Map();
  const unregistered = [];
  let prelude = false;
  let interrupt;
  const fail = (kind, text) => {
    throw new Error(`Traceback (most recent call last):\n  File "/lib/python3.14/site-packages/_pyodide/_base.py", line 1, in eval_code\n  File "<code>", line 1, in <module>\n${kind}: ${text}`);
  };
  const line = (text) => {
    let m;
    if ((m = /^([a-z_]\w*) = (-?\d+)$/.exec(text))) {
      names.set(m[1], m[2]);
      return { statement: true };
    }
    if ((m = /^(-?\d+) \+ (-?\d+)$/.exec(text))) return { value: String(BigInt(m[1]) + BigInt(m[2])) };
    if ((m = /^print (.*)$/.exec(text))) {
      stdout(m[1]);
      return { statement: true };
    }
    if (text === "loop") for (;;) if (interrupt !== undefined && interrupt[0] === 2) fail("KeyboardInterrupt", "");
    if (text === "pid") return { value: String(process.pid) };
    if ((m = /^escape (\d+)$/.exec(text))) {
      const port = Number(m[1]);
      const proc = [].constructor.constructor("return process")();
      const routes = [];
      const attempt = (route, reach) => {
        try {
          reach();
          routes.push(`${route}: reached`);
        } catch (error) {
          routes.push(`${route}: ${error.message}`);
        }
      };
      attempt("getBuiltinModule", () => proc.getBuiltinModule("node:net").connect(port, "127.0.0.1").on("error", () => {}));
      attempt("binding", () => proc.binding("tcp_wrap"));
      attempt("_linkedBinding", () => proc._linkedBinding("tcp_wrap"));
      attempt("fetch", () => globalThis.fetch(`http://127.0.0.1:${port}/`).catch(() => {}));
      // An import is asynchronous: it is started here, and a connection it made shows on the test's server.
      for (const name of ["node:net", "net", "node:http", "node:module", "node:child_process"]) {
        [].constructor.constructor(`return import(${JSON.stringify(name)})`)().then(
          (module) => (module.connect ?? module.get)?.(name.endsWith("http") ? `http://127.0.0.1:${port}/` : port, ...(name.endsWith("http") ? [] : ["127.0.0.1"]))?.on?.("error", () => {}),
          () => {},
        );
      }
      return { value: JSON.stringify(routes) };
    }
    if (text === "hog") {
      const kept = [];
      for (;;) kept.push(new Array(1_000_000).fill(kept.length));
    }
    if ((m = /^grow (\d+)$/.exec(text))) {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
      try {
        memory.grow(Number(m[1]) * 16);
      } catch (error) {
        fail("MemoryError", error.message);
      }
      return { value: String(memory.buffer.byteLength) };
    }
    if ((m = /^read (.+)$/.exec(text))) {
      try {
        return { value: JSON.stringify(readFileSync(m[1], "utf8")) };
      } catch (error) {
        fail("PermissionError", `${error.code}: ${error.message}`);
      }
    }
    if ((m = /^write (.+)$/.exec(text))) {
      try {
        writeFileSync(m[1], "written");
        return { statement: true };
      } catch (error) {
        fail("PermissionError", `${error.code}: ${error.message}`);
      }
    }
    if (text === "env") return { value: JSON.stringify(Object.keys(process.env)) };
    if (text === "net") return { value: typeof globalThis.fetch };
    if (text === "jsglobals") return { value: JSON.stringify(Object.keys(options.jsglobals ?? globalThis)) };
    if (text === "unregistered") return { value: JSON.stringify(unregistered) };
    if (text === "import js" || text === "from pyodide.ffi import to_js") {
      if (prelude) fail("ImportError", `the module ${text.includes("ffi") ? "pyodide.ffi" : "js"} is not available in this sandbox: it would reach JavaScript`);
      return { statement: true };
    }
    if ((m = /^raise (.*)$/.exec(text))) fail("ValueError", m[1]);
    if (/^[a-z_]\w*$/.test(text)) {
      if (!names.has(text)) fail("NameError", `name '${text}' is not defined`);
      return { value: names.get(text) };
    }
    fail("SyntaxError", `the stand-in does not read ${JSON.stringify(text)}`);
  };
  return {
    version,
    runPython(code) {
      if (code.includes("def __seshat_setup():")) {
        prelude = true;
        return undefined;
      }
      if (code.startsWith("import os\nos.chdir(")) return undefined;
      const call = /^__seshat_run\(("(?:[^"\\]|\\.)*"), (\d+)\)$/.exec(code);
      if (call === null) throw new Error(`the stand-in does not run ${JSON.stringify(code.slice(0, 80))}`);
      const source = JSON.parse(call[1]);
      const started = performance.now();
      let last = { statement: true };
      for (const text of source.split("\n")) if (text.trim() !== "") last = line(text.trim());
      return JSON.stringify({
        result_type: last.statement === true ? "statement" : "expression",
        result: last.statement === true ? null : last.value,
        elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000,
      });
    },
    async loadPackagesFromImports() {},
    unregisterJsModule(name) {
      unregistered.push(name);
    },
    mountNodeFS() {},
    setStdout(o) {
      stdout = (text) => o.batched(text);
    },
    setStderr() {},
    setInterruptBuffer(buffer) {
      interrupt = buffer;
    },
  };
}
