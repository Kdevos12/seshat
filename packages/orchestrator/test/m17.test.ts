import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUILD_FILE, loadEnvSpec, resolveEnvironment, writeEnvironment, type Fetcher } from "@seshat/lean-env";
import type { LeanChecker } from "@seshat/core";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile, type LeanEnvPin } from "@seshat/registry";
import { REPO_ROOT, RunSetupError, type RunOptions } from "../src/index.ts";
import { assertSound, nth } from "./resume-helpers.ts";
import { check, DemoLean, demoAnswer, demoResume, demoRun, killedAt, ofType, say, tempDir } from "./m0-helpers.ts";

/**
 * Line M17 in a run: the run's Lean environment is the one the line names, its extra packages'
 * libraries are imported by every file the run checks, and the run does not start unless the
 * environment is resolved. The Lean is simulated; nothing here ran against Lake or a real server.
 */
const FC = "https://github.com/google-deepmind/formal-conjectures";
const BASE = `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "formal_conjectures"\ngit = "${FC}"\nrev = "bench-v1-lean4.27.0"\nlean_libs = ["FormalConjectures"]\n`;
const EXTENDED = `${BASE}\n[[package]]\nname = "Duper"\ngit = "https://github.com/leanprover-community/duper"\nrev = "v4.27.0"\nlean_libs = ["Duper"]\n`;
const MATHLIB = { name: "mathlib", type: "git", url: "https://github.com/leanprover-community/mathlib4", rev: "a".repeat(40), inputRev: "v4.27.0" };
const fetch: Fetcher = async (_source, file) => (file === "lean-toolchain" ? "leanprover/lean4:v4.27.0\n" : JSON.stringify({ packages: [MATHLIB] }));

/** An `lean/env` directory with `base` and `extended` resolved, with the pins of both. */
async function pins(): Promise<{ base: LeanEnvPin; extended: LeanEnvPin }> {
  const root = mkdtempSync(join(tmpdir(), "mh-m17-env-"));
  writeFileSync(join(root, "base.toml"), BASE);
  writeFileSync(join(root, "extended.toml"), EXTENDED);
  const out: Record<string, LeanEnvPin> = {};
  for (const name of ["base", "extended"]) {
    const spec = loadEnvSpec(name, root);
    const { lock } = await resolveEnvironment(spec, { fetch });
    assert.ok(lock);
    writeEnvironment(spec, lock, join(root, name));
    writeFileSync(join(root, name, BUILD_FILE), JSON.stringify({ hash: lock.hash, finishedAt: "now", steps: [] }));
    out[name] = { name, hash: lock.hash, dir: join(root, name), status: "resolved", built: true };
  }
  return out as { base: LeanEnvPin; extended: LeanEnvPin };
}

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };

/** The registry of the demo runs, as the CLI builds it: for the environment the line asks, or else the host's (`hostPin`). */
function registryFor(pinOf: (asked: string | undefined) => LeanEnvPin | undefined, asked: Array<string | undefined>) {
  return (lean: LeanChecker): RunOptions["registry"] =>
    (journal, blobs, options) => {
      asked.push(options?.leanEnv);
      const pin = pinOf(options?.leanEnv);
      return new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean) }, journal, blobs, ...(pin !== undefined ? { leanEnv: pin } : {}) });
    };
}

const PROBE = "import Duper\n";

describe("line M17 in a run", () => {
  it("puts the run in the environment, adds the extra libraries to every file, and probes the server first", async () => {
    const { base, extended } = await pins();
    const asked: Array<string | undefined> = [];
    const lean = new DemoLean();
    const log: string[] = [];
    const { events, result } = await demoRun({
      lean,
      registry: registryFor((name) => (name === "extended" ? extended : base), asked),
      config: { lines: ["M17"], sessions: 1 },
      responses: [check("exact trivial_proof")],
      log: (line) => log.push(line),
    });
    assert.deepEqual(asked, ["extended"], "the registry is built for the line's environment, not the host's");
    assert.deepEqual((ofType(events, "run.started")[0]?.data.config as { leanEnv?: unknown }).leanEnv, { name: "extended", hash: extended.hash });
    assert.deepEqual(result.report.leanEnv, { name: "extended", hash: extended.hash });
    assert.deepEqual(
      (ofType(events, "run.started")[0]?.data.config as { lines?: Array<{ id: string; options: unknown }> }).lines?.map((l) => [l.id, l.options]),
      [["M17", { env: "extended" }]],
    );
    // The probe is the first check: a file that is only the libraries' imports. Every other file imports them after the problem's own.
    const codes = lean.calls.map((call) => call.code);
    assert.equal(codes[0], PROBE);
    assert.ok(codes.length > 1);
    for (const code of codes.slice(1)) assert.match(code, /^import FormalConjectures\.Util\.ProblemImports\nimport Duper\n/, "after the file's own imports, once");
    assert.ok(codes.slice(1).every((code) => code.split("import Duper").length === 2));
    // The tool runs name the environment the line chose.
    const versions = new Set(ofType(events, "tool_run.started").map((e) => e.data.version));
    assert.ok([...versions].every((v) => String(v).endsWith(`+env:extended@${String(extended.hash).slice(0, 12)}`)));
    assert.equal(result.stopped, undefined);
    assert.equal(result.problems[0]?.outcome, "candidate");
  });

  it("takes the environment from the line's option env", async () => {
    const { base, extended } = await pins();
    const asked: Array<string | undefined> = [];
    const { events } = await demoRun({
      registry: registryFor((name) => (name === "extended" ? extended : base), asked),
      config: { lines: ["M17"], lineOptions: { M17: { env: "base" } }, sessions: 1 },
      responses: [check("exact trivial_proof")],
    });
    assert.deepEqual(asked, ["base"]);
    assert.equal((ofType(events, "run.started")[0]?.data.config as { leanEnv?: { name: string } }).leanEnv?.name, "base");
  });

  it("does not touch a run without the line: the host's environment, no extra import, no probe", async () => {
    const { base } = await pins();
    const asked: Array<string | undefined> = [];
    const lean = new DemoLean();
    const { events } = await demoRun({ lean, registry: registryFor(() => base, asked), config: { sessions: 1 }, responses: [check("exact trivial_proof")] });
    assert.deepEqual(asked, [undefined]);
    assert.equal((ofType(events, "run.started")[0]?.data.config as { leanEnv?: { name: string } }).leanEnv?.name, "base");
    assert.ok(lean.calls.every((call) => !call.code.includes("import Duper")));
  });

  it("refuses to start, and writes nothing, when the registry is not for the line's environment", async () => {
    const { base } = await pins();
    const dir = join(tempDir("mh-m17-refused-"), "run");
    await assert.rejects(
      demoRun({ dir, registry: registryFor(() => base, []), config: { lines: ["M17"] }, responses: [] }),
      (error: Error) => error instanceof RunSetupError && /line M17 puts the run in the Lean environment extended, and the registry of host test was built for base/.test(error.message),
    );
    assert.equal(existsSync(dir), false);
  });

  it("refuses to start when the environment is not resolved on this machine: no hash, no run", async () => {
    const dir = join(tempDir("mh-m17-refused-"), "run");
    const unresolved: LeanEnvPin = { name: "extended", hash: null, status: "unresolved", detail: "no lock" };
    await assert.rejects(
      demoRun({ dir, registry: registryFor(() => unresolved, []), config: { lines: ["M17"] }, responses: [] }),
      (error: Error) => error instanceof RunSetupError && /line M17 needs the Lean environment extended resolved on this machine, and it is not \(no lock\)/.test(error.message),
    );
    assert.equal(existsSync(dir), false);
    const missing: LeanEnvPin = { name: "extended", hash: null, status: "unknown", detail: "no such environment" };
    await assert.rejects(demoRun({ dir, registry: registryFor(() => missing, []), config: { lines: ["M17"] }, responses: [] }), /cannot be used/);
  });

  it("stops before any problem when the Lean server cannot import the environment's libraries", async () => {
    const { extended } = await pins();
    const lean = new DemoLean((code) =>
      code === PROBE ? { messages: [{ severity: "error", pos: { line: 1, column: 7 }, text: "unknown module prefix 'Duper'\nNo directory 'Duper' in the search path" }] } : demoAnswer(code),
    );
    const log: string[] = [];
    const { events, result } = await demoRun({
      lean,
      registry: registryFor(() => extended, []),
      config: { lines: ["M17"] },
      responses: [],
      log: (line) => log.push(line),
    });
    assert.equal(result.stopped, "lean_environment");
    assert.equal(ofType(events, "attempt.started").length, 0, "no prover ran");
    assert.equal(ofType(events, "run.finished")[0]?.data.stopped, "lean_environment");
    assert.ok(log.some((l) => /cannot import the libraries of environment extended \(Duper\): unknown module prefix 'Duper'\. Start it on .* \(LEAN_SERVER_PROJECT_DIR\)/.test(l)));
  });

  it("leaves the files and the server alone in a run that is in the environment through the host alone: the pin and the record, not the line's imports and probe", async () => {
    const { extended } = await pins();
    for (const lines of [[], ["M1"]]) {
      const asked: Array<string | undefined> = [];
      const lean = new DemoLean();
      const { events } = await demoRun({ lean, registry: registryFor(() => extended, asked), config: { lines, sessions: 1 }, responses: [check("exact trivial_proof")] });
      assert.deepEqual(asked, [undefined], "the registry is the host's");
      assert.deepEqual((ofType(events, "run.started")[0]?.data.config as { leanEnv?: unknown }).leanEnv, { name: "extended", hash: extended.hash }, "recorded");
      assert.ok(ofType(events, "tool_run.started").every((e) => String(e.data.version).endsWith(`+env:extended@${String(extended.hash).slice(0, 12)}`)));
      assert.ok(lean.calls.length > 0);
      assert.ok(lean.calls.every((call) => !call.code.includes("import Duper")), "no extra import, no probe");
    }
  });

  it("is resumed with the line, in the environment it began in, and the probe runs again", async () => {
    const { extended } = await pins();
    const options = { lines: ["M17"], sessions: 2 };
    const whole = await demoRun({ registry: registryFor(() => extended, []), config: options, responses: [check("bad"), say("NOTES: bad."), check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const lean = new DemoLean();
    const resumed = await demoResume({ dir, bench: whole.bench, lean, registry: registryFor(() => extended, []), responses: [check("exact trivial_proof")] });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assertSound(resumed.events);
    assert.deepEqual((ofType(resumed.events, "run.started")[0]?.data.config as { lines?: Array<{ id: string }> }).lines?.map((l) => l.id), ["M17"]);
    assert.equal(lean.calls[0]?.code, PROBE, "the server is probed again in the resuming process");
    assert.ok(lean.calls.slice(1).every((call) => /^import FormalConjectures\.Util\.ProblemImports\nimport Duper\n/.test(call.code)));
    assert.equal(new Set(ofType(resumed.events, "tool_run.started").map((e) => e.data.version)).size, 1);
  });

  it("refuses to resume a run with the line under a pin whose hash is not the project's (the line reads the imports from the lock, which the pin must name)", async () => {
    const { extended } = await pins();
    const whole = await demoRun({ registry: registryFor(() => extended, []), config: { lines: ["M17"], sessions: 2 }, responses: [check("bad"), say("NOTES: bad."), check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const other: LeanEnvPin = { ...extended, hash: "cd".repeat(32) };
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, responses: [], registry: registryFor(() => other, []) }),
      (error: Error) => error instanceof RunSetupError && /^the Lean environment extended: the lock in .* is not the one the registry pinned/.test(error.message),
    );
  });
});
