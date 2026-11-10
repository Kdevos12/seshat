import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type HostProfile, type ImplementationFactory, loadCatalog, loadHostProfile, Registry, runContract } from "@seshat/registry";
import { Journal, readEvents } from "@seshat/core";
import { leanSearchFactory, RegistryLeanSearch } from "../src/index.ts";
import { fakeService, json } from "./helpers.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));

const dir = mkdtempSync(join(tmpdir(), "mh-lean-search-"));
const indexFile = join(dir, "index.jsonl");
writeFileSync(
  indexFile,
  ['{"name":"Nat.add_comm","type":"∀ (n m : ℕ), n + m = m + n","doc":"Addition commutes."}', '{"name":"Nat.add_zero","type":"∀ (n : ℕ), n + 0 = n"}', '{"name":"Nat.mul_comm","type":"∀ (n m : ℕ), n * m = m * n"}'].join("\n"),
);

function registryOf(settings: Record<string, string | number>, factory: ImplementationFactory, journal?: Journal): Registry {
  const host: HostProfile = { host: "test", capabilities: { "lean.search": { use: ["search"], settings: { search: settings } } } };
  return new Registry({ catalog, host, factories: { "lean-search": factory }, ...(journal !== undefined ? { journal } : {}) });
}

describe("lean.search as a capability", () => {
  it("answers the names of the local index, through the registry, as a tool run", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "mh-lean-search-j-"));
    const journal = Journal.open(journalDir, "run_test");
    try {
      const registry = registryOf({ index: indexFile }, leanSearchFactory(), journal);
      const found = await new RegistryLeanSearch(registry).search({ query: "add_comm", kind: "name", limit: 3 }, { actor: "test" });
      assert.equal(found?.hits[0]?.name, "Nat.add_comm");
      // An index serves the pattern backend too (goals, by their conclusion).
      assert.deepEqual(found?.used, ["pattern", "local"]);
      const runs = readEvents(join(journalDir, "journal.jsonl")).filter((e) => e.type === "tool_run.started");
      assert.deepEqual(runs.map((e) => (e.data as { capability: string }).capability), ["lean.search"]);
    } finally {
      journal.close();
    }
  });

  it("merges the backends, each name once, and records what failed", async () => {
    const service = fakeService((url) =>
      url.hostname === "remote.example" ? json([{ name: "Nat.add_comm" }, { name: "Remote.only" }]) : new Response("down", { status: 503 }),
    );
    const registry = registryOf({ remoteUrl: "https://remote.example/s", patternUrl: "https://pattern.example/p", index: indexFile }, leanSearchFactory({ fetch: service.fetch }));
    const found = await new RegistryLeanSearch(registry).search({ query: "add_comm", kind: "name", limit: 5 });
    assert.deepEqual(found?.hits.slice(0, 2).map((h) => `${h.backend}:${h.name}`), ["remote:Nat.add_comm", "remote:Remote.only"]);
    assert.ok(found?.hits.some((h) => h.backend === "remote" && h.name === "Remote.only"));
    assert.equal(found?.hits.filter((h) => h.name === "Nat.add_comm").length, 1);
    assert.deepEqual(found?.used, ["remote", "local"]);
    assert.equal(found?.skipped.length, 1);
    assert.equal(found?.skipped[0]?.backend, "pattern");
    assert.match(found?.skipped[0]?.reason ?? "", /HTTP 503/);
  });

  it("a private run sends nothing to a service: the fake server records no request", async () => {
    const service = fakeService(() => json([{ name: "Remote.only" }]));
    const registry = registryOf({ remoteUrl: "https://remote.example/s", patternUrl: "https://pattern.example/p", index: indexFile }, leanSearchFactory({ fetch: service.fetch }));
    const found = await new RegistryLeanSearch(registry).search({ query: "n : ℕ\n⊢ n + 0 = n", kind: "goal", private: true });
    assert.equal(service.requests.length, 0);
    // The pattern backend falls back to the index; the remote one has no such form.
    assert.deepEqual(found?.skipped.map((s) => s.backend), ["remote"]);
    assert.deepEqual(found?.used, ["pattern", "local"]);
    const noIndex = registryOf({ remoteUrl: "https://remote.example/s", patternUrl: "https://pattern.example/p" }, leanSearchFactory({ fetch: service.fetch }));
    const none = await new RegistryLeanSearch(noIndex).search({ query: "x", kind: "name", private: true });
    const reason = "private run: nothing leaves for a third party";
    assert.deepEqual(none, { hits: [], used: [], skipped: [{ backend: "remote", reason }, { backend: "pattern", reason }] });
    assert.ok(found?.hits.every((h) => h.backend === "pattern" || h.backend === "local"));
    // The pattern backend over the index (no address) still answers when it is the local one.
    const local = registryOf({ index: indexFile }, leanSearchFactory({ fetch: service.fetch }));
    const goal = await new RegistryLeanSearch(local).search({ query: "n : ℕ\n⊢ n + 0 = n", kind: "goal", private: true });
    assert.deepEqual(goal?.used, ["pattern", "local"]);
    assert.equal(service.requests.length, 0);
  });

  it("answers nothing, with no error, when no backend is set up; health says so", async () => {
    const registry = registryOf({}, leanSearchFactory());
    assert.deepEqual(await new RegistryLeanSearch(registry).search({ query: "x", kind: "name" }), { hits: [], used: [], skipped: [] });
    const health = await registry.health("lean.search");
    assert.equal(health[0]?.ok, false);
    assert.match(health[0]?.detail ?? "", /no backend is set up/);
  });

  it("refuses a setting it does not know, and a service that is not https", async () => {
    const registry = registryOf({ nonsense: 1 }, leanSearchFactory());
    assert.equal(await new RegistryLeanSearch(registry).search({ query: "x", kind: "name" }), undefined);
    const http = registryOf({ remoteUrl: "http://remote.example/s" }, leanSearchFactory());
    assert.equal(await new RegistryLeanSearch(http).search({ query: "x", kind: "name" }), undefined);
  });

  it("keeps its contract against an index, and is offered by both profiles", async () => {
    const report = await runContract(registryOf({ index: indexFile }, leanSearchFactory()), "lean.search");
    assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => [c.name, c.failures]), []);
    assert.equal(report.passed, 2);
    const standIn: ImplementationFactory = () => ({ invoke: async () => ({}) });
    const factories: Record<string, ImplementationFactory> = {};
    for (const { manifest } of catalog.capabilities.values()) for (const spec of manifest.implementations) if (spec.kind === "inproc") factories[spec.factory] = standIn;
    for (const host of ["local", "server"]) {
      const profile = loadHostProfile(join(REPO, "config", "hosts", `${host}.json`));
      assert.ok(new Registry({ catalog, host: profile, factories, env: {} }).offers("lean.search"), host);
      assert.equal(profile.capabilities["lean.search"]?.optional, true);
    }
  });
});
