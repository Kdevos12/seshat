import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { patternBackend, remoteBackend } from "../src/index.ts";
import { fakeService, json } from "./helpers.ts";

// The answers that the probe of 2026-11-12 on the owner's machine recorded (runs/lean-search-probe-1): leansearch.net's body whole, Loogle's
// with the first 25 of its 200 hits, and a Loogle answer with no hit.
// The expectations are constants here, so that a recorded answer can replace a fixture with a change of a line.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/real/${name}`, import.meta.url), "utf8"));
const LEANSEARCH_URL = "https://leansearch.net/search";
const LEANSEARCH_FIRST = ["Choose.choose_modEq_prod_range_choose", "Choose.lucas_theorem_nat", "Choose.choose_modEq_choose_mod_mul_choose_div_nat"];
const LOOGLE_URL = "https://loogle.lean-lang.org/json";
const LOOGLE_FIRST = "Nat.Prime";

describe("the backends against the shapes of the real services", () => {
  it("leansearch.net: the query goes as a list of one text, and the list of hits per query is read", async () => {
    const service = fakeService(() => json(fixture("leansearch.json")));
    const backend = remoteBackend(LEANSEARCH_URL, { fetch: service.fetch }, "list");
    const hits = await backend.search({ query: "Lucas theorem binomial coefficient mod prime", kind: "goal" }, 3);
    assert.deepEqual(hits.map((h) => h.name), LEANSEARCH_FIRST);
    assert.match(hits[1]?.type ?? "", /n\.choose k ≡/);
    assert.match(hits[0]?.doc ?? "", /^For a prime \$ p \$/, "with no docstring, the informal description is the text");
    assert.deepEqual(JSON.parse(service.requests[0]?.body ?? "null"), { query: ["Lucas theorem binomial coefficient mod prime"], num_results: 3 });
  });

  it("leansearch.net: no more hits than the limit", async () => {
    const service = fakeService(() => json(fixture("leansearch.json")));
    const hits = await remoteBackend(LEANSEARCH_URL, { fetch: service.fetch }, "list").search({ query: "x", kind: "goal" }, 2);
    assert.equal(hits.length, 2);
  });

  it("loogle.lean-lang.org: the hits are read and cut to the limit, whatever the service answers", async () => {
    const service = fakeService(() => json(fixture("loogle.json")));
    const backend = patternBackend({ url: LOOGLE_URL, http: { fetch: service.fetch } });
    const hits = (await backend?.search({ query: "n m : ℕ\n⊢ n + m = m + n", kind: "goal" }, 5)) ?? [];
    assert.equal(hits.length, 5);
    assert.equal(hits[0]?.name, LOOGLE_FIRST);
    assert.match(hits[0]?.doc ?? "", /is a prime number/);
    assert.equal(hits[3]?.doc, undefined, "a null doc is no text");
    assert.equal(new URL(service.requests[0]?.url ?? "").searchParams.get("q"), "n + m = m + n");
  });

  it("loogle.lean-lang.org: an answer with no hit is no hit, and its suggestions are not read as declarations", async () => {
    const service = fakeService(() => json(fixture("loogle-empty.json")));
    const backend = patternBackend({ url: LOOGLE_URL, http: { fetch: service.fetch } });
    assert.deepEqual(await backend?.search({ query: "⊢ Nat.choose (2 * n) n % 2 = 0", kind: "goal" }, 5), []);
  });
});
