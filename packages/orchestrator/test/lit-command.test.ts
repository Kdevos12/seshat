import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { litProbeCommand } from "../src/lit-command.ts";
import { startFakeLit, type FakeLit } from "../../lit/test/fake-lit.ts";
import { tempDir } from "./m0-helpers.ts";

function configAt(urls: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = tempDir("mh-lit-probe-");
  mkdirSync(join(dir, "hosts"), { recursive: true });
  const backends = Object.fromEntries(Object.entries(urls).map(([id, baseUrl]) => [id, { baseUrl, allowedHosts: ["127.0.0.1"] }]));
  writeFileSync(join(dir, "hosts", "probe.json"), JSON.stringify({ host: "probe", capabilities: { "lit.search": { use: ["sources"], settings: { sources: { minIntervalMs: 0, backends, ...extra } } } } }));
  return dir;
}

async function probe(configDir: string, o: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await litProbeCommand({ host: "probe", configDir, query: "collatz conjecture", ...o }, { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  return { code, text: lines.join("\n") };
}

describe("harness lit probe", () => {
  let good: FakeLit;
  let bad: FakeLit;
  before(async () => {
    good = await startFakeLit();
    bad = await startFakeLit({ type: "image/png" });
  });
  after(async () => {
    await good.close();
    await bad.close();
  });

  it("prints what a backend answered and what failed, and exits 0 when one returned hits", async () => {
    const { code, text } = await probe(configAt({ openalex: good.url, arxiv: bad.url }));
    assert.equal(code, 0);
    assert.match(text, /openalex\n {2}asked: .*\/works\?search=collatz%20conjecture/);
    assert.match(text, /1 hit\(s\) parsed/);
    assert.match(text, /first hit: On the Collatz conjecture/);
    assert.match(text, /text: We prove that the conjecture is false/);
    assert.match(text, /arxiv\n {2}error: .*not a text type/);
    assert.match(text, /1 of 2 backend\(s\) returned hits/);
  });

  it("exits 1 when no backend returned hits", async () => {
    assert.equal((await probe(configAt({ arxiv: bad.url }))).code, 1);
    assert.equal((await probe(configAt({ openalex: good.url }), { query: "no such words" })).code, 1);
    assert.equal((await probe(configAt({}))).code, 1);
  });

  it("writes the raw body and the parsed hits of each backend with out", async () => {
    const out = join(tempDir("mh-lit-out-"), "fixtures");
    const { code } = await probe(configAt({ openalex: good.url, arxiv: bad.url }), { out });
    assert.equal(code, 0);
    assert.deepEqual(readdirSync(out).sort(), ["openalex.hits.json", "openalex.raw.txt"]);
    assert.match(readFileSync(join(out, "openalex.raw.txt"), "utf8"), /abstract_inverted_index/);
    assert.equal(JSON.parse(readFileSync(join(out, "openalex.hits.json"), "utf8"))[0].title, "On the Collatz conjecture");
  });

  it("uses the cache unless --no-cache, and makes no model call", async () => {
    const cacheDir = join(tempDir("mh-lit-cache-"), "c");
    const config = configAt({ openalex: good.url }, { cacheDir });
    const n = good.requests.length;
    await probe(config);
    const second = await probe(config);
    assert.equal(good.requests.length, n + 1);
    assert.match(second.text, /from the cache/);
    const third = await probe(config, { noCache: true });
    assert.equal(good.requests.length, n + 2);
    assert.doesNotMatch(third.text, /from the cache/);
    assert.ok(existsSync(cacheDir));
  });
});
