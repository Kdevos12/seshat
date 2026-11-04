import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Refused, runIsolated, screenSmtLib, screenTptp, toSmtLib, lower, vampireFactory, z3Factory } from "../src/index.ts";

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

describe("a model's script cannot make the solvers touch the host (review I4)", () => {
  it("lets through what the translator writes, with comments and quoted symbols", () => {
    const text = toSmtLib(lower("(M : Type*) [Mul M] (f : M → M) (a b : ℕ) (h : a < b) : ∀ x y : M, f (x * y) = f (y * x)")).text;
    assert.doesNotThrow(() => screenSmtLib(text));
    assert.doesNotThrow(() => screenSmtLib("; a comment (set-option :regular-output-channel \"/x\")\n(set-logic ALL)\n(declare-const |a b| Int)\n(assert (= |a b| 1))\n(check-sat)\n"));
  });

  it("refuses the output channels, trace files, echo, includes and text outside a command", () => {
    for (const bad of [
      '(set-option :regular-output-channel "/tmp/x")',
      '(set-option :diagnostic-output-channel "/tmp/x")',
      '(set-option :trace_file_name "/tmp/x")',
      '(set-option :proof.log "/tmp/x")',
      '(set-logic ALL)\n(echo "unsat")',
      '(include "/etc/passwd")',
      "(read-file x)",
      "(assert true)) (echo x)",
      "(assert true",
      "unsat",
      '(set-logic ALL) (set-option :dump_benchmarks "true")',
    ]) assert.throws(() => screenSmtLib(bad), Refused, bad);
  });

  it("refuses a TPTP include, but not one in a comment", () => {
    assert.throws(() => screenTptp("include('/etc/passwd').\n"), Refused);
    assert.throws(() => screenTptp("tff(a, axiom, $true).\ninclude ( 'x' )."), Refused);
    assert.doesNotThrow(() => screenTptp("% include('x')\n/* include('y') */\ntff(a, axiom, $true).\n"));
  });

  it("refuses an include that a quoted atom hides from a comment strip (final review 3)", () => {
    assert.throws(() => screenTptp("fof(a,axiom,p('/*')).\ninclude('/etc/hostname').\nfof(b,axiom,p('*/'))."), Refused);
    assert.throws(() => screenTptp("fof(a,axiom,p('/*')).\nfof(b,axiom,p('*/'))."), Refused);
    assert.throws(() => screenTptp("/* x */ INCLUDE('f')."), Refused);
    assert.throws(() => screenTptp("fof(a,axiom,p('x')). % 'q\ninclude('f')."), Refused);
  });

  it("answer a refused script with an error and never start the program", async () => {
    const r = registry("echo started > started.txt; printf 'unsat\\n'", "echo started > started.txt; printf '%% SZS status Theorem for p\\n'");
    const smt = await r.invoke("smt.z3", { smtlib: '(set-option :regular-output-channel "/tmp/seshat-x")\n(check-sat)' });
    assert.equal((smt.output as { status: string }).status, "error");
    assert.match((smt.output as { detail: string }).detail, /^refused: the option :regular-output-channel/);
    const atp = await r.invoke("atp.vampire", { tptp: "include('/etc/passwd')." });
    assert.equal((atp.output as { result: string }).result, "error");
    assert.match((atp.output as { detail: string }).detail, /^refused: an include directive/);
  });

  it("run in an empty directory of their own, without the harness's HOME", async () => {
    process.env.SESHAT_TEST_SECRET = "s3cret";
    try {
      const out = await runIsolated({ command: "sh", args: ["-c", 'printf "%s|%s|%s|" "$(ls -A | wc -l)" "$HOME" "${SESHAT_TEST_SECRET:-none}"; pwd'], timeoutMs: 10000 });
      const [files, home, secret, cwd] = out.stdout.trim().split("|");
      assert.equal(files, "0");
      assert.equal(secret, "none");
      assert.equal(home, cwd);
      assert.notEqual(home, process.env.HOME);
      assert.match(cwd as string, /seshat-solver-/);
    } finally {
      delete process.env.SESHAT_TEST_SECRET;
    }
  });

  it("run under a memory limit where prlimit exists", async () => {
    const probe = await runIsolated({ command: "sh", args: ["-c", "ulimit -v"], timeoutMs: 10000, memoryMb: 512 });
    const limit = probe.stdout.trim();
    assert.ok(limit === "unlimited" || Number(limit) === 512 * 1024, `ulimit -v was ${limit}`);
  });
});
