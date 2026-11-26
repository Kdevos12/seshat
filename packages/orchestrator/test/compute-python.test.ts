import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type LeanChecker, readEvents } from "@seshat/core";
import { CARD_NOTES_CHARS } from "@seshat/memory";
import { leanCheckImplementation, loadCatalog, pythonFactory, Registry, type HostProfile } from "@seshat/registry";
import { benchAdditions, COMPUTE_TOOLS, computeFallbacks, describeSet, firstCasesCode, firstCasesPlan, hostComputeTool, pinTools, promptHash, REPO_ROOT, resolveAdditions, solve, type SolveOptions } from "../src/index.ts";
import { fakeSage } from "./fixtures/fake-sage.ts";
import { check, DemoLean, fauxModels, ofType, tempDir } from "./m0-helpers.ts";

/** CA17's "host's compute tool" once compute.python exists (plan change CX3): Sage first, Python on Pyodide without it. */
const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const FAKE_PYODIDE = fileURLToPath(new URL("../../registry/test/fixtures/pyodide/", import.meta.url));

/** A host with Sage behind the stand-in server (version `sageVersion`: another than the pinned one makes it unreachable) and Python on the stand-in Pyodide. */
function registryOf(o: { sageVersion: string; pyodideDir?: string; lean?: LeanChecker }): SolveOptions["registry"] & ((...args: never[]) => Registry) {
  const host: HostProfile = {
    host: "test",
    capabilities: {
      "lean.check": { use: ["kimina"] },
      "compute.sage": { use: ["local"] },
      "compute.python": { use: ["pyodide"], settings: { pyodide: { pyodideDir: o.pyodideDir ?? FAKE_PYODIDE } } },
    },
  };
  const sage = fakeSage(o.sageVersion);
  const lean = o.lean ?? new DemoLean();
  return ((journal?: never, blobs?: never) =>
    new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), pyodide: pythonFactory() }, ...(journal !== undefined ? { journal } : {}), ...(blobs !== undefined ? { blobs } : {}), mcpTransport: () => sage.transport() })) as never;
}

describe("the host's compute tool", () => {
  it("is compute.sage where the host offers it, else compute.python", () => {
    assert.deepEqual(COMPUTE_TOOLS, ["compute.sage", "compute.python"]);
    assert.equal(hostComputeTool(() => true), "compute.sage");
    assert.equal(hostComputeTool((id) => id === "compute.python"), "compute.python");
    assert.equal(hostComputeTool(() => false), undefined);
    assert.deepEqual(benchAdditions("v2", (id) => id === "compute.python").autoTool, "compute.python");
    assert.deepEqual(benchAdditions("v2", (id) => id !== "lean.lsp").autoTool, "compute.sage");
    assert.equal(benchAdditions("v2", () => false).autoTool, undefined);
  });

  it("is what solve's --auto-tool adds, with a note only when the host offers no compute tool", () => {
    const python = resolveAdditions({}, "v2", { autoTool: true, leanSearch: false }, "laptop", (id) => id === "compute.python");
    assert.equal(python.computeTool, "compute.python");
    assert.deepEqual(python.notes, []);
    const none = resolveAdditions({}, "v2", { autoTool: true, leanSearch: false }, "laptop", () => false);
    assert.equal(none.computeTool, undefined);
    assert.equal(none.autoTool, false);
    assert.match(none.notes.join("\n"), /host laptop offers no compute tool \(compute\.sage, compute\.python\)/);
    assert.match(describeSet("v2", () => false).join("\n"), /the host's compute tool \(compute\.sage, else compute\.python\).*\(this host offers none\)/);
    assert.doesNotMatch(describeSet("v2", (id) => id === "compute.python").join("\n"), /offers none/);
  });

  it("falls back from Sage to Python when the run pins its tools, and not otherwise", async () => {
    const registry = registryOf({ sageVersion: "0.0.1" })() as Registry;
    try {
      assert.deepEqual(computeFallbacks(registry, "compute.sage"), ["compute.python"]);
      assert.deepEqual(computeFallbacks(registry, "lean.lsp"), []);
      const pinned = await pinTools(registry, ["compute.sage"], [], { "compute.sage": ["compute.python"] });
      assert.deepEqual(pinned.problems, []);
      assert.deepEqual(pinned.tools.map((t) => [t.capability, t.implementation]), [["compute.python", "pyodide"]]);
      assert.match(pinned.notes.join("\n"), /compute\.sage cannot be reached on host test .*compute\.python is used in its place/);
      const without = await pinTools(registry, ["compute.sage"]);
      assert.equal(without.tools.length, 0, "no fallback without being asked");
      assert.equal(without.problems.length, 1);
    } finally {
      await registry.close();
    }
    const sageUp = registryOf({ sageVersion: "0.9.5" })() as Registry;
    try {
      const pinned = await pinTools(sageUp, ["compute.sage"], [], { "compute.sage": ["compute.python"] });
      assert.deepEqual(pinned.tools.map((t) => t.capability), ["compute.sage"], "Sage stays preferred where it answers");
    } finally {
      await sageUp.close();
    }
    const neither = registryOf({ sageVersion: "0.0.1", pyodideDir: "" })() as Registry;
    try {
      const pinned = await pinTools(neither, ["compute.sage"], [], { "compute.sage": ["compute.python"] });
      assert.equal(pinned.tools.length, 0);
      assert.match(pinned.problems.join("\n"), /compute\.sage cannot be reached .*compute\.python\/pyodide: Pyodide is not installed/);
    } finally {
      await neither.close();
    }
  });

  it("is compute.python in a solve on a host where Sage does not answer, and the run records it", async () => {
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("exact trivial_proof")]);
    const lean = new DemoLean();
    const shown: string[] = [];
    const dir = join(tempDir("mh-compute-python-"), "run");
    await solve({
      statement: "(n : ℕ) : n + 0 = n",
      dir,
      models,
      model: name,
      maxUsd: 2,
      user: "alice",
      registry: registryOf({ sageVersion: "0.0.1", lean }),
      checker: lean,
      confirm: async () => true,
      show: (line) => shown.push(line),
      log: (line) => shown.push(line),
      autoTool: "compute.sage",
    });
    const config = ofType(readEvents(join(dir, "journal.jsonl")), "run.started")[0]?.data.config as { autoTool?: { capability: string; implementation: string }; prompt: { hash: string }; notesChars: number };
    assert.deepEqual(config.autoTool, { capability: "compute.python", implementation: "pyodide", version: "314.0.7+child-1" });
    // The prompt's hash names the tool the provers get, the fallback, and not the Sage the run asked for (the v2 defaults of
    // solve: a state card, which caps the notes, and the edit tool).
    const notes = Math.min(config.notesChars, CARD_NOTES_CHARS);
    assert.equal(config.prompt.hash, promptHash(notes, ["compute_python"], undefined, true));
    assert.notEqual(config.prompt.hash, promptHash(notes, ["compute_sage"], undefined, true));
    assert.ok(shown.some((l) => /compute\.python is used in its place/.test(l)), shown.join("\n"));
    assert.ok(shown.some((l) => /filed as number: the provers get compute\.python/.test(l)), shown.join("\n"));
  });
});

describe("the first cases through compute.python", () => {
  const plan = firstCasesPlan("(n : ℕ) : ∑ k ∈ Finset.range (n + 1), (Nat.choose n k * Nat.factorial k) = (∏ i ∈ Finset.range n, (i + 2)) + n");
  it("bring Sage's built-ins from Python's math, and only for compute.python", () => {
    assert.ok(plan !== undefined);
    assert.match(firstCasesCode(plan, 8, "compute.python"), /^from math import comb as binomial, factorial, prod\nimport json\n/);
    assert.match(firstCasesCode(plan, 8, "compute.sage"), /^import json\n/);
    assert.equal(firstCasesCode(plan), firstCasesCode(plan, 8, "compute.sage"));
  });

  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  it("is valid Python that computes the table", { skip: python.status === 0 ? false : "no python3 on this host" }, () => {
    const run = spawnSync("python3", ["-I", "-c", firstCasesCode(plan as never, 4, "compute.python")], { encoding: "utf8", env: {} });
    assert.equal(run.status, 0, run.stderr);
    // n = 0..3: the sum of C(n, k) k! is 1, 2, 5, 16; the product of (i + 2) for i < n, plus n, is 1, 3, 8, 27.
    assert.deepEqual(JSON.parse(run.stdout), [[0, "1", "1"], [1, "2", "3"], [2, "5", "8"], [3, "16", "27"]]);
  });
});
