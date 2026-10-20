import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BlobStore, Journal, type Json, readEvents } from "@seshat/core";
import { CapabilityError, type HostProfile, type ImplementationFactory, loadCatalog, loadHostProfile, Registry, runContract } from "@seshat/registry";
import { findstatFactory, lmfdbFactory, LookupError, lookupSequence, OEIS_MAX_TERMS, oeisFactory, RegistryOeis } from "../src/index.ts";
import { type FakeSite, startFakeSite } from "./fake-site.ts";

/**
 * The OEIS, the LMFDB and FindStat as capabilities (capabilities/oeis.search, lmfdb.query,
 * findstat.identify), called through the registry. The sites are not reachable from here: a fake site
 * on this machine answers from the files in fixtures/, and nothing in this file reaches a real one.
 */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));
const FACTORIES = { oeis: oeisFactory(), lmfdb: lmfdbFactory(), findstat: findstatFactory() };
const CAPABILITIES = ["oeis.search", "lmfdb.query", "findstat.identify"] as const;

/** The three factories, and a stand-in for each other in-process factory a manifest names (the host profiles list them all). */
function allFactories(): Record<string, ImplementationFactory> {
  const standIn: ImplementationFactory = () => ({ invoke: async () => ({}) });
  const factories: Record<string, ImplementationFactory> = {};
  for (const { manifest } of catalog.capabilities.values()) {
    for (const spec of manifest.implementations) if (spec.kind === "inproc") factories[spec.factory] = standIn;
  }
  return { ...factories, ...FACTORIES };
}
const FIBONACCI = [1, 1, 2, 3, 5, 8, 13, 21];

/** A host whose three sites are at `url`, with no pause between two requests. */
function hostAt(url: string): HostProfile {
  const site = { baseUrl: url, minIntervalMs: 0 };
  return { host: "test", capabilities: Object.fromEntries(CAPABILITIES.map((id) => [id, { use: ["site"], settings: { site } }])) };
}

function registryAt(url: string, extra: { journal?: Journal; blobs?: BlobStore } = {}): Registry {
  return new Registry({ catalog, host: hostAt(url), factories: FACTORIES, ...extra });
}

const asCapabilityError = (code: CapabilityError["code"], pattern: RegExp) => (error: unknown) =>
  error instanceof CapabilityError && error.code === code && pattern.test([error.message, ...error.details].join("\n"));

describe("the OEIS, the LMFDB and FindStat as capabilities", () => {
  let site: FakeSite;
  before(async () => {
    site = await startFakeSite();
  });
  after(async () => {
    await site.close();
  });

  it("keep their contracts against the answers of the fake site", async () => {
    const passed: Record<string, number> = {};
    for (const id of CAPABILITIES) {
      const report = await runContract(registryAt(site.url), id);
      assert.deepEqual(report.cases.filter((c) => !c.passed).map((c) => [c.name, c.failures]), [], id);
      passed[id] = report.passed;
    }
    assert.deepEqual(passed, { "oeis.search": 5, "lmfdb.query": 3, "findstat.identify": 2 });
  });

  it("are offered by the repository's host profiles, at the address the environment gives", async () => {
    for (const host of ["local", "server"]) {
      const profile = loadHostProfile(join(REPO, "config", "hosts", `${host}.json`));
      const env = { OEIS_URL: site.url, LMFDB_URL: site.url, FINDSTAT_URL: site.url };
      const registry = new Registry({ catalog, host: profile, factories: allFactories(), env });
      for (const id of CAPABILITIES) assert.ok(registry.offers(id), `${host} offers ${id}`);
      const found = await registry.invoke("oeis.search", { id: "A000045" });
      assert.equal(found.implementation, "site");
      assert.equal((found.output as { results: Array<{ id: string }> }).results[0]?.id, "A000045");
      const fields = await registry.invoke("lmfdb.query", { collection: "nf_fields", fields: { degree: 2, disc_abs: 5 } });
      assert.equal((fields.output as { records: unknown[] }).records.length, 1);
      assert.match((fields.output as { url: string }).url, new RegExp(`^${site.url}/api/nf_fields/\\?degree=2&disc_abs=5&_format=json&_limit=10$`));
    }
  });

  it("are tool runs of the journal, with the summary of the answer and the answer itself kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-services-"));
    const journal = Journal.open(dir, "run_test");
    try {
      const blobs = new BlobStore(join(dir, "blobs"));
      const registry = registryAt(site.url, { journal, blobs });
      const result = await registry.invoke("oeis.search", { terms: FIBONACCI }, { actor: "line:M11", attemptId: "att_1" });
      const [started, finished] = readEvents(join(dir, "journal.jsonl")).filter((e) => e.type.startsWith("tool_run."));
      assert.equal(started?.actor, "line:M11");
      const begun = started?.data as Record<string, Json>;
      assert.deepEqual([begun.capability, begun.implementation, begun.version, begun.attemptId], ["oeis.search", "site", "json-search+client-1", "att_1"]);
      assert.deepEqual(blobs.getJson(String(begun.inputHash)), { terms: FIBONACCI });
      const ended = finished?.data as Record<string, Json>;
      assert.equal(ended.outcome, "ok");
      assert.deepEqual(ended.summary, { count: 3 });
      assert.deepEqual(blobs.getJson(String(ended.outputHash)), result.output);
    } finally {
      journal.close();
    }
  });

  it("give the terms as text, so that none is rounded", async () => {
    const registry = registryAt(site.url);
    const result = await registry.invoke("oeis.search", { terms: ["23416728348467685", "37889062373143906", 1] });
    assert.equal((result.output as { count: number }).count, 0);
    assert.match(site.requests.at(-1) ?? "", /q=23416728348467685%2C37889062373143906%2C1&fmt=json$/);
    const found = await registry.invoke("oeis.search", { id: "A000045" });
    const record = (found.output as { results: Array<{ terms: string[]; offset: number }> }).results[0];
    assert.deepEqual(record?.terms.slice(0, 4), ["0", "1", "1", "2"]);
    assert.equal(record?.offset, 0);
  });

  it("refuse an input that breaks a schema, before any request", async () => {
    const registry = registryAt(site.url);
    const before = site.requests.length;
    const refused: Array<[string, Json]> = [
      ["oeis.search", { id: "A12" }],
      ["oeis.search", { terms: [] }],
      ["oeis.search", { terms: [1.5, 2, 3, 4] }],
      ["oeis.search", { terms: ["one"] }],
      ["lmfdb.query", { collection: "nf fields", fields: {} }],
      ["lmfdb.query", { collection: "nf_fields" }],
      ["lmfdb.query", { collection: "nf_fields", fields: { degree: [2] } }],
      ["findstat.identify", { collection: "Permutations", data: [] }],
      ["findstat.identify", { collection: "Permutations", data: [{ object: [1], value: 0.5 }] }],
    ];
    for (const [id, input] of refused) {
      await assert.rejects(registry.invoke(id, input), asCapabilityError("invalid_input", /invalid input/), `${id} ${JSON.stringify(input)}`);
    }
    assert.equal(site.requests.length, before);
  });

  it("tell a site that is down from one that answers with what they cannot read", async () => {
    const down = await startFakeSite({ status: 503 });
    const html = await startFakeSite({ body: "<html>maintenance</html>" });
    try {
      await assert.rejects(registryAt(down.url).invoke("oeis.search", { id: "A000045" }), asCapabilityError("unavailable", /HTTP 503/));
      await assert.rejects(registryAt("http://127.0.0.1:9").invoke("findstat.identify", { collection: "Permutations", data: [{ object: [1], value: 0 }] }), asCapabilityError("unavailable", /ECONNREFUSED|fetch failed/));
      await assert.rejects(registryAt(html.url).invoke("lmfdb.query", { collection: "nf_fields", fields: {} }), asCapabilityError("failed", /the answer is not JSON/));
      // A site that is up and refuses the request (here, a collection it does not have) fails that call only.
      await assert.rejects(registryAt(site.url).invoke("lmfdb.query", { collection: "no_such_collection", fields: {} }), asCapabilityError("failed", /HTTP 404/));
    } finally {
      await down.close();
      await html.close();
    }
  });

  it("refuse a call that says nothing to look up, or two things", async () => {
    const registry = registryAt(site.url);
    await assert.rejects(registry.invoke("oeis.search", {}), asCapabilityError("failed", /terms of a sequence or its number/));
    await assert.rejects(registry.invoke("oeis.search", { id: "A000045", terms: [1, 2, 3, 4] }), asCapabilityError("failed", /one of the two/));
  });

  it("say whether the site answers, when the registry asks for their health", async () => {
    const down = await startFakeSite({ status: 503 });
    try {
      for (const id of CAPABILITIES) {
        const [healthy] = await registryAt(site.url).health(id);
        assert.deepEqual([healthy?.implementation, healthy?.ok], ["site", true], id);
        assert.match(healthy?.detail ?? "", new RegExp(`^${site.url} answers$`));
        const [ill] = await registryAt(down.url).health(id);
        assert.equal(ill?.ok, false, id);
        assert.match(ill?.detail ?? "", /HTTP 503/);
      }
    } finally {
      await down.close();
    }
  });

  it("make the implementation unavailable, with the setting that is wrong", async () => {
    const host: HostProfile = { host: "test", capabilities: { "oeis.search": { use: ["site"], settings: { site: { baseUrl: "", colour: "red" } } } } };
    const registry = new Registry({ catalog, host, factories: FACTORIES });
    await assert.rejects(registry.invoke("oeis.search", { id: "A000045" }), asCapabilityError("unavailable", /settings\.baseUrl: .*unexpected property "colour"/s));
  });
});

describe("the OEIS through the registry", () => {
  let site: FakeSite;
  before(async () => {
    site = await startFakeSite();
  });
  after(async () => {
    await site.close();
  });

  it("is a source for lookupSequence: terms in, records with their terms as integers out", async () => {
    const oeis = new RegistryOeis(registryAt(site.url));
    const found = await oeis.search(FIBONACCI);
    assert.equal(found.count, 3);
    assert.deepEqual(found.records.map((r) => r.id), ["A000045", "A212804"]);
    assert.deepEqual(found.records[0]?.terms.slice(0, 5), [0n, 1n, 1n, 2n, 3n]);
    assert.equal(found.records[0]?.offset, 0);
    assert.match(found.url, /^http:\/\/127\.0\.0\.1:\d+\/search\?q=1%2C1%2C2%2C3%2C5%2C8%2C13%2C21&fmt=json$/);
    // Terms that are bigints go through whole.
    const big = await oeis.search([23416728348467685n, 37889062373143906n, 61305790721611591n, 99194853094755497n]);
    assert.equal(big.count, 0);
    assert.match(site.requests.at(-1) ?? "", /q=23416728348467685%2C37889062373143906%2C61305790721611591%2C99194853094755497&fmt=json$/);
  });

  it("makes lookupSequence ask the site, with the table's answer and the site's side by side", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-services-"));
    const journal = Journal.open(dir, "run_test");
    try {
      const oeis = new RegistryOeis(registryAt(site.url, { journal }), { actor: "line:M11" });
      const identification = await lookupSequence(FIBONACCI, { oeis }, { always: true });
      assert.deepEqual(identification.matches.map((m) => [m.id, m.source]), [["A000045", "local"], ["A212804", "oeis"]]);
      const runs = readEvents(join(dir, "journal.jsonl")).filter((e) => e.type === "tool_run.started");
      assert.deepEqual(runs.map((e) => [e.actor, (e.data as Record<string, Json>).capability]), [["line:M11", "oeis.search"]]);
      // A sequence the table knows well is not asked for.
      await lookupSequence(FIBONACCI, { oeis });
      assert.equal(readEvents(join(dir, "journal.jsonl")).filter((e) => e.type === "tool_run.started").length, 1);
    } finally {
      journal.close();
    }
  });

  it("turns a site that does not answer, or a host that does not offer it, into a lookup error", async () => {
    const down = await startFakeSite({ status: 503 });
    try {
      await assert.rejects(new RegistryOeis(registryAt(down.url)).search(FIBONACCI), (e: unknown) => e instanceof LookupError && e.unreachable && /oeis\.search: site: .*HTTP 503/.test(e.message));
      const without = new Registry({ catalog, host: { host: "test", capabilities: {} }, factories: FACTORIES });
      await assert.rejects(new RegistryOeis(without).search(FIBONACCI), (e: unknown) => e instanceof LookupError && e.unreachable && /not offered on host test/.test(e.message));
      // lookupSequence goes on with the table's answer and says what happened.
      const identification = await lookupSequence(FIBONACCI, { oeis: new RegistryOeis(registryAt(down.url)) }, { always: true });
      assert.equal(identification.matches[0]?.id, "A000045");
      assert.match(identification.note ?? "", /the OEIS did not answer \(oeis\.search: site: .*HTTP 503\)/);
    } finally {
      await down.close();
    }
  });

  it("asks for the first 100 terms of a longer query, since that is all the capability takes", async () => {
    const manifestLimit = (catalog.capabilities.get("oeis.search")?.manifest.input as { properties: { terms: { maxItems: number } } }).properties.terms.maxItems;
    assert.equal(manifestLimit, 100);
    assert.equal(OEIS_MAX_TERMS, manifestLimit);
    const terms = Array.from({ length: 150 }, (_, i) => i * i + 3 * i + 1);
    const found = await new RegistryOeis(registryAt(site.url)).search(terms);
    assert.equal(found.count, 0);
    const asked = decodeURIComponent(/q=([^&]*)/.exec(site.requests.at(-1) ?? "")?.[1] ?? "").split(",");
    assert.deepEqual(asked, terms.slice(0, manifestLimit).map(String));
    // The lookup as a whole does not fail either, and the answer is about the terms it was given.
    const identification = await lookupSequence(terms, { oeis: new RegistryOeis(registryAt(site.url)) });
    assert.equal(identification.note, undefined);
    assert.equal(identification.query.length, 150);
  });

  it("does not hide an input the capability refuses", async () => {
    const oeis = new RegistryOeis(registryAt(site.url));
    await assert.rejects(oeis.search([]), asCapabilityError("invalid_input", /invalid input for oeis\.search/));
    await assert.rejects(oeis.search([1.5, 2, 3, 4]), /term 0 is 1\.5, not a safe integer/);
  });
});
