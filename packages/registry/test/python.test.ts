import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
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
    for (const name of ["exact integer arithmetic", "a sympy Gröbner basis", "a python-sat model", "a clarabel SDP", "the call's own time limit", "the memory limit", "import js is refused", "no network", "no file outside the scratch directory"]) {
      assert.ok(names.includes(name), `the contract has no case ${name}`);
    }
  });
});
