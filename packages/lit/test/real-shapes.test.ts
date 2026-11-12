import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeBackend } from "../src/backends.ts";
import type { BackendId } from "../src/backends.ts";

// The fixtures are the answers the real sites gave on 2026-11-12 to the first probe (documentation/literature.md, "Against the real
// sites"): zbMATH in full, OpenAlex and arXiv cut to their first result. OpenAlex's notice is cut after its second sentence. The arXiv
// answer is the one to the old request (words read as OR), kept to test the parser: its first entry is off-topic, as the probe showed.
const OPENALEX_TITLE = "On conjectures of Graffiti";
const OPENALEX_LINK = "https://doi.org/10.1016/0012-365x(88)90199-9";
const ZB_TITLE = "On one of Graffiti's conjectures (583)";
const ZB_LINK = "https://doi.org/10.1007/BF02457552";
// wordsOf lowercases and drops stop words such as "conjecture"
const ARXIV_AND = "all%3Agraffiti%20AND%20all%3Aindependence%20AND%20all%3Anumber";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", "real", name), "utf8");

interface Call { url: string; headers: Record<string, string> }
function stub(bodies: Array<{ status?: number; body: string; type: string }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchStub = (async (address: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(address), headers: { ...(init?.headers as Record<string, string>) } });
    const answer = bodies[Math.min(i++, bodies.length - 1)] as { status?: number; body: string; type: string };
    return new Response(answer.body, { status: answer.status ?? 200, headers: { "content-type": answer.type } });
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}
const site = (id: BackendId, host: string, extra: Record<string, unknown> = {}) => ({ baseUrl: `https://${host}`, allowedHosts: [host], ...extra });
const fast = { minIntervalMs: 0 };

describe("the shapes of the real answers", () => {
  it("OpenAlex: first hit, empty text, and the site's notice reaches no hit", async () => {
    const { fetch } = stub([{ body: fixture("openalex.json"), type: "application/json" }]);
    const backend = makeBackend("openalex", site("openalex", "api.openalex.org"), { fetch, ...fast });
    const found = await backend?.search("Graffiti conjecture independence number", 3);
    assert.equal(found?.hits[0]?.title, OPENALEX_TITLE);
    assert.equal(found?.hits[0]?.url, OPENALEX_LINK);
    assert.equal(found?.hits[0]?.text, "");
    const notice = ((JSON.parse(fixture("openalex.json")) as { meta: { notice: string } }).meta.notice.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    for (const hit of found?.hits ?? []) for (const w of notice) assert.ok(!`${hit.title} ${hit.text}`.toLowerCase().includes(w), w);
  });

  it("arXiv: the words are joined by AND (at most five), and the entries parse", async () => {
    const { fetch, calls } = stub([{ body: fixture("arxiv.xml"), type: "application/atom+xml" }]);
    const backend = makeBackend("arxiv", site("arxiv", "export.arxiv.org"), { fetch, ...fast });
    const found = await backend?.search("Graffiti conjecture independence number counterexample theorem extra words here", 3);
    assert.ok(calls[0]?.url.includes(ARXIV_AND), calls[0]?.url);
    assert.equal((calls[0]?.url.match(/%20AND%20/g) ?? []).length <= 4, true);
    assert.equal(found?.hits.length, 1);
    assert.equal(found?.hits[0]?.title, "A counterexample to generalizations of the Milnor-Bloch-Kato conjecture");
    assert.equal(found?.hits[0]?.url, "https://arxiv.org/abs/0706.4354v2");
    assert.ok(found?.hits[0]?.text.startsWith("We construct an example of a torus"));
  });

  it("arXiv: a query without words stays as it is", async () => {
    const { fetch, calls } = stub([{ body: fixture("arxiv.xml"), type: "application/atom+xml" }]);
    await makeBackend("arxiv", site("arxiv", "export.arxiv.org"), { fetch, ...fast })?.search("a b", 3);
    assert.ok(calls[0]?.url.includes("all%3Aa%20b"));
  });

  it("zbMATH: the licence placeholder is no text; the keywords are", async () => {
    const { fetch } = stub([{ body: fixture("zbmath.json"), type: "application/json" }]);
    const found = await makeBackend("zbmath", site("zbmath", "api.zbmath.org"), { fetch, ...fast })?.search("graffiti", 3);
    assert.equal(found?.hits[0]?.title, ZB_TITLE);
    assert.equal(found?.hits[0]?.url, ZB_LINK);
    assert.equal(found?.hits[0]?.text, "keywords: edge-independence number; Graffiti conjecture; tree; inverse degree; matching");
    assert.ok(!/unavailable/.test(found?.hits[0]?.text ?? ""));
  });
});

describe("zbMATH's answer to a search without a match", () => {
  it("HTTP 404 is no hit, not a failure; another backend's 404 stays a failure", async () => {
    const none = stub([{ status: 404, body: '{"status":{"status_code":404}}', type: "application/json" }]);
    const found = await makeBackend("zbmath", site("zbmath", "api.zbmath.org"), { fetch: none.fetch, ...fast })?.search("independence number average degree", 3);
    assert.deepEqual(found?.hits, []);
    const other = stub([{ status: 404, body: "{}", type: "application/json" }]);
    await assert.rejects(async () => makeBackend("openalex", site("openalex", "api.openalex.org"), { fetch: other.fetch, ...fast })?.search("graffiti", 3), /HTTP 404/);
  });
});

describe("a key, a pause and one retry", () => {
  const KEY = "sk-test-secret-0123456789";
  const json = '{"data":[{"title":"T","abstract":"A","url":"https://example.org/p"}]}';

  it("sends x-api-key when the named variable is set, and never keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lit-key-"));
    const { fetch, calls } = stub([{ body: json, type: "application/json" }]);
    const setting = site("semantic-scholar", "api.semanticscholar.org", { apiKeyEnv: "S2_KEY" });
    const backend = makeBackend("semantic-scholar", setting, { fetch, ...fast, env: { S2_KEY: KEY }, cache: { dir, days: 1 } });
    const found = await backend?.search("graffiti", 2);
    assert.equal(calls[0]?.headers["x-api-key"], KEY);
    assert.ok(!calls[0]?.url.includes(KEY) && !(found?.url ?? "").includes(KEY) && !(found?.raw ?? "").includes(KEY));
    assert.ok(existsSync(dir));
    for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), "utf8").includes(KEY));
  });

  it("sends no header when the variable is unset or empty, or for another backend", async () => {
    for (const env of [{}, { S2_KEY: "" }]) {
      const { fetch, calls } = stub([{ body: json, type: "application/json" }]);
      await makeBackend("semantic-scholar", site("semantic-scholar", "api.semanticscholar.org", { apiKeyEnv: "S2_KEY" }), { fetch, ...fast, env })?.search("g", 1);
      assert.equal(calls[0]?.headers["x-api-key"], undefined);
    }
    const { fetch, calls } = stub([{ body: fixture("zbmath.json"), type: "application/json" }]);
    await makeBackend("zbmath", site("zbmath", "api.zbmath.org", { apiKeyEnv: "S2_KEY" }), { fetch, ...fast, env: { S2_KEY: KEY } })?.search("g", 1);
    assert.equal(calls[0]?.headers["x-api-key"], undefined);
  });

  it("keeps the key out of an error message", async () => {
    const { fetch } = stub([{ status: 403, body: "no", type: "text/plain" }]);
    const backend = makeBackend("semantic-scholar", site("semantic-scholar", "api.semanticscholar.org", { apiKeyEnv: "S2_KEY" }), { fetch, ...fast, env: { S2_KEY: KEY } });
    await assert.rejects(backend?.search("g", 1) as Promise<unknown>, (e: Error) => /403/.test(e.message) && !e.message.includes(KEY));
  });

  it("waits between two requests of a backend, not for a cache hit, and retries a 429 once", async () => {
    const pauses: number[] = [];
    const sleep = async (ms: number): Promise<void> => void pauses.push(ms);
    const dir = mkdtempSync(join(tmpdir(), "lit-wait-"));
    const { fetch, calls } = stub([{ body: fixture("arxiv.xml"), type: "application/atom+xml" }]);
    const arxiv = makeBackend("arxiv", site("arxiv", "export.arxiv.org", { minIntervalMs: 3000 }), { fetch, sleep, cache: { dir, days: 1 } });
    await arxiv?.search("graffiti one", 2);
    await arxiv?.search("graffiti two", 2);
    await arxiv?.search("graffiti two", 2);
    assert.equal(calls.length, 2);
    assert.equal(pauses.length, 1);
    assert.ok((pauses[0] ?? 0) > 2000 && (pauses[0] ?? 0) <= 3000);

    const retry = stub([{ status: 429, body: "slow", type: "text/plain" }, { body: json, type: "application/json" }]);
    const waits: number[] = [];
    const s2 = makeBackend("semantic-scholar", site("semantic-scholar", "api.semanticscholar.org", { retry429Ms: 2000 }), { fetch: retry.fetch, ...fast, sleep: async (ms) => void waits.push(ms) });
    assert.equal((await s2?.search("g", 1))?.hits.length, 1);
    assert.deepEqual(waits, [2000]);
    const twice = stub([{ status: 429, body: "slow", type: "text/plain" }]);
    const s3 = makeBackend("semantic-scholar", site("semantic-scholar", "api.semanticscholar.org", { retry429Ms: 5 }), { fetch: twice.fetch, ...fast, sleep: async () => undefined });
    await assert.rejects(s3?.search("g", 1) as Promise<unknown>, /429/);
    assert.equal(twice.calls.length, 2);
    const none = stub([{ status: 429, body: "slow", type: "text/plain" }]);
    await assert.rejects(makeBackend("semantic-scholar", site("semantic-scholar", "api.semanticscholar.org"), { fetch: none.fetch, ...fast })?.search("g", 1) as Promise<unknown>, /429/);
    assert.equal(none.calls.length, 1);
  });
});
