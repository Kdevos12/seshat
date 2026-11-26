import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { codeFor, type ComputeTool, readPolyGoal, routeStatement } from "@seshat/classical";
import type { LeanChecker, LeanSnippet } from "@seshat/core";
import { type HostProfile, leanCheckImplementation, loadCatalog, pythonFactory, Registry } from "@seshat/registry";
import { type CertificatePassReport, certificatePass, certificatesCommand, CertificateBenchError, readCertificateBench, REPO_ROOT } from "../src/index.ts";
import { fakeSage } from "./fixtures/fake-sage.ts";

const BENCH = join(REPO_ROOT, "bench", "cx4-certificates.json");

/** A Lean that accepts every file, and remembers them; `up` false makes its health check fail, as a Kimina server that is not running. */
function acceptingLean(up = true): LeanChecker & { snippets: LeanSnippet[]; health(): Promise<boolean> } {
  const snippets: LeanSnippet[] = [];
  return {
    implementation: "accepting",
    version: "0",
    snippets,
    health: async () => up,
    async check(batch: readonly LeanSnippet[]) {
      snippets.push(...batch);
      return batch.map((s) => ({ id: s.id, status: "valid" as const, messages: [], sorries: [], timeMs: 2 }));
    },
  } as unknown as LeanChecker & { snippets: LeanSnippet[]; health(): Promise<boolean> };
}

describe("the inputs of CX4's real pass", () => {
  it("are 20 inequalities over ℝ and 20 integer equations, each one readable by the stage", () => {
    const bench = readCertificateBench(BENCH);
    assert.equal(bench.problems.filter((p) => p.kind === "inequality").length, 20);
    assert.equal(bench.problems.filter((p) => p.kind === "equation").length, 20);
    for (const p of bench.problems) {
      const goal = readPolyGoal(p.statement);
      assert.ok(typeof goal !== "string", `${p.id}: ${String(goal)}`);
      assert.ok(p.kind === "inequality" ? goal.sort === "ℝ" : goal.sort === "ℤ" || goal.sort === "ℕ", p.id);
    }
    // The router tags every problem E6, the `¬ ∃` form of eq-15 included: the battery would run the stage on each.
    assert.deepEqual(bench.problems.filter((p) => !routeStatement(p.statement).moves.includes("E6")).map((p) => p.id), []);
  });

  it("refuses a bench file that is not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-cx4-"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ benchId: "x", header: "import Mathlib", problems: [{ id: "p", kind: "inequality", statement: ": True", expect: ["magic"] }] }));
    assert.throws(() => readCertificateBench(join(dir, "bad.json")), CertificateBenchError);
    // A header or a statement that fails the screen never reaches Lean.
    const problem = { id: "p", kind: "inequality", statement: "(x : ℝ) : 0 ≤ x ^ 2", expect: ["sos"] };
    writeFileSync(join(dir, "header.json"), JSON.stringify({ benchId: "x", header: "import Mathlib\n#eval IO.println 1", problems: [problem] }));
    assert.throws(() => readCertificateBench(join(dir, "header.json")), /refused before Lean sees it: its header: .*'#'/u);
    writeFileSync(join(dir, "statement.json"), JSON.stringify({ benchId: "x", header: "import Mathlib", problems: [{ ...problem, statement: "(x : ℝ) : 0 ≤ x ^ 2 -- " }] }));
    assert.throws(() => readCertificateBench(join(dir, "statement.json")), /refused before Lean sees it: problem p: .*'--'/u);
    writeFileSync(join(dir, "good.json"), JSON.stringify({ benchId: "x", header: "import Mathlib", problems: [problem] }));
    assert.equal(readCertificateBench(join(dir, "good.json")).problems.length, 1);
  });
});

describe("the pass", () => {
  it("runs every method on every problem, counts what Lean accepted per method, and ends each compute session", async () => {
    const bench = readCertificateBench(BENCH);
    const pick = ["eq-01", "eq-17", "ineq-11"];
    const lean = acceptingLean();
    const sessions: string[] = [];
    let released = 0;
    const compute = (id: string): ComputeTool => {
      sessions.push(id);
      return {
        capability: "compute.python",
        async run(code) {
          // (b): a = b + 1 ⊢ a² = b² + 2b + 1, cofactor a + b + 1; (c): an answer out of shape.
          if (codeFor(code, "compute.python")?.includes("groebner")) return { stdout: `${JSON.stringify({ member: true, cofactors: [[[[1, 0], "1", "1"], [[0, 1], "1", "1"], [[0, 0], "1", "1"]]] })}\n` };
          return { stdout: "no json\n" };
        },
        async release() {
          released++;
        },
      };
    };
    const report = await certificatePass({ ...bench, problems: bench.problems.filter((p) => pick.includes(p.id)) }, { checker: lean, compute });
    // In the bench's order.
    assert.deepEqual(report.rows.map((r) => [r.id, r.accepted]), [["ineq-11", ["bernstein"]], ["eq-01", ["modular"]], ["eq-17", ["polyrith"]]]);
    assert.equal(report.perMethod.modular.accepted, 1);
    assert.equal(report.perMethod.sos.accepted, 0);
    assert.equal(report.closed, 3);
    assert.equal(report.compute, "compute.python");
    assert.deepEqual(sessions, ["ineq-11", "eq-01", "eq-17"]);
    assert.equal(released, 3);
    assert.ok(lean.snippets.some((s) => s.code.includes("linear_combination (a + b + (1 : ℤ)) * h")));
    assert.ok(lean.snippets.every((s) => s.id.startsWith("m10:cert.")));
    assert.match(report.rows[0]?.notes.find((n) => n.method === "sos")?.note ?? "", /expected form/);
  });
});

/**
 * The host of CX4's first real pass: Lean, and compute.sage behind a stand-in that refuses an import as sagemath-mcp does, with
 * compute.python offered and unreachable (no Pyodide). `script` answers Sage's calls.
 */
function passHost(lean: LeanChecker, script: (code: string) => string | Error | undefined): { registry: Registry; sage: ReturnType<typeof fakeSage> } {
  const host: HostProfile = {
    host: "test",
    capabilities: {
      "lean.check": { use: ["kimina"] },
      "compute.sage": { use: ["local"] },
      "compute.python": { use: ["pyodide"], settings: { pyodide: { pyodideDir: "" } } },
    },
  };
  const sage = fakeSage("0.9.5", (code) => (/^\s*(?:import|from)\s/mu.test(code) ? new Error("Import statements are disabled for Sage executions") : script(code)));
  const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
  return { registry: new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), pyodide: pythonFactory() }, mcpTransport: () => sage.transport() }), sage };
}

describe("harness certificates", () => {
  it("stops before the pass, and says so, when Lean does not answer", async () => {
    const lean = acceptingLean(false);
    const { registry, sage } = passHost(lean, () => undefined);
    const lines: string[] = [];
    try {
      const code = await certificatesCommand(registry, BENCH, { log: (l) => lines.push(l) });
      assert.equal(code, 1);
    } finally {
      await registry.close();
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /^Lean does not answer: lean\.check cannot be reached on host test \(kimina: accepting does not answer its health check\)\. Every certificate is checked by Lean, so nothing was run\. Start the Lean server/u);
    assert.deepEqual(lean.snippets, []);
    assert.deepEqual(sage.calls, []);
  });

  it("on Sage without Pyodide: (b) runs Sage's program and Lean accepts its cofactors; (c) is skipped and says it needs compute.python", async () => {
    const lean = acceptingLean();
    // eq-17, a = b + 1 ⊢ a² = b² + 2b + 1: the cofactor a + b + 1, as Sage's program prints it.
    const { registry, sage } = passHost(lean, (code) => (code.includes(".lift(cx_ideal)") ? `${JSON.stringify({ member: true, cofactors: [[[[1, 0], "1", "1"], [[0, 1], "1", "1"], [[0, 0], "1", "1"]]] })}\n` : undefined));
    const out = join(mkdtempSync(join(tmpdir(), "mh-cx4-")), "pass.json");
    const lines: string[] = [];
    try {
      assert.equal(await certificatesCommand(registry, BENCH, { problems: ["eq-17", "ineq-01"], out, log: (l) => lines.push(l) }), 0);
    } finally {
      await registry.close();
    }
    const report = JSON.parse(readFileSync(out, "utf8")) as CertificatePassReport;
    assert.equal(report.compute, "compute.sage");
    assert.deepEqual(report.rows.map((r) => [r.id, r.accepted]), [["ineq-01", []], ["eq-17", ["polyrith"]]]);
    assert.equal(report.rows[0]?.notes.find((n) => n.method === "sos")?.note, "skipped: needs compute.python (clarabel); the host's compute tool here is compute.sage");
    // Sage got one call, (b)'s, with no import; (c)'s program never reached it.
    const evaluated = sage.calls.filter((c) => c.tool === "evaluate_sage").map((c) => String(c.args.code));
    assert.equal(evaluated.length, 1);
    assert.ok(evaluated[0]?.startsWith("cx_data = ") && !/\bimport\b/u.test(evaluated[0]));
    assert.ok(lean.snippets.some((s) => s.code.includes("linear_combination (a + b + (1 : ℤ)) * h")));
    assert.ok(lines.includes("compute tool: compute.sage"));
  });
});
