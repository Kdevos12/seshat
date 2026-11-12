import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog, Registry } from "@seshat/registry";
import { litFactory, type LitSearchOutput } from "../src/index.ts";
import { type FakeLit, startFakeLit } from "./fake-lit.ts";
import { hostAt } from "./helpers.ts";

const catalog = loadCatalog(join(fileURLToPath(new URL("../../../", import.meta.url)), "capabilities"));
const registryAt = (url: string, extra: Record<string, unknown> = {}): Registry => new Registry({ catalog, host: hostAt(url, extra), factories: { lit: litFactory() } });
const ask = async (r: Registry, query = "collatz conjecture", extra: Record<string, unknown> = {}): Promise<LitSearchOutput> => (await r.invoke("lit.search", { query, backends: ["openalex"], ...extra })).output as unknown as LitSearchOutput;
const dirOf = (): string => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lit-cache-"));

describe("the cache of answers", () => {
  let site: FakeLit;
  before(async () => {
    site = await startFakeLit();
  });
  after(async () => {
    await site.close();
  });

  it("answers a second call from the file, without a request, and says so", async () => {
    const cacheDir = dirOf();
    const registry = registryAt(site.url, { cacheDir });
    const before = site.requests.length;
    const first = await ask(registry);
    assert.equal(first.answers[0]?.cached, undefined);
    assert.equal(site.requests.length, before + 1);
    const files = readdirSync(cacheDir);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /^[0-9a-f]{64}\.json$/);
    const stored = JSON.parse(readFileSync(join(cacheDir, files[0] as string), "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), ["body", "fetchedAt", "status"]);
    const second = await ask(registry);
    assert.equal(site.requests.length, before + 1, "no second request");
    assert.equal(second.answers[0]?.cached, true);
    assert.deepEqual(second.hits, first.hits);
  });

  it("fetches again when the file is older than cacheDays", async () => {
    const cacheDir = dirOf();
    const registry = registryAt(site.url, { cacheDir, cacheDays: 1 });
    await ask(registry);
    const file = join(cacheDir, readdirSync(cacheDir)[0] as string);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, fetchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
    utimesSync(file, new Date(), new Date());
    const before = site.requests.length;
    const out = await ask(registry);
    assert.equal(site.requests.length, before + 1);
    assert.equal(out.answers[0]?.cached, undefined);
    assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(file, "utf8")).fetchedAt) < 60_000, "the file was renewed");
  });

  it("does not keep a failure", async () => {
    const down = await startFakeLit({ type: "image/png" });
    try {
      const cacheDir = dirOf();
      const registry = registryAt(down.url, { cacheDir });
      await assert.rejects(ask(registry));
      assert.deepEqual(readdirSync(cacheDir), []);
    } finally {
      await down.close();
    }
  });

  it("gives the raw body only when asked", async () => {
    const registry = registryAt(site.url);
    const plain = await ask(registry);
    assert.equal(plain.answers[0]?.raw, undefined);
    const raw = await ask(registry, "collatz conjecture", { keepRaw: true });
    assert.match(raw.answers[0]?.raw ?? "", /"results"/);
  });
});
