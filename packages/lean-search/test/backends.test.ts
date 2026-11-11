import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conclusionOf, LocalIndex, localBackend, parseHits, parseIndex, patternBackend, remoteBackend, requestJson, serviceUrl, SearchHttpError, tokenize } from "../src/index.ts";
import { fakeService, json } from "./helpers.ts";

const ENTRIES = [
  { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", doc: "Addition of natural numbers is commutative." },
  { name: "Nat.mul_comm", type: "∀ (n m : ℕ), n * m = m * n", doc: "Multiplication is commutative." },
  { name: "List.length_append", type: "(as bs : List α) : (as ++ bs).length = as.length + bs.length" },
  { name: "Nat.add_zero", type: "∀ (n : ℕ), n + 0 = n" },
];
const index = () => new LocalIndex(parseIndex(JSON.stringify(ENTRIES)));

describe("the local index", () => {
  it("ranks by BM25 over the words of the name, the type and the doc string", () => {
    assert.equal(index().search("add comm", 3)[0]?.name, "Nat.add_comm");
    assert.equal(index().search("commutative multiplication", 3)[0]?.name, "Nat.mul_comm");
    assert.deepEqual(index().search("zzzz", 3), []);
  });

  it("reads a JSON array and JSONL, and skips a line that is not a declaration", () => {
    const lines = ['{"name":"A.b","type":"T"}', "not json", '{"name":"bad name"}', '{"type":"no name"}', '{"name":"C.d"}'].join("\n");
    assert.deepEqual(parseIndex(lines).map((d) => d.name), ["A.b", "C.d"]);
    assert.equal(parseIndex(JSON.stringify(ENTRIES)).length, 4);
  });

  it("matches a pattern against the types: every symbol and word, `_` for anything, the shortest type first", () => {
    assert.deepEqual(index().matchPattern("_ + 0 = _", 5).map((d) => d.name), ["Nat.add_zero"]);
    assert.deepEqual(index().matchPattern("?a * ?b = ?b * ?a", 5).map((d) => d.name), ["Nat.mul_comm"]);
    assert.deepEqual(index().matchPattern("_ _ _", 5), []);
    assert.deepEqual(index().matchPattern("∑", 5), []);
  });

  it("tokenizes camelCase, separators and symbols", () => {
    assert.deepEqual(tokenize("Nat.addComm n + 0"), ["nat", "add", "comm", "n", "+", "0"]);
  });
});

describe("the backends", () => {
  it("local: the index answers a query without leaving the machine", async () => {
    const backend = localBackend(index());
    assert.equal(backend.leaves, false);
    assert.equal((await backend.search({ query: "add_comm", kind: "name" }, 2))[0]?.name, "Nat.add_comm");
  });

  it("remote: posts the query to the service and reads its hits, in the shapes services use", async () => {
    const service = fakeService(() => json([[{ result: { name: ["Nat", "add_comm"], signature: "n + m = m + n", informal_description: "commutes" } }], [{ name: "Nat.add_zero" }]]));
    const backend = remoteBackend("https://search.example/api/search", { fetch: service.fetch });
    const hits = await backend.search({ query: "sum commutes", kind: "goal" }, 4);
    assert.deepEqual(hits.map((h) => h.name), ["Nat.add_comm", "Nat.add_zero"]);
    assert.equal(backend.leaves, true);
    assert.deepEqual(service.requests.map((r) => [r.method, r.url, JSON.parse(r.body ?? "null")]), [["POST", "https://search.example/api/search", { query: "sum commutes", num_results: 4 }]]);
  });

  it("pattern: a Loogle-like service gets the pattern in q, a goal by its conclusion", async () => {
    const service = fakeService(() => json({ count: 1, hits: [{ name: "Nat.add_comm", type: "x", doc: "y" }] }));
    const backend = patternBackend({ url: "https://loogle.example/json", http: { fetch: service.fetch } });
    assert.equal(backend?.leaves, true);
    await backend?.search({ query: "n m : ℕ\n⊢ n + m = m + n", kind: "goal" }, 3);
    await backend?.search({ query: "add_comm", kind: "name" }, 3);
    assert.deepEqual(service.requests.map((r) => new URL(r.url).searchParams.get("q")), ["n + m = m + n", '"add_comm"']);
  });

  it("pattern: without an address it matches goals over the local index, and leaves nothing", async () => {
    const backend = patternBackend({ index: index() });
    assert.equal(backend?.leaves, false);
    assert.deepEqual((await backend?.search({ query: "n : ℕ\n⊢ n + 0 = n", kind: "goal" }, 3))?.map((d) => d.name), ["Nat.add_zero"]);
    assert.deepEqual(await backend?.search({ query: "add_zero", kind: "name" }, 3), []);
    assert.equal(patternBackend({}), undefined);
  });

  it("drops what is not a declaration: a bad name, a name with a command in it", () => {
    const hits = parseHits({ hits: [{ name: "ok.name" }, { name: "x\n#eval 1" }, { name: "a b" }, { name: 3 }, "str.ok", { nothing: 1 }, { name: "a..b" }] });
    assert.deepEqual(hits.map((h) => h.name), ["ok.name", "str.ok"]);
    assert.deepEqual(parseHits("nope"), []);
  });

  it("conclusionOf takes what follows the last turnstile", () => {
    assert.equal(conclusionOf("a : ℕ\n⊢ P a\n\nb : ℕ\n⊢   Q  b"), "Q b");
    assert.equal(conclusionOf("x = y"), "x = y");
  });
});

describe("the connection to a service", () => {
  const url = serviceUrl("https://svc.example/q");

  it("refuses an address that is not https, or has credentials", () => {
    assert.throws(() => serviceUrl("http://svc.example/q"), /not https/);
    assert.throws(() => serviceUrl("https://user:pw@svc.example/q"), /user name/);
    assert.throws(() => serviceUrl("nonsense"), /not an address/);
  });

  it("does not follow a redirect", async () => {
    const service = fakeService(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await assert.rejects(requestJson(url, {}, { fetch: service.fetch }), (e: unknown) => e instanceof SearchHttpError && /redirect/.test(e.message));
    assert.equal(service.requests.length, 1);
  });

  it("caps the size of the answer, declared or streamed", async () => {
    const declared = fakeService(() => new Response("[]", { status: 200, headers: { "content-length": "999999" } }));
    await assert.rejects(requestJson(url, {}, { fetch: declared.fetch, maxBytes: 1_000 }), /larger than 1000 bytes/);
    const streamed = fakeService(() => new Response(`[${"1,".repeat(2_000)}1]`, { status: 200 }));
    await assert.rejects(requestJson(url, {}, { fetch: streamed.fetch, maxBytes: 1_000 }), /larger than 1000 bytes/);
  });

  it("gives up after the time limit", async () => {
    const hang = fakeService((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    await assert.rejects(requestJson(url, {}, { fetch: hang.fetch, timeoutMs: 20 }), /no answer within 20 ms/);
  });

  it("refuses an answer that is not JSON, and an error status", async () => {
    await assert.rejects(requestJson(url, {}, { fetch: fakeService(() => new Response("<html>", { status: 200 })).fetch }), /not JSON/);
    await assert.rejects(requestJson(url, {}, { fetch: fakeService(() => new Response("x", { status: 503 })).fetch }), /HTTP 503/);
  });
});
