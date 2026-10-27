import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CapabilityError, type HostProfile, type ImplementationFactory, loadCatalog, loadHostProfile, Registry } from "@seshat/registry";
import { lakeCertifyFactory } from "../src/index.ts";

const FAKE_LAKE = fileURLToPath(new URL("./fixtures/fake-lake.ts", import.meta.url));
const FAKE_SANDBOX = fileURLToPath(new URL("./fixtures/fake-sandbox.ts", import.meta.url));
const NODE = ["--disable-warning=ExperimentalWarning"];
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));

const INPUT = {
  original: "theorem T : True := by\n  sorry\n",
  candidate: "theorem T : True := by\n  trivial\n",
  target: "T",
  allowedAxioms: ["propext", "Classical.choice", "Quot.sound"],
};

interface Logged {
  args: string[];
  source?: string;
}

/**
 * The registry over the real manifest of `lean.certify` and a host profile that points `lake` at the
 * fake, and opts in to running unsandboxed unless the settings say otherwise.
 */
function registryWith(settings: Record<string, unknown> = {}, env: Record<string, string> = {}, hostName = "test") {
  const dir = mkdtempSync(join(tmpdir(), "seshat-factory-"));
  const project = join(dir, "project");
  const workDir = join(dir, "work");
  mkdirSync(project);
  mkdirSync(workDir);
  const log = join(dir, "calls.jsonl");
  const lake = {
    command: process.execPath,
    args: NODE.concat(FAKE_LAKE),
    projectDir: project,
    workDir,
    unsandboxed: true,
    env: { FAKE_LAKE_LOG: log, ...env },
    ...settings,
  };
  const host = { host: hostName, capabilities: { "lean.certify": { use: ["lake"], settings: { lake } } } } as unknown as HostProfile;
  const registry = new Registry({ catalog, host, factories: { "lake-certify": lakeCertifyFactory() } });
  const calls = (): Logged[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Logged)
      : [];
  return { registry, calls };
}

describe("the lake-certify factory", () => {
  it("compiles the bench's prelude as the manifest's probe in the health check", async () => {
    const { registry, calls } = registryWith();
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, true, entry?.detail);
    assert.match(entry?.detail ?? "", /the probe file compiles/);
    assert.equal(calls().find((c) => c.args[2] === "-o")?.source, "import FormalConjectures.Util.ProblemImports\n");
  });

  it("is unhealthy, with Lean's reason, when the project cannot import the prelude, and then refuses a certification", async () => {
    const { registry, calls } = registryWith({}, { FAKE_LAKE_BROKEN_IMPORTS: "1" });
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, false);
    assert.match(entry?.detail ?? "", /cannot compile the probe file \(import FormalConjectures\.Util\.ProblemImports\)/);
    assert.match(entry?.detail ?? "", /unknown module prefix 'FormalConjectures'/);
    await assert.rejects(
      registry.invoke("lean.certify", INPUT),
      (e: unknown) => e instanceof CapabilityError && e.code === "unavailable" && /unknown module prefix 'FormalConjectures'/.test(e.message),
    );
    assert.ok(calls().every((c) => c.args[2] !== "-o" || c.args[4]?.endsWith("probe.lean")), "no candidate was compiled against the broken project");
  });

  it("lets the host change the probe or leave it out", async () => {
    const other = registryWith({ probe: "import Mathlib" });
    assert.equal((await other.registry.health("lean.certify"))[0]?.ok, true);
    assert.equal(other.calls().find((c) => c.args[2] === "-o")?.source, "import Mathlib\n");
    const none = registryWith({ probe: "" }, { FAKE_LAKE_BROKEN_IMPORTS: "1" });
    const [entry] = await none.registry.health("lean.certify");
    assert.equal(entry?.ok, true, "only the version is checked");
    assert.deepEqual(none.calls().map((c) => c.args[2]), ["--version"]);
  });
});

describe("lean.certify fails closed", () => {
  const REFUSES = /refuses to run the candidate's code without a sandbox/;

  it("is unavailable, with the reason, in the health check and for a call, until the host gives a sandbox or opts in", async () => {
    const { registry, calls } = registryWith({ unsandboxed: false });
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, false);
    assert.match(entry?.detail ?? "", REFUSES);
    assert.match(entry?.detail ?? "", /unsandboxed: true/);
    await assert.rejects(
      registry.invoke("lean.certify", INPUT),
      (e: unknown) => e instanceof CapabilityError && e.code === "unavailable" && REFUSES.test(e.message),
    );
    assert.deepEqual(calls(), [], "nothing was run");
    assert.deepEqual(await registry.usable("lean.certify"), { ok: false, detail: `lake: ${entry?.detail}` });
  });

  it("runs the sandbox command the host gives, and says so in the health check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seshat-factory-sandbox-"));
    const sandboxLog = join(dir, "sandbox.jsonl");
    const { registry } = registryWith(
      { unsandboxed: false, sandbox: [process.execPath, ...NODE, FAKE_SANDBOX, "--bind", "{work}", "--"] },
      { FAKE_SANDBOX_LOG: sandboxLog },
    );
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, true, entry?.detail);
    assert.match(entry?.detail ?? "", /sandbox command: .*node/);
    const result = await registry.invoke("lean.certify", INPUT);
    assert.equal((result.output as { verdict: string }).verdict, "certified");
    assert.ok(readFileSync(sandboxLog, "utf8").split("\n").filter((l) => l !== "").length >= 4, "the version check and the three calls of a certification went through it");
  });

  it("runs unsandboxed when the host opts in, and says so in the health check", async () => {
    const { registry } = registryWith({ unsandboxed: true });
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, true, entry?.detail);
    assert.match(entry?.detail ?? "", /no sandbox: the candidate's code runs as the harness's user/);
  });

  it("is unavailable on the host server unless that host gives a sandbox command: it never runs unsandboxed", async () => {
    const opted = registryWith({ unsandboxed: true }, {}, "server");
    const [entry] = await opted.registry.health("lean.certify");
    assert.equal(entry?.ok, false);
    assert.match(entry?.detail ?? "", /the host server never runs lean\.certify without a sandbox/);
    const sandboxed = registryWith({ unsandboxed: true, sandbox: [process.execPath, ...NODE, FAKE_SANDBOX, "--bind", "{work}", "--"] }, {}, "server");
    assert.equal((await sandboxed.registry.health("lean.certify"))[0]?.ok, true);
  });

  it("is unavailable when the replay program cannot be read", async () => {
    const { registry } = registryWith({ program: "/nonexistent/Main.lean" });
    const [entry] = await registry.health("lean.certify");
    assert.equal(entry?.ok, false);
    assert.match(entry?.detail ?? "", /cannot read the replay program \/nonexistent\/Main\.lean/);
  });

  it("is unavailable on both profiles that ship, which do not opt in, whether or not the project is set", async () => {
    const anyFactory: ImplementationFactory = () => ({ invoke: async () => ({}) });
    // Every factory a manifest names, so that a capability added to the profiles later does not break this test.
    const factories: Record<string, ImplementationFactory> = {};
    for (const { manifest } of catalog.capabilities.values()) {
      for (const spec of manifest.implementations) if (spec.kind === "inproc") factories[spec.factory] = anyFactory;
    }
    const project = mkdtempSync(join(tmpdir(), "seshat-shipped-"));
    for (const host of ["local", "server"]) {
      const profile = loadHostProfile(join(REPO, "config", "hosts", `${host}.json`));
      assert.equal(JSON.stringify(profile.capabilities["lean.certify"]).includes("unsandboxed"), false, `${host} does not opt in`);
      const registryFor = (env: Record<string, string>) =>
        new Registry({
          catalog,
          host: profile,
          factories: { ...factories, "lake-certify": lakeCertifyFactory() },
          env,
        });
      const [withProject] = await registryFor({ LEAN_PROJECT_DIR: project }).health("lean.certify");
      assert.equal(withProject?.ok, false, host);
      assert.match(withProject?.detail ?? "", REFUSES, host);
      assert.doesNotMatch(withProject?.detail ?? "", /LEAN_PROJECT_DIR/, host);
      const [without] = await registryFor({}).health("lean.certify");
      assert.equal(without?.ok, false, host);
      assert.match(without?.detail ?? "", /set LEAN_PROJECT_DIR; .*refuses to run the candidate's code without a sandbox/, host);
    }
  });
});
