import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ComputeTool, readPolyGoal, routeStatement } from "@seshat/classical";
import type { LeanChecker, LeanSnippet } from "@seshat/core";
import { certificatePass, CertificateBenchError, readCertificateBench, REPO_ROOT } from "../src/index.ts";

const BENCH = join(REPO_ROOT, "bench", "cx4-certificates.json");

/** A Lean that accepts every file, and remembers them. */
function acceptingLean(): LeanChecker & { snippets: LeanSnippet[] } {
  const snippets: LeanSnippet[] = [];
  return {
    implementation: "accepting",
    version: "0",
    snippets,
    async check(batch: readonly LeanSnippet[]) {
      snippets.push(...batch);
      return batch.map((s) => ({ id: s.id, status: "valid" as const, messages: [], sorries: [], timeMs: 2 }));
    },
  } as unknown as LeanChecker & { snippets: LeanSnippet[] };
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
        async run(code: string) {
          // (b): a = b + 1 ⊢ a² = b² + 2b + 1, cofactor a + b + 1; (c): an answer out of shape.
          if (code.includes("groebner")) return { stdout: `${JSON.stringify({ member: true, cofactors: [[[[1, 0], "1", "1"], [[0, 1], "1", "1"], [[0, 0], "1", "1"]]] })}\n` };
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
