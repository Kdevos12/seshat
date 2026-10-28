import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, readEvents, type Json, type LeanCertifier } from "@seshat/core";
import { FakeChecker } from "../../core/test/fake-lean.ts";
import {
  CatalogError,
  leanCertifyImplementation,
  leanCheckImplementation,
  loadCatalog,
  parseHostProfile,
  Registry,
  RegistryLeanCertifier,
  RegistryLeanChecker,
  type HostProfile,
  type LeanEnvPin,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "lean.certify": { use: ["lake"] } } };
const HASH = "0123456789abcdef".repeat(4);
const VERSION = "fb2393de+lean-v4.27.0+fc-bench-v1";

const certifier: LeanCertifier = {
  implementation: "fake",
  version: "0",
  async certify() {
    return { verdict: "certified", reasons: [], axioms: [], timeMs: 1 };
  },
};

function registryFor(leanEnv: LeanEnvPin | undefined, journal?: Journal): Registry {
  return new Registry({
    catalog,
    host,
    factories: { kimina: () => leanCheckImplementation(new FakeChecker(() => ({ type: "Prop" }))), "lake-certify": () => leanCertifyImplementation(certifier) },
    ...(journal !== undefined ? { journal } : {}),
    ...(leanEnv !== undefined ? { leanEnv } : {}),
  });
}

const input = { snippets: [{ id: "a", code: "theorem t : True := trivial" }] };

describe("the Lean environment in a registry", () => {
  it("puts the environment hash in the version of every Lean tool run", async () => {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_env");
    try {
      const registry = registryFor({ name: "extended", hash: HASH, status: "resolved" }, journal);
      const result = await registry.invoke("lean.check", input);
      assert.equal(result.version, `${VERSION}+env:extended@${HASH.slice(0, 12)}`);
      await registry.invoke("lean.check", input);
      const versions = readEvents(join(dir, "journal.jsonl")).flatMap((e) => (e.type === "tool_run.started" ? [(e.data as Record<string, Json>).version] : []));
      assert.deepEqual(versions, [result.version, result.version]);
      const [entry] = await registry.health("lean.check");
      assert.equal(entry?.version, result.version);
    } finally {
      journal.close();
    }
  });

  it("changes the version only for implementations that depend on Lean, and not when the environment is unresolved", async () => {
    const plain = await registryFor(undefined).invoke("lean.check", input);
    assert.equal(plain.version, VERSION);
    const unresolved = await registryFor({ name: "base", hash: null, status: "unresolved" }).invoke("lean.check", input);
    assert.equal(unresolved.version, VERSION, "no hash is recorded rather than a made-up one");
    const named = registryFor({ name: "base", hash: HASH });
    assert.equal(named.versionOf(catalog.capabilities.get("oeis.search")?.manifest.implementations[0] as never), "json-search+client-1");
  });

  it("names the environment in the version of the checker and the certifier of the registry", () => {
    const registry = registryFor({ name: "base", hash: HASH });
    const suffix = `+env:base@${HASH.slice(0, 12)}`;
    assert.equal(new RegistryLeanChecker(registry).version, `${registry.hash.slice(0, 12)}${suffix}`);
    assert.equal(RegistryLeanCertifier.forHost(registry)?.version, `0.1.0+lean-v4.27.0+fc-bench-v1${suffix}`);
    assert.equal(new RegistryLeanChecker(registryFor(undefined)).version.length, 12);
  });

  it("is pinned when the registry is built: the pin it was given does not change under it", async () => {
    const pin: LeanEnvPin = { name: "base", hash: HASH };
    const registry = registryFor(pin);
    pin.hash = "f".repeat(64);
    pin.name = "other";
    assert.deepEqual(registry.leanEnv, { name: "base", hash: HASH });
    assert.equal((await registry.invoke("lean.check", input)).version, `${VERSION}+env:base@${HASH.slice(0, 12)}`);
  });

  it("reads the environment's name from a host profile", () => {
    const profile = parseHostProfile({ host: "x", leanEnv: "${env:LEAN_ENV:-base}", capabilities: {} });
    assert.equal(profile.leanEnv, "${env:LEAN_ENV:-base}");
    assert.equal(parseHostProfile({ host: "x", capabilities: {} }).leanEnv, undefined);
    assert.throws(() => parseHostProfile({ host: "x", leanEnv: "", capabilities: {} }), CatalogError);
    assert.throws(() => parseHostProfile({ host: "x", leanEnv: 3, capabilities: {} }), CatalogError);
  });
});
