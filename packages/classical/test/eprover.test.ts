import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { spawnSync } from "node:child_process";
import { loadCatalog, Registry, runContract, type HostProfile } from "@seshat/registry";
import { eproverFactory, readEprover } from "../src/index.ts";

const root = new URL("../../../", import.meta.url).pathname;

/** A registry whose host runs the given shell script as `eprover`; `$1` is the first argument E would get. */
function registry(script: string, command = "sh", args: string[] | null = ["-c", script, "eprover"]): Registry {
  const host: HostProfile = { host: "test", capabilities: { "atp.eprover": { use: ["process"], settings: { process: { command, ...(args !== null ? { args } : {}) } } } } };
  const dir = mkdtempSync(join(tmpdir(), "mh-eprover-"));
  return new Registry({ catalog: loadCatalog(join(root, "capabilities")), host, factories: { eprover: eproverFactory() }, journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
}

const PROOF = [
  "# Proof found!",
  "# SZS status Theorem",
  "# SZS output start CNFRefutation",
  "fof(c_0_3, axiom, p(a), file('stdin', p_1)).",
  "fof(c_0_4, negated_conjecture, ~p(a), file('stdin', goal)).",
  "fof(c_0_5, plain, $false, inference(cn,[status(thm)],[c_0_3, c_0_4]), ['proof']).",
  "# SZS output end CNFRefutation",
].join("\n");

/** A script that answers `--version` like E and anything else with `body`. */
const answering = (body: string): string => `if [ "$1" = "--version" ]; then echo 'stand-in-eprover 0.0'; exit 0; fi; cat > /dev/null; ${body}`;

describe("reading E's output", () => {
  it("reads the SZS status after # and the exit code, never the prose", () => {
    const ok = readEprover(PROOF, 0, "");
    assert.equal(ok.result, "theorem");
    assert.deepEqual(ok.used.sort(), ["goal", "p_1"]);
    assert.equal(readEprover(PROOF, 1, "").result, "error", "a proof claim with a failing exit code is not trusted");
    assert.equal(readEprover("# SZS status CounterSatisfiable\n", 0, "").result, "countermodel");
    assert.equal(readEprover("# SZS status ResourceOut\n", 1, "").result, "timeout");
    assert.equal(readEprover("# SZS status GaveUp\n", 1, "").result, "unknown");
    assert.equal(readEprover("# Proof found!\n", 0, "").result, "error", "the prose of the output is no verdict");
    assert.equal(readEprover("", 1, "eprover: bad option").detail, "eprover: bad option");
    assert.equal(readEprover("% SZS status Theorem for p\n", 0, "").result, "error", "the % prefix is Vampire's, not E's");
  });

  it("takes the last status outside proof blocks: a status an input made E echo does not decide", () => {
    const fake = "# SZS status Theorem";
    // a comment of the input, a quoted atom spanning lines, and an echoed formula, each before E's own CounterSatisfiable
    const echoed = [
      `% ${fake}\n# ${fake}\n# SZS status CounterSatisfiable\n`,
      `fof(a, axiom, p('x\n${fake}\ny')).\n${fake}\n# SZS status CounterSatisfiable\n`,
      `# Parsed: fof(h, axiom, 'q').\n${fake}\n# Processing done\n# SZS status GaveUp\n`,
    ];
    assert.equal(readEprover(echoed[0] as string, 0, "").result, "countermodel");
    assert.equal(readEprover(echoed[1] as string, 0, "").result, "countermodel");
    assert.equal(readEprover(echoed[2] as string, 0, "").result, "unknown");
    // a status inside a proof block is part of the proof, not the answer
    const inBlock = `# SZS output start CNFRefutation\n${fake}\n# SZS output end CNFRefutation\n# SZS status GaveUp\n`;
    assert.equal(readEprover(inBlock, 0, "").result, "unknown");
    // a lone status line is the answer, and the exit code is then the only guard
    assert.equal(readEprover(`${fake}\n`, 0, "").result, "theorem", "a lone status line is read: only the exit code guards it");
  });
});

/** A registry whose host runs an executable script as `eprover`, with the factory's own arguments. */
function installed(script: string): Registry {
  const dir = mkdtempSync(join(tmpdir(), "mh-eprover-bin-"));
  const bin = join(dir, "eprover");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return registry("", bin, null);
}

describe("atp.eprover as a capability", () => {
  it("runs the binary, reads the proof and records E's version in the tool run", async () => {
    const r = registry(answering(`printf '%s\\n' '${PROOF.replaceAll("'", "'\\''")}'; exit 0`));
    const run = await r.invoke("atp.eprover", { tptp: "tff(a, axiom, p)." }, { actor: "line:M10" });
    const out = run.output as { result: string; szs: string; used: string[]; version?: string };
    assert.equal(out.result, "theorem");
    assert.equal(out.szs, "Theorem");
    assert.deepEqual(out.used.sort(), ["goal", "p_1"]);
    assert.equal(out.version, "stand-in-eprover 0.0");
  });

  it("builds the command line: --auto, --proof-object, --tstp-format and the limits, the problem on standard input", async () => {
    const r = installed(answering(`echo "$*" >&2; exit 2`));
    const out = (await r.invoke("atp.eprover", { tptp: "tff(a, axiom, p).", timeoutSec: 7 })).output as { result: string; detail?: string };
    assert.equal(out.result, "error");
    assert.equal(out.detail, "--auto --proof-object --tstp-format --cpu-limit=7 --memory-limit=2048");
  });

  it("reports no proof as unknown and a counter-satisfiable problem as a countermodel", async () => {
    const gaveUp = registry(answering(`echo "# SZS status GaveUp"; exit 1`));
    assert.equal(((await gaveUp.invoke("atp.eprover", { tptp: "x" })).output as { result: string }).result, "unknown");
    const sat = registry(answering(`echo "# SZS status CounterSatisfiable"; exit 0`));
    assert.equal(((await sat.invoke("atp.eprover", { tptp: "x" })).output as { result: string }).result, "countermodel");
  });

  it("reports garbage output as an error and a binary that outlives its limit as a timeout", async () => {
    const garbage = registry(answering(`echo "segmentation fault (core dumped)"; exit 139`));
    const g = (await garbage.invoke("atp.eprover", { tptp: "x" })).output as { result: string; szs: string };
    assert.equal(g.result, "error");
    assert.equal(g.szs, "none");
    const slow = registry(answering("sleep 30"));
    const started = Date.now();
    const t = (await slow.invoke("atp.eprover", { tptp: "x", timeoutSec: 1 })).output as { result: string };
    assert.equal(t.result, "timeout");
    assert.ok(Date.now() - started < 10000);
  });

  it("is unavailable where the binary is not installed, and refuses an include", async () => {
    await assert.rejects(registry("", "/nonexistent/eprover", null).invoke("atp.eprover", { tptp: "x" }), (e: { code?: string }) => e.code === "unavailable");
    const r = registry(answering(`echo "# SZS status Theorem"; exit 0`));
    const refused = (await r.invoke("atp.eprover", { tptp: "include('/etc/passwd')." })).output as { result: string; detail?: string };
    assert.equal(refused.result, "error");
    assert.match(refused.detail ?? "", /refused/);
  });
});

describe("the contract of atp.eprover", () => {
  it("passes its cases with a stand-in binary that answers like E", async () => {
    const body = 'IN=$(cat); case "$IN" in *"greater(5"*) echo "# SZS status Theorem"; exit 0;; esac; echo "# SZS status GaveUp"; exit 1';
    const r = installed(`if [ "$1" = "--version" ]; then echo 'E 3.2.5'; exit 0; fi; ${body}`);
    const report = await runContract(r, "atp.eprover");
    assert.equal(report.failed, 0, JSON.stringify(report.cases.filter((c) => !c.passed)));
    assert.equal(report.passed, 2);
  });

  const real = process.env.EPROVER_COMMAND ?? "eprover";
  const present = spawnSync(real, ["--version"], { stdio: "ignore" }).status === 0;
  it("passes its cases with the real eprover binary", { skip: present ? false : `no ${real} binary on this host` }, async () => {
    const host: HostProfile = { host: "test", capabilities: { "atp.eprover": { use: ["process"], settings: { process: { command: real } } } } };
    const dir = mkdtempSync(join(tmpdir(), "mh-eprover-real-"));
    const r = new Registry({ catalog: loadCatalog(join(root, "capabilities")), host, factories: { eprover: eproverFactory() }, journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
    const report = await runContract(r, "atp.eprover");
    assert.equal(report.failed, 0, JSON.stringify(report.cases.filter((c) => !c.passed)));
  });
});

describe("atp.eprover: the version line", () => {
  it("does not delay the first answer beyond a small bound, and is kept once a later call has it", async () => {
    // `--version` takes 1.2 s: the first answer does not wait for it, a later one has it
    const r = installed(`if [ "$1" = "--version" ]; then sleep 1.2; echo 'stand-in-eprover 0.0'; exit 0; fi; cat > /dev/null; echo "# SZS status GaveUp"; exit 1`);
    const started = Date.now();
    const first = (await r.invoke("atp.eprover", { tptp: "x" })).output as { version?: string };
    assert.ok(Date.now() - started < 1100, `the first answer took ${Date.now() - started} ms`);
    assert.equal(first.version, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const later = (await r.invoke("atp.eprover", { tptp: "x" })).output as { version?: string };
    assert.equal(later.version, "stand-in-eprover 0.0");
  });

  it("does not let an aborted first call decide the version for the process", async () => {
    const r = installed(answering(`echo "# SZS status GaveUp"; exit 1`));
    const controller = new AbortController();
    controller.abort();
    await r.invoke("atp.eprover", { tptp: "x" }, { signal: controller.signal }).catch(() => {});
    const next = (await r.invoke("atp.eprover", { tptp: "x" })).output as { version?: string };
    assert.equal(next.version, "stand-in-eprover 0.0");
  });
});
