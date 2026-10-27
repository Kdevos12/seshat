import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  environmentHash,
  leanEnvironmentHash,
  leanEnvOfConfig,
  leanEnvRecord,
  loadEnvSpec,
  lookupEnvironment,
  normalizeGitUrl,
  resolveEnvironment,
  sameLeanEnvironment,
  writeEnvironment,
} from "../src/index.ts";
import { agreeing, BASE_TOML, envRoot, EXTENDED_TOML, fixtureFetcher } from "./fixtures.ts";

/** A root with the environment `extended` resolved into its project directory. */
async function resolved(): Promise<{ root: string; dir: string; hash: string }> {
  const root = envRoot({ "extended.toml": EXTENDED_TOML, "base.toml": BASE_TOML });
  const spec = loadEnvSpec("extended", root);
  const { lock } = await resolveEnvironment(spec, { fetch: fixtureFetcher(agreeing()) });
  const dir = join(root, "extended");
  writeEnvironment(spec, lock as NonNullable<typeof lock>, dir);
  return { root, dir, hash: (lock as NonNullable<typeof lock>).hash };
}

describe("where an environment stands", () => {
  it("is resolved when the project holds the lock of the environment file as it is", async () => {
    const { root, dir, hash } = await resolved();
    const pin = lookupEnvironment("extended", { root });
    assert.deepEqual(pin, { name: "extended", hash, dir, status: "resolved", built: false });
    assert.equal(leanEnvironmentHash("extended", { root }), hash);
    writeFileSync(join(dir, "lean-env.build.json"), JSON.stringify({ hash, finishedAt: "now", steps: [] }));
    assert.equal(lookupEnvironment("extended", { root }).built, true);
    writeFileSync(join(dir, "lean-env.build.json"), JSON.stringify({ hash: "0".repeat(64), finishedAt: "now", steps: [] }));
    assert.equal(lookupEnvironment("extended", { root }).built, false, "a build of another hash is no build of this one");
  });

  it("has no hash while it is not resolved, and says what to run", async () => {
    const root = envRoot({ "base.toml": BASE_TOML });
    const pin = lookupEnvironment("base", { root });
    assert.equal(pin.status, "unresolved");
    assert.equal(pin.hash, null);
    assert.match(pin.detail ?? "", /run harness lean-env resolve base/);
    assert.equal(leanEnvironmentHash("base", { root }), undefined);
  });

  it("is stale when the file changed after it was resolved, the lock was edited, or the project is another environment's", async () => {
    const { root } = await resolved();
    writeFileSync(join(root, "extended.toml"), EXTENDED_TOML.replace('lean_libs = ["Duper"]', 'lean_libs = ["Duper", "Duper.Tactic"]'));
    const changed = lookupEnvironment("extended", { root });
    assert.equal(changed.status, "stale");
    assert.equal(changed.hash, null);
    assert.match(changed.detail ?? "", /changed since it was resolved: run harness lean-env resolve extended/);

    const fresh = await resolved();
    const lockFile = join(fresh.dir, "lean-env.lock.json");
    writeFileSync(lockFile, readFileSync(lockFile, "utf8").replace(/"rev": "v4.27.0"/, '"rev": "v4.99.0"'));
    assert.match(lookupEnvironment("extended", { root: fresh.root }).detail ?? "", /its hash is not the hash of its contents/);
    writeFileSync(lockFile, "not json");
    assert.match(lookupEnvironment("extended", { root: fresh.root }).detail ?? "", /is not JSON/);

    // The project of another environment, given as the project directory.
    const other = await resolved();
    const pin = lookupEnvironment("base", { root: other.root, projectDir: other.dir });
    assert.equal(pin.status, "stale");
    assert.match(pin.detail ?? "", /holds the environment extended, not base/);
  });

  it("is unknown when there is no environment file of that name", () => {
    const pin = lookupEnvironment("nope", { root: envRoot({ "base.toml": BASE_TOML }) });
    assert.equal(pin.status, "unknown");
    assert.match(pin.detail ?? "", /no environment nope/);
  });

  it("reads the lock from the project directory it is given", async () => {
    const { root, dir, hash } = await resolved();
    const elsewhere = lookupEnvironment("extended", { root, projectDir: dir });
    assert.equal(elsewhere.hash, hash);
    assert.equal(lookupEnvironment("extended", { root, projectDir: join(root, "empty") }).status, "unresolved");
  });
});

describe("what a run records of its environment", () => {
  it("is the name and the hash, and two runs are in the same environment only when both have the same hash", () => {
    const a = leanEnvRecord({ name: "base", hash: "1".repeat(64) });
    assert.deepEqual(a, { name: "base", hash: "1".repeat(64) });
    assert.equal(sameLeanEnvironment(a, { name: "renamed", hash: "1".repeat(64) }), true);
    assert.equal(sameLeanEnvironment(a, { name: "base", hash: "2".repeat(64) }), false);
    assert.equal(sameLeanEnvironment({ name: "base", hash: null }, { name: "base", hash: null }), false);
    assert.equal(sameLeanEnvironment(a, undefined), false);
    assert.equal(sameLeanEnvironment(undefined, undefined), false);
  });

  it("is read back from the config of a run.started, and absent from a run that recorded none", () => {
    assert.deepEqual(leanEnvOfConfig({ leanEnv: { name: "base", hash: "ab" } }), { name: "base", hash: "ab" });
    assert.deepEqual(leanEnvOfConfig({ leanEnv: { name: "base", hash: null } }), { name: "base", hash: null });
    assert.equal(leanEnvOfConfig({ model: "x" }), undefined);
    assert.equal(leanEnvOfConfig(null), undefined);
    assert.equal(leanEnvOfConfig({ leanEnv: "base" }), undefined);
  });

  it("names a repository once, however its URL is written", () => {
    assert.equal(normalizeGitUrl("http://GitHub.com/a/b.git/"), "https://github.com/a/b");
    assert.equal(normalizeGitUrl("https://github.com/a/b"), "https://github.com/a/b");
  });

  it("hashes the parts it is given, in no order", () => {
    const pkg = (name: string) => ({ name, role: "extra" as const, git: `https://github.com/x/${name}`, rev: "v1", leanLibs: [name], toolchain: "t", manifestHash: null });
    const dep = (name: string) => ({ name, url: `https://github.com/y/${name}`, rev: "a".repeat(40), usedBy: ["p"] });
    const base = { ...pkg("base"), role: "base" as const };
    const one = environmentHash({ toolchain: "t", packages: [base, pkg("a"), pkg("b")], dependencies: [dep("m"), dep("n")] });
    const two = environmentHash({ toolchain: "t", packages: [base, pkg("b"), pkg("a")], dependencies: [dep("n"), dep("m")] });
    assert.equal(one, two);
    assert.notEqual(one, environmentHash({ toolchain: "u", packages: [base, pkg("a"), pkg("b")], dependencies: [dep("m"), dep("n")] }));
  });
});
