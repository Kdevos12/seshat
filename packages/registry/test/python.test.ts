import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import { CapabilityError, loadCatalog, loadHostProfile, PYODIDE_VERSION, PYTHON_PRELUDE, pythonFactory, Registry, runContract, type HostProfile } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

/** compute.python (plan change CX3) against a stand-in for Pyodide: the child process, its protocol, its limits and its scopes. */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));
const FAKE = fileURLToPath(new URL("./fixtures/pyodide/", import.meta.url));

function registry(settings: Record<string, Json> = {}): Registry {
  const host: HostProfile = { host: "test", capabilities: { "compute.python": { use: ["pyodide"], settings: { pyodide: { pyodideDir: FAKE, ...settings } } } } };
  return new Registry({ catalog, host, factories: { pyodide: pythonFactory() } });
}

async function run(r: Registry, code: string, scope = "attempt-1", timeout?: number): Promise<Record<string, Json>> {
  const result = await r.invoke("compute.python", { code, ...(timeout !== undefined ? { timeout } : {}) }, { scope });
  return result.output as Record<string, Json>;
}

async function failure(r: Registry, code: string, scope = "attempt-1", timeout?: number): Promise<CapabilityError> {
  try {
    await run(r, code, scope, timeout);
  } catch (error) {
    assert.ok(error instanceof CapabilityError, String(error));
    return error;
  }
  assert.fail(`${code} did not fail`);
}

/** The scratch directories the interpreters made under `root` and have not removed. */
const scratches = (root: string): string[] => readdirSync(root).filter((name) => name.startsWith("seshat-python-"));

describe("compute.python without Pyodide", () => {
  it("is unavailable, and health says how to install it", async () => {
    for (const dir of ["", tempDir()]) {
      const r = registry({ pyodideDir: dir });
      try {
        const [entry] = await r.health("compute.python");
        assert.equal(entry?.ok, false);
        assert.match(entry?.detail ?? "", /Pyodide is not installed/);
        assert.match(entry?.detail ?? "", new RegExp(`PYODIDE_DIR.*Pyodide ${PYODIDE_VERSION.replace(/\./g, "\\.")}|Pyodide ${PYODIDE_VERSION.replace(/\./g, "\\.")}.*PYODIDE_DIR`));
        assert.match(entry?.detail ?? "", /documentation\/compute\.md/);
        const error = await failure(r, "1 + 1");
        assert.equal(error.code, "unavailable");
      } finally {
        await r.close();
      }
    }
  });

  it("is offered by the local host profile from PYODIDE_DIR, as an optional tool", () => {
    const local = loadHostProfile(join(REPO, "config", "hosts", "local.json"));
    const binding = local.capabilities["compute.python"];
    assert.deepEqual(binding?.use, ["pyodide"]);
    assert.equal(binding?.optional, true);
    assert.equal(binding?.settings?.pyodide?.pyodideDir, "${env:PYODIDE_DIR:-}");
  });

  it("refuses a Pyodide of another version than the manifest pins", async () => {
    const other = tempDir();
    cpSync(join(FAKE, "pyodide.mjs"), join(other, "pyodide.mjs"));
    writeFileSync(join(other, "fake-version.txt"), "0.1.0");
    const r = registry({ pyodideDir: other });
    try {
      const error = await failure(r, "1 + 1");
      assert.equal(error.code, "unavailable");
      assert.match(error.message, new RegExp(`Pyodide 0\\.1\\.0 is in .*pins ${PYODIDE_VERSION.replace(/\./g, "\\.")}`));
      const loose = registry({ pyodideDir: other, versionCheck: false });
      try {
        assert.equal((await run(loose, "1 + 1")).result, "2");
      } finally {
        await loose.close();
      }
    } finally {
      await r.close();
    }
  });
});

describe("compute.python over the stand-in", () => {
  it("returns the last line's value and what was printed, and a statement has none", async () => {
    const r = registry();
    try {
      assert.deepEqual({ ...(await run(r, "print hello\n2 + 3")), elapsed_ms: 0 }, { result_type: "expression", result: "5", stdout: "hello\n", elapsed_ms: 0 });
      const statement = await run(r, "a = 7");
      assert.equal(statement.result_type, "statement");
      assert.equal(statement.result, null);
      const [entry] = await r.health("compute.python");
      assert.equal(entry?.ok, true, entry?.detail);
    } finally {
      await r.close();
    }
  });

  it("keeps one interpreter per scope: names persist within it, never across, and release ends it", async () => {
    // The scratch directories go under a root of this test's own, so that it sees only its interpreters'.
    const root = tempDir();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const r = registry();
    try {
      await run(r, "squares = 285", "attempt-1");
      assert.equal((await run(r, "squares", "attempt-1")).result, "285");
      const other = await failure(r, "squares", "attempt-2");
      assert.equal(other.code, "failed");
      assert.match(other.message, /NameError: name 'squares' is not defined/);
      await r.release("attempt-1");
      assert.match((await failure(r, "squares", "attempt-1")).message, /NameError/, "a released scope starts empty");
      await r.release("attempt-1");
      await r.release("attempt-2");
      await r.release("never-used");
    } finally {
      await r.close();
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    assert.deepEqual(scratches(root), [], "every scratch directory is removed");
  });

  it("gives Python's error back without the sandbox's own frames", async () => {
    const r = registry();
    try {
      const error = await failure(r, "raise the reason");
      assert.equal(error.details[0], "Traceback (most recent call last):\n  File \"<code>\", line 1, in <module>\nValueError: the reason");
    } finally {
      await r.close();
    }
  });

  it("stops a call at its timeout with its interpreter: the scope's names are gone, other scopes keep theirs", async () => {
    const r = registry();
    try {
      await run(r, "kept = 1", "attempt-1");
      await run(r, "other = 2", "attempt-2");
      const started = Date.now();
      const error = await failure(r, "loop", "attempt-1", 1);
      assert.equal(error.code, "failed", "the tool's own limit fires before the registry's");
      assert.match(error.message, /timed out after 1\.00s.*variables were discarded/);
      assert.ok(Date.now() - started < 10_000);
      assert.match((await failure(r, "kept", "attempt-1")).message, /NameError/);
      assert.equal((await run(r, "other", "attempt-2")).result, "2");
    } finally {
      await r.close();
    }
  });

  it("survives an interpreter that runs out of memory: the call says so and the next one starts afresh", async () => {
    const r = registry({ heapMb: 64 });
    try {
      await run(r, "kept = 1");
      const error = await failure(r, "hog");
      assert.match(error.message, /ran out of memory.*variables were discarded/);
      assert.match((await failure(r, "kept")).message, /NameError/);
      assert.equal((await run(r, "1 + 1")).result, "2");
    } finally {
      await r.close();
    }
  });

  it("caps WebAssembly memory: a growth past memoryMb is a MemoryError, and the session lives on", async () => {
    const r = registry({ memoryMb: 64 });
    try {
      await run(r, "kept = 1");
      assert.match((await failure(r, "grow 100")).message, /MemoryError: WebAssembly memory is limited to 64 MB/);
      assert.equal((await run(r, "grow 10")).result_type, "expression");
      assert.equal((await run(r, "kept")).result, "1");
    } finally {
      await r.close();
    }
  });

  it("runs the code in a process with an empty environment, no JavaScript module, no fetch, and the import guard first", async () => {
    process.env.SESHAT_SECRET_FOR_TEST = "sk-should-not-leak";
    const r = registry();
    try {
      const names = JSON.parse(String((await run(r, "env")).result)) as string[];
      assert.deepEqual(names.filter((n) => n !== "SystemRoot"), []);
      assert.equal((await run(r, "jsglobals")).result, "[]");
      assert.deepEqual(JSON.parse(String((await run(r, "unregistered")).result)), ["js", "pyodide_js"]);
      assert.equal((await run(r, "net")).result, "undefined");
      assert.match((await failure(r, "import js")).message, /the module js is not available in this sandbox/);
      assert.match((await failure(r, "from pyodide.ffi import to_js")).message, /the module pyodide\.ffi is not available/);
    } finally {
      delete process.env.SESHAT_SECRET_FOR_TEST;
      await r.close();
    }
  });

  it("seals the process: JavaScript that Python reaches all the same opens no socket", async () => {
    let connections = 0;
    const server: Server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;
    const settle = (): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const r = registry();
    try {
      // Without the sandbox, the stand-in's first route reaches the server: the case below would succeed.
      const net = ([].constructor.constructor as (body: string) => () => NodeJS.Process)("return process")().getBuiltinModule("node:net") as typeof import("node:net");
      net.connect(port, "127.0.0.1").on("error", () => undefined);
      await settle();
      assert.equal(connections, 1, "the route works outside the sandbox");
      const routes = JSON.parse(String((await run(r, `escape ${port}`)).result)) as string[];
      await settle();
      assert.equal(connections, 1, "no route reached the server from the sandbox");
      assert.deepEqual(routes, [
        "getBuiltinModule: process.getBuiltinModule is not available in this sandbox",
        "binding: process.binding is not available in this sandbox",
        "_linkedBinding: process._linkedBinding is not available in this sandbox",
        "fetch: globalThis.fetch is not a function",
      ]);
      assert.equal((await run(r, "1 + 1")).result, "2", "the process still answers");
    } finally {
      await r.close();
      server.close();
    }
  });

  it("ends an interpreter busy in a loop when the process that started it dies", async () => {
    const root = tempDir();
    const script = [
      `import { loadCatalog, pythonFactory, Registry } from ${JSON.stringify(join(REPO, "packages/registry/src/index.ts"))};`,
      `const catalog = loadCatalog(${JSON.stringify(join(REPO, "capabilities"))});`,
      `const host = { host: "test", capabilities: { "compute.python": { use: ["pyodide"], settings: { pyodide: { pyodideDir: ${JSON.stringify(FAKE)} } } } } };`,
      "const r = new Registry({ catalog, host, factories: { pyodide: pythonFactory() } });",
      'const pid = (await r.invoke("compute.python", { code: "pid" }, { scope: "s" })).output.result;',
      'process.stdout.write(pid + "\\n");',
      'r.invoke("compute.python", { code: "loop", timeout: 300 }, { scope: "s", timeoutMs: 600000 }).catch(() => {});',
    ].join("\n");
    const parent = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: root }, stdio: ["ignore", "pipe", "inherit"] });
    const pid = await new Promise<number>((resolvePid, rejectPid) => {
      let out = "";
      parent.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("\n")) resolvePid(Number(out.trim()));
      });
      parent.once("exit", (code) => rejectPid(new Error(`the parent exited with ${code}`)));
    });
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A zombie has ended; only its entry is left for a parent to reap.
      try {
        return !/^\d+ \(.*\) Z/u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return true;
      }
    };
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert.ok(alive(), "the interpreter is running its loop");
    parent.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (alive() && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const left = alive();
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "the orphaned interpreter ended itself");
  });

  it("lets the process read and write its scratch directory and nothing else of the host", async () => {
    const r = registry();
    const outside = join(tempDir(), "outside.txt");
    writeFileSync(outside, "secret");
    try {
      await run(r, "write notes.txt");
      assert.equal((await run(r, "read notes.txt")).result, JSON.stringify("written"));
      assert.match((await failure(r, `read ${outside}`)).message, /ERR_ACCESS_DENIED/);
      assert.match((await failure(r, `write ${join(tempDir(), "x.txt")}`)).message, /ERR_ACCESS_DENIED/);
      assert.match((await failure(r, `read ${join(REPO, "package.json")}`)).message, /ERR_ACCESS_DENIED/, "not even the harness's own files");
    } finally {
      await r.close();
    }
  });

  it("refuses a scope past maxSessions until one is released", async () => {
    const r = registry({ maxSessions: 1 });
    try {
      await run(r, "a = 1", "attempt-1");
      assert.match((await failure(r, "1 + 1", "attempt-2")).message, /1 Python sessions are open/);
      await r.release("attempt-1");
      assert.equal((await run(r, "1 + 1", "attempt-2")).result, "2");
    } finally {
      await r.close();
    }
  });

  it("refuses settings of the wrong type", async () => {
    const r = registry({ memoryMb: "a lot" });
    try {
      const [entry] = await r.health("compute.python");
      assert.equal(entry?.ok, false);
      assert.match(entry?.detail ?? "", /memoryMb must be a number/);
    } finally {
      await r.close();
    }
  });
});

/** The prelude is plain Python: where the machine has a python3, it runs there, with a `js` module planted first. */
const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe("the prelude every interpreter runs first", () => {
  it("removes and refuses the JavaScript modules, and runs a call's code in its own namespace", { skip: python3 ? false : "no python3 on this host" }, () => {
    const driver = [
      "import sys, types",
      'sys.modules["js"] = types.ModuleType("js")',
      PYTHON_PRELUDE,
      "import json",
      'print("js" in sys.modules)',
      'print(__seshat_run("a = 2**64", 100))',
      'print(__seshat_run("print(7)\\na + 1", 100))',
      'for code in ["import js", "from pyodide.ffi import to_js", "import importlib\\nimportlib.import_module(\\"pyodide_js\\")", "__seshat_run"]:',
      "    try:",
      "        __seshat_run(code, 100)",
      '        print("not refused: " + code)',
      "    except Exception as error:",
      "        print(type(error).__name__ + ': ' + str(error))",
    ].join("\n");
    const run = spawnSync("python3", ["-I", "-c", driver], { encoding: "utf8", env: {} });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines[0], "False", "a js module loaded before the prelude is removed");
    const statement = JSON.parse(lines[1] as string) as { result_type: string; result: unknown };
    assert.deepEqual([statement.result_type, statement.result], ["statement", null]);
    assert.equal(lines[2], "7");
    assert.equal((JSON.parse(lines[3] as string) as { result: string }).result, "18446744073709551617");
    assert.deepEqual(lines.slice(4), [
      "ImportError: the module js is not available in this sandbox: it would reach JavaScript",
      "ImportError: the module pyodide.ffi is not available in this sandbox: it would reach JavaScript",
      "ImportError: the module pyodide_js is not available in this sandbox: it would reach JavaScript",
      "NameError: name '__seshat_run' is not defined",
    ]);
  });

  it("refuses every module of Pyodide's to the call's code, and scrubs the names other modules hold, but not Pyodide's own late imports", { skip: python3 ? false : "no python3 on this host" }, () => {
    // Pyodide's modules, as files: `_pyodide_core` (a built-in module in Pyodide) holds the FFI, which `pyodide.ffi` and `pyodide._core` re-export.
    const root = tempDir();
    const files: Record<string, string> = {
      "_pyodide_core.py": "def to_js(x):\n    return x\ndef create_proxy(x):\n    return x\n",
      "pyodide/__init__.py": "",
      "pyodide/ffi/__init__.py": "from _pyodide_core import to_js, create_proxy\n",
      "pyodide/_core.py": "from _pyodide_core import *\n",
      "pyodide/code.py": "def late():\n    from pyodide.ffi import to_js\n    return to_js.__name__\n",
      "_pyodide/__init__.py": "",
      "_pyodide/_base.py": "x = 1\n",
      // A library that imported an FFI function before the guard.
      "helper.py": "from pyodide.ffi import to_js\nimport pyodide\nkept = 1\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const driver = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      "import pyodide.code, helper",
      // What Pyodide's JavaScript side holds (the module that runs the code, the package loader): not in a module's names.
      "held = [pyodide.code]",
      PYTHON_PRELUDE,
      'print(sorted(n for n in sys.modules if n.split(".")[0] in ("pyodide", "_pyodide", "_pyodide_core", "js", "pyodide_js")))',
      'print(hasattr(helper, "to_js"), hasattr(helper, "pyodide"), helper.kept)',
      "print(held[0].late())",
      'print(json.loads(__seshat_run("import sys\\n\\"pyodide.ffi\\" in sys.modules", 100))["result"])',
      "codes = [",
      '    "import _pyodide_core",',
      '    "from pyodide._core import to_js",',
      '    "from pyodide.ffi import create_proxy",',
      '    "import pyodide",',
      '    "from pyodide import code",',
      '    "import importlib\\nimportlib.import_module(\\"_pyodide._base\\")",',
      '    "exec(\\"import _pyodide_core\\", {})",',
      '    "import json\\njson.dumps(1)",',
      "]",
      "for code in codes:",
      "    try:",
      '        print(json.loads(__seshat_run(code, 100))["result"])',
      "    except Exception as error:",
      "        print(type(error).__name__ + ': ' + str(error))",
    ].join("\n");
    const run = spawnSync("python3", ["-I", "-c", `import json\n${driver}`], { encoding: "utf8", env: {} });
    assert.equal(run.status, 0, run.stderr);
    const refused = (name: string): string => `ImportError: the module ${name} is not available in this sandbox: it would reach JavaScript`;
    assert.deepEqual(run.stdout.trim().split("\n"), [
      "[]",
      "False False 1",
      "to_js",
      "False",
      refused("_pyodide_core"),
      refused("pyodide._core"),
      refused("pyodide.ffi"),
      refused("pyodide"),
      refused("pyodide"),
      refused("_pyodide"),
      refused("_pyodide_core"),
      "'1'",
    ]);
  });
});

/** The contract's own cases need Python: they run where PYODIDE_DIR points at the pinned Pyodide with its packages. */
const real = process.env.PYODIDE_DIR;
const realSkip = real === undefined || real === "" || !existsSync(join(real, "pyodide.mjs")) ? `needs Pyodide ${PYODIDE_VERSION} with its packages at PYODIDE_DIR (documentation/compute.md); not run yet` : false;

describe("the contract of compute.python against the real Pyodide", { skip: realSkip }, () => {
  it("passes every case", async () => {
    const r = registry({ pyodideDir: real as string });
    try {
      const report = await runContract(r, "compute.python");
      assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.failures.join("; ")}`), []);
    } finally {
      await r.close();
    }
  });
});

describe("the contract of compute.python", () => {
  it("has the plan's cases (CX3)", () => {
    const names = catalog.capabilities.get("compute.python")?.contract.map((c) => c.name) ?? [];
    for (const name of ["exact integer arithmetic", "a sympy Gröbner basis", "a python-sat model", "a clarabel SDP", "the call's own time limit", "the memory limit", "import js is refused", "_pyodide_core is refused", "pyodide._core is refused", "no socket from JavaScript", "no network", "no file outside the scratch directory"]) {
      assert.ok(names.includes(name), `the contract has no case ${name}`);
    }
  });

  it("checks the memory cap below Pyodide's own maximum, with a cap of the case's own", () => {
    const memory = catalog.capabilities.get("compute.python")?.contract.find((c) => c.name === "the memory limit");
    assert.deepEqual(memory?.settings, { memoryMb: 256 });
    const mb = Number(/bytearray\((\d+) \* 1024\*\*2\)/u.exec((memory?.input as { code: string }).code)?.[1]);
    assert.ok(mb > 256 && mb < 2048, `${mb} MB lies between the case's cap and Pyodide's maximum`);
  });
});
