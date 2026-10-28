import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile, type LeanEnvPin } from "@seshat/registry";
import { loadEnvSpec, resolveEnvironment, writeEnvironment, BUILD_FILE, type Fetcher } from "@seshat/lean-env";
import type { LeanChecker } from "@seshat/core";
import { FACTORIES, openRegistry, REPO_ROOT, RunSetupError, type RunOptions } from "../src/index.ts";
import { assertSound, nth } from "./resume-helpers.ts";
import { check, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";

const FC = "https://github.com/google-deepmind/formal-conjectures";
const BASE = `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "formal_conjectures"\ngit = "${FC}"\nrev = "bench-v1-lean4.27.0"\nlean_libs = ["FormalConjectures"]\n`;
const EXTENDED = `${BASE}\n[[package]]\nname = "Duper"\ngit = "https://github.com/leanprover-community/duper"\nrev = "v4.27.0"\nlean_libs = ["Duper"]\n`;
const MATHLIB = { name: "mathlib", type: "git", url: "https://github.com/leanprover-community/mathlib4", rev: "a".repeat(40), inputRev: "v4.27.0" };
const fetch: Fetcher = async (_source, file) => (file === "lean-toolchain" ? "leanprover/lean4:v4.27.0\n" : JSON.stringify({ packages: [MATHLIB] }));

/** An `lean/env` directory with `base` and `extended`, resolved, and `base` also built. */
async function envRoot(options: { built?: string[]; resolved?: string[] } = {}): Promise<{ root: string; hashes: Record<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), "seshat-env-run-"));
  writeFileSync(join(root, "base.toml"), BASE);
  writeFileSync(join(root, "extended.toml"), EXTENDED);
  const hashes: Record<string, string> = {};
  for (const name of options.resolved ?? ["base", "extended"]) {
    const spec = loadEnvSpec(name, root);
    const { lock } = await resolveEnvironment(spec, { fetch });
    assert.ok(lock);
    writeEnvironment(spec, lock, join(root, name));
    hashes[name] = lock.hash;
    if (options.built?.includes(name)) writeFileSync(join(root, name, BUILD_FILE), JSON.stringify({ hash: lock.hash, finishedAt: "now", steps: [] }));
  }
  return { root, hashes };
}

/** The registry of the demo runs, on a host whose Lean environment is `pin`. */
const pinTo = (pin: LeanEnvPin) => (lean: LeanChecker): RunOptions["registry"] => {
  const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
  const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };
  return (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean) }, journal, blobs, leanEnv: pin });
};

describe("opening the registry of a host that names a Lean environment", () => {
  it("pins the environment the profile names (LEAN_ENV, default base) with its hash from the project", async () => {
    const { root, hashes } = await envRoot();
    const byDefault = openRegistry({ host: "local", envRoot: root, env: {} });
    assert.deepEqual(byDefault.leanEnv, { name: "base", hash: hashes.base, dir: join(root, "base"), status: "resolved", built: false });
    const named = openRegistry({ host: "local", envRoot: root, env: { LEAN_ENV: "extended" } });
    assert.equal(named.leanEnv?.hash, hashes.extended);
    assert.notEqual(hashes.base, hashes.extended);
    const overridden = openRegistry({ host: "local", envRoot: root, env: { LEAN_ENV: "extended" }, leanEnv: "base" });
    assert.equal(overridden.leanEnv?.name, "base", "an explicit environment wins over LEAN_ENV");
    // Versions of the Lean tools carry the hash, the others do not.
    assert.match(
      byDefault.versionOf(byDefault.capability("lean.check").manifest.implementations[0] as never),
      new RegExp(`^fb2393de\\+lean-v4\\.27\\.0\\+fc-bench-v1\\+env:base@${hashes.base?.slice(0, 12)}$`),
    );
  });

  it("says the environment is unresolved, stale or unknown instead of throwing", async () => {
    const { root } = await envRoot({ resolved: ["base"] });
    const unresolved = openRegistry({ host: "local", envRoot: root, env: { LEAN_ENV: "extended" } });
    assert.deepEqual([unresolved.leanEnv?.status, unresolved.leanEnv?.hash], ["unresolved", null]);
    const unknown = openRegistry({ host: "local", envRoot: root, env: { LEAN_ENV: "typo" } });
    assert.equal(unknown.leanEnv?.status, "unknown");
    writeFileSync(join(root, "base.toml"), BASE.replace("bench-v1-lean4.27.0", "main"));
    assert.equal(openRegistry({ host: "local", envRoot: root, env: {} }).leanEnv?.status, "stale");
  });

  it("makes the environment's project the default LEAN_PROJECT_DIR once it is built, and never before", async () => {
    const { root } = await envRoot({ built: ["base"] });
    const projects = async (env: Record<string, string>, name: string): Promise<unknown> => {
      let projectDir: unknown = "never asked";
      const registry = openRegistry({
        host: "local",
        envRoot: root,
        env,
        factories: { ...FACTORIES, "lake-certify": (context) => { projectDir = context.settings.projectDir; throw new Error("stop"); } },
        leanEnv: name,
      });
      await registry.usable("lean.certify");
      return projectDir;
    };
    assert.equal(await projects({}, "base"), join(root, "base"));
    assert.equal(await projects({}, "extended"), "", "resolved but not built: Lake would fetch packages, so no project");
    assert.equal(await projects({ LEAN_PROJECT_DIR: "/somewhere/else" }, "base"), "/somewhere/else", "an explicit project wins");
    assert.equal(await projects({ LEAN_PROJECT_DIR: "" }, "base"), join(root, "base"), "an empty one is not a choice");
  });

  it("reads the hash from the project it is given: the one the tools really run in", async () => {
    const { root, hashes } = await envRoot();
    const registry = openRegistry({ host: "local", envRoot: root, env: { LEAN_PROJECT_DIR: join(root, "extended") }, leanEnv: "extended" });
    assert.equal(registry.leanEnv?.hash, hashes.extended);
    const wrong = openRegistry({ host: "local", envRoot: root, env: { LEAN_PROJECT_DIR: join(root, "extended") }, leanEnv: "base" });
    assert.equal(wrong.leanEnv?.status, "stale", "LEAN_ENV=base with the project of extended is not an environment");
    const plain = mkdtempSync(join(tmpdir(), "seshat-plain-checkout-"));
    mkdirSync(plain, { recursive: true });
    const unlocked = openRegistry({ host: "local", envRoot: root, env: { LEAN_PROJECT_DIR: plain }, leanEnv: "base" });
    assert.equal(unlocked.leanEnv?.status, "unresolved", "a plain checkout has no lock and so no hash");
  });
});

describe("a run and its Lean environment", () => {
  const HASH = "ab".repeat(32);

  it("records the environment in run.started, in every Lean tool run, in config.json and in the report", async () => {
    const { events, result, dir } = await demoRun({ registry: pinTo({ name: "extended", hash: HASH, status: "resolved", built: true }), responses: [check("exact trivial_proof")] });
    const started = ofType(events, "run.started")[0]?.data.config as { leanEnv?: unknown };
    assert.deepEqual(started.leanEnv, { name: "extended", hash: HASH });
    const versions = new Set(ofType(events, "tool_run.started").map((e) => e.data.version));
    assert.deepEqual([...versions], [`fb2393de+lean-v4.27.0+fc-bench-v1+env:extended@${HASH.slice(0, 12)}`]);
    assert.deepEqual(result.report.leanEnv, { name: "extended", hash: HASH });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).leanEnv, { name: "extended", hash: HASH });
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), new RegExp(` Lean environment: extended \\(${HASH.slice(0, 12)}\\)\\.$`, "m"));
  });

  it("records an unresolved environment by name without a hash, and warns", async () => {
    const log: string[] = [];
    const { events } = await demoRun({ registry: pinTo({ name: "base", hash: null, status: "unresolved", detail: "no lock" }), responses: [check("exact trivial_proof")], log: (l) => log.push(l) });
    assert.deepEqual((ofType(events, "run.started")[0]?.data.config as { leanEnv?: unknown }).leanEnv, { name: "base", hash: null });
    assert.ok(log.some((l) => /Lean environment base is not resolved \(no lock\).*cannot be matched to an environment/.test(l)));
    assert.deepEqual([...new Set(ofType(events, "tool_run.started").map((e) => e.data.version))], ["fb2393de+lean-v4.27.0+fc-bench-v1"]);
  });

  it("records nothing of an environment on a host that names none", async () => {
    const { events, result } = await demoRun({ responses: [check("exact trivial_proof")] });
    assert.equal("leanEnv" in (ofType(events, "run.started")[0]?.data.config as object), false);
    assert.equal(result.report.leanEnv, undefined);
  });

  it("refuses to start in an environment that is stale or unknown, and writes nothing", async () => {
    for (const status of ["stale", "unknown"] as const) {
      const dir = join(mkdtempSync(join(tmpdir(), "seshat-env-refused-")), "run");
      await assert.rejects(
        demoRun({ dir, registry: pinTo({ name: "base", hash: null, status, detail: "base.toml changed since it was resolved" }), responses: [] }),
        (error: Error) => error instanceof RunSetupError && /^the Lean environment base cannot be used: base\.toml changed since it was resolved/.test(error.message),
      );
      assert.equal(existsSync(dir), false);
    }
  });

  it("is resumed only in the environment it began in", async () => {
    const pin: LeanEnvPin = { name: "extended", hash: HASH, status: "resolved", built: true };
    const whole = await demoRun({ registry: pinTo(pin), config: { sessions: 2 }, responses: [check("bad"), say("NOTES: bad."), check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    await assert.rejects(
      demoResume({ dir, bench: whole.bench, responses: [], registry: pinTo({ ...pin, hash: "cd".repeat(32) }) }),
      (error: Error) => error instanceof RunSetupError && /the run cannot be resumed here: the Lean environment \(name and hash\): the run recorded \{"hash":"ab/.test(error.message),
    );
    await assert.rejects(demoResume({ dir, bench: whole.bench, responses: [], registry: pinTo({ name: "extended", hash: null }) }), /the Lean environment \(name and hash\)/);
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")], registry: pinTo(pin) });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assertSound(resumed.events);
    // The tool runs of both processes name the same environment.
    assert.equal(new Set(ofType(resumed.events, "tool_run.started").map((e) => e.data.version)).size, 1);
  });

  it("resumes a run that began before environments were recorded, whatever environment the resuming host has", async () => {
    const whole = await demoRun({ config: { sessions: 2 }, responses: [check("bad"), say("NOTES: bad."), check("exact trivial_proof")] });
    const dir = killedAt(whole.dir, nth(whole.events, "attempt.started", 2));
    const resumed = await demoResume({ dir, bench: whole.bench, responses: [check("exact trivial_proof")], registry: pinTo({ name: "base", hash: HASH }) });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
  });
});
