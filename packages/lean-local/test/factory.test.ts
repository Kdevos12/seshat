import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CapabilityError, type HostProfile, loadCatalog, Registry } from "@seshat/registry";
import { lakeCertifyFactory } from "../src/index.ts";

const FAKE_LAKE = fileURLToPath(new URL("./fixtures/fake-lake.ts", import.meta.url));
const NODE = ["--disable-warning=ExperimentalWarning"];
const catalog = loadCatalog(fileURLToPath(new URL("../../../capabilities", import.meta.url)));

const INPUT = {
  original: "theorem T : True := by\n  sorry\n",
  candidate: "theorem T : True := by\n  trivial\n",
  target: "T",
  allowedAxioms: ["propext"],
};

interface Logged {
  args: string[];
  source?: string;
}

/** The registry over the real manifest of `lean.certify` and a host profile that points `lake` at the fake. */
function registryWith(settings: Record<string, unknown> = {}, env: Record<string, string> = {}) {
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
    env: { FAKE_LAKE_LOG: log, ...env },
    ...settings,
  };
  const host = { host: "test", capabilities: { "lean.certify": { use: ["lake"], settings: { lake } } } } as unknown as HostProfile;
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
