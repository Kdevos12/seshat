import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Journal, prepareSketch, PROOF_BEGIN, ProofValidator, renderSketch, type LeanCheckResult, type LeanSnippet } from "@math-harness/core";
import { FakeChecker } from "../../core/test/fake-lean.ts";
import { leanCheckImplementation, loadCatalog, Registry, RegistryLeanChecker, type HealthAwareChecker, type HostProfile } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };

/** A checker that never reaches its server, as KiminaChecker reports it. */
class DownChecker implements HealthAwareChecker {
  readonly implementation = "down";
  readonly version = "0";
  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    return snippets.map((s) => ({ id: s.id, status: "server_error", messages: [], sorries: [], timeMs: 0, error: "request failed: ECONNREFUSED" }));
  }
  async health(): Promise<boolean> {
    return false;
  }
}

describe("lean.check through the registry", () => {
  it("validates a proof, with every Lean call recorded as a tool run of the attempt", async () => {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_lean");
    try {
      const fake = new FakeChecker(() => ({ type: "Prop" }));
      const registry = new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(fake) }, journal });
      const source = readFileSync(new URL("../../core/test/fixtures/erdos-125.lean", import.meta.url), "utf8");
      const sketch = prepareSketch(source, "erdos_125.variants.positive_lower_density");
      const validator = new ProofValidator(new RegistryLeanChecker(registry, { attemptId: "att_1", actor: "validator" }));
      const reference = await validator.reference(sketch, source);
      const submitted = renderSketch(sketch).replace(`${PROOF_BEGIN}\n  sorry\n`, `${PROOF_BEGIN}\n  simp\n`);
      const report = await validator.validate(sketch, submitted, reference);
      assert.equal(report.verdict, "valid", report.reasons.join("; "));
      const runs = journal.projection.toolRuns("att_1");
      assert.deepEqual(runs.map((r) => [r.capability, r.implementation, r.version, r.outcome]), [
        ["lean.check", "kimina", "fb2393de+lean-v4.27.0+fc-bench-v1", "ok"],
        ["lean.check", "kimina", "fb2393de+lean-v4.27.0+fc-bench-v1", "ok"],
      ]);
    } finally {
      journal.close();
    }
  });

  it("reports an unreachable server as server_error results, after trying the next implementation", async () => {
    const registry = new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(new DownChecker()) } });
    const checker = new RegistryLeanChecker(registry);
    const [result] = await checker.check([{ id: "a", code: "example : True := trivial" }]);
    assert.equal(result?.status, "server_error");
    assert.match(result?.error ?? "", /no implementation could be reached \(kimina: request failed: ECONNREFUSED\)/);
    const [health] = await registry.health("lean.check");
    assert.deepEqual([health?.ok, health?.detail], [false, "down does not answer its health check"]);
  });

  it("gives one result per snippet, in order", async () => {
    const shuffled: HealthAwareChecker = {
      implementation: "shuffled",
      version: "0",
      check: async (snippets) => [...snippets].reverse().map((s) => ({ id: s.id, status: "valid", messages: [], sorries: [], timeMs: 1 })),
    };
    const registry = new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(shuffled) } });
    const results = await new RegistryLeanChecker(registry).check([
      { id: "a", code: "x" },
      { id: "b", code: "y" },
    ]);
    assert.deepEqual(results.map((r) => r.id), ["a", "b"]);
  });

  it("refuses a result that breaks the output schema", async () => {
    const sloppy: HealthAwareChecker = {
      implementation: "sloppy",
      version: "0",
      check: async (snippets) => snippets.map((s) => ({ id: s.id, status: "ok" as never, messages: [], sorries: [], timeMs: 1 })),
    };
    const registry = new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(sloppy) } });
    const [result] = await new RegistryLeanChecker(registry).check([{ id: "a", code: "x" }]);
    assert.equal(result?.status, "server_error");
    assert.match(result?.error ?? "", /invalid output: output\.results\[0\]\.status: must be one of/);
  });
});
