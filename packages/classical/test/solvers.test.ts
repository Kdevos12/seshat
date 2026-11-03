import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { vampireFactory, z3Factory } from "../src/index.ts";

const root = new URL("../../../", import.meta.url).pathname;

/** A registry whose host runs the given shell scripts as z3 and Vampire. */
function registry(z3: string, vampire: string): Registry {
  const host: HostProfile = {
    host: "test",
    capabilities: {
      "smt.z3": { use: ["process"], settings: { process: { command: "sh", args: ["-c", z3, "z3"] } } },
      "atp.vampire": { use: ["process"], settings: { process: { command: "sh", args: ["-c", vampire, "vampire"] } } },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "mh-solvers-"));
  return new Registry({ catalog: loadCatalog(join(root, "capabilities")), host, factories: { z3: z3Factory(), vampire: vampireFactory() }, journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
}

describe("smt.z3 and atp.vampire as capabilities", () => {
  it("run a process, record a tool run, and read the answer", async () => {
    const r = registry("cat > /dev/null; printf 'unsat\\n(h_1 goal)\\n'", "cat > /dev/null; printf '%% SZS status Theorem for p\\n'; exit 0");
    const smt = await r.invoke("smt.z3", { smtlib: "(check-sat)" }, { actor: "line:M10" });
    assert.equal((smt.output as { status: string }).status, "unsat");
    assert.deepEqual((smt.output as { core: string[] }).core, ["h_1", "goal"]);
    const atp = await r.invoke("atp.vampire", { tptp: "x" }, { actor: "line:M10" });
    assert.equal((atp.output as { result: string }).result, "theorem");
  });

  it("do not trust a status the exit code contradicts", async () => {
    const r = registry("true", "cat > /dev/null; printf '%% SZS status Theorem for p\\n'; exit 1");
    const atp = await r.invoke("atp.vampire", { tptp: "x" });
    assert.equal((atp.output as { result: string }).result, "error");
  });

  it("report a timeout when the program outlives its limit", async () => {
    const r = registry("sleep 30", "true");
    const started = Date.now();
    const smt = await r.invoke("smt.z3", { smtlib: "(check-sat)", timeoutSec: 1 });
    assert.equal((smt.output as { status: string }).status, "timeout");
    assert.ok(Date.now() - started < 10000);
  });

  it("are unavailable where the program is not installed", async () => {
    const host: HostProfile = { host: "test", capabilities: { "smt.z3": { use: ["process"], settings: { process: { command: "/nonexistent/z3" } } } } };
    const dir = mkdtempSync(join(tmpdir(), "mh-solvers-"));
    const r = new Registry({ catalog: loadCatalog(join(root, "capabilities")), host, factories: { z3: z3Factory() }, journal: Journal.open(dir, "run_1") });
    await assert.rejects(r.invoke("smt.z3", { smtlib: "(check-sat)" }), (e: { code?: string }) => e.code === "unavailable");
  });
});
