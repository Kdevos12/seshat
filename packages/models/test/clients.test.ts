import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FindStatClient, LmfdbClient, LookupError, lookupSequence, OeisClient, oeisMatches } from "../src/index.ts";

/**
 * The services cannot be reached from here, so these tests answer from files: the answers were
 * written by hand in the shape the sites give, and a real lookup has not been made (see
 * documentation/models.md).
 */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}
const FIBONACCI = [1, 1, 2, 3, 5, 8, 13, 21];

describe("the OEIS client", () => {
  it("asks the JSON search for consecutive terms, and reads the sequences it answers", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("oeis-fibonacci")));
    const oeis = new OeisClient({ fetch, minIntervalMs: 0 });
    const found = await oeis.search(FIBONACCI);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://oeis.org/search?q=1%2C1%2C2%2C3%2C5%2C8%2C13%2C21&fmt=json");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(headers.Accept, "application/json");
    assert.match(headers["User-Agent"] ?? "", /seshat/);
    assert.equal(found.count, 3);
    assert.deepEqual(found.records.map((r) => [r.id, r.offset, r.url, r.keywords.includes("nonn")]), [
      ["A000045", 0, "https://oeis.org/A000045", true],
      ["A212804", 0, "https://oeis.org/A212804", true],
    ]);
    assert.equal(found.records[0]?.name, "Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.");
    assert.deepEqual(found.records[0]?.terms.slice(0, 8), [0n, 1n, 1n, 2n, 3n, 5n, 8n, 13n]);
    assert.equal(found.records[0]?.terms.at(-1), 102334155n);
  });

  it("reads the older answer, a list of sequences, and an answer with no sequence", async () => {
    const list = await new OeisClient({ fetch: fakeFetch(() => json(fixture("oeis-a000045-list"))).fetch, minIntervalMs: 0 }).search(FIBONACCI);
    assert.deepEqual([list.count, list.records.map((r) => r.id)], [1, ["A000045"]]);
    const none = await new OeisClient({ fetch: fakeFetch(() => json(fixture("oeis-none"))).fetch, minIntervalMs: 0 }).search([7, 7, 7, 8, 13, 100, 1]);
    assert.deepEqual([none.count, none.records], [0, []]);
  });

  it("looks a sequence up by its number, and refuses what is not a number", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("oeis-a000045-list")));
    const oeis = new OeisClient({ fetch, minIntervalMs: 0 });
    assert.equal((await oeis.lookup("A000045"))?.name.slice(0, 9), "Fibonacci");
    assert.match(calls[0]?.url ?? "", /search\?q=id%3AA000045&fmt=json$/);
    assert.equal(await oeis.lookup("A000046"), undefined);
    await assert.rejects(async () => oeis.lookup("45"), /not an OEIS number/);
    await assert.rejects(oeis.search([]), /needs terms/);
  });

  it("answers the same request once, and honors a different base address", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("oeis-fibonacci")));
    const oeis = new OeisClient({ fetch, minIntervalMs: 0, baseUrl: "https://mirror.example/oeis/" });
    await oeis.search(FIBONACCI);
    await oeis.search(FIBONACCI);
    await oeis.search([...FIBONACCI, 34]);
    assert.deepEqual(calls.map((c) => c.url.startsWith("https://mirror.example/oeis/search?q=")), [true, true]);
  });

  it("fails with a LookupError when the site does not answer, or answers with something else", async () => {
    const reply = (respond: () => Response | Promise<Response>) => new OeisClient({ fetch: fakeFetch(respond).fetch, minIntervalMs: 0 });
    await assert.rejects(reply(() => json({}, 503)).search(FIBONACCI), (e: unknown) => e instanceof LookupError && /HTTP 503/.test(e.message));
    await assert.rejects(reply(() => new Response("<html>", { status: 200 })).search(FIBONACCI), /the answer is not JSON/);
    await assert.rejects(reply(() => json({ unexpected: true })).search(FIBONACCI), /no list of results/);
    await assert.rejects(reply(() => Promise.reject(new TypeError("fetch failed"))).search(FIBONACCI), (e: unknown) => e instanceof LookupError && /fetch failed/.test(e.message));
  });

  it("gives up at the time limit, and when the caller aborts", async () => {
    const hang = ({ init }: Call) =>
      new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason));
      });
    const slow = new OeisClient({ fetch: fakeFetch(hang).fetch, minIntervalMs: 0, timeoutMs: 30 });
    const started = Date.now();
    await assert.rejects(slow.search(FIBONACCI), LookupError);
    assert.ok(Date.now() - started < 5_000);
    const controller = new AbortController();
    const aborted = new OeisClient({ fetch: fakeFetch(hang).fetch, minIntervalMs: 0, timeoutMs: 60_000 }).search(FIBONACCI, controller.signal);
    controller.abort();
    await assert.rejects(aborted, LookupError);
  });

  it("waits between two requests", async () => {
    const times: number[] = [];
    const { fetch } = fakeFetch(() => (times.push(Date.now()), json(fixture("oeis-none"))));
    const oeis = new OeisClient({ fetch, minIntervalMs: 80 });
    await Promise.all([oeis.search([1, 2, 3, 4]), oeis.search([2, 3, 4, 5]), oeis.search([3, 4, 5, 6])]);
    assert.equal(times.length, 3);
    // A lower bound only: the timers may run late, never early (a few ms of rounding allowed).
    assert.ok((times[1] as number) - (times[0] as number) >= 70 && (times[2] as number) - (times[1] as number) >= 70, times.join(","));
  });
});

describe("the records as matches of a query", () => {
  it("find where the query falls in the terms the site shows", async () => {
    const found = await new OeisClient({ fetch: fakeFetch(() => json(fixture("oeis-fibonacci"))).fetch, minIntervalMs: 0 }).search(FIBONACCI);
    const matches = oeisMatches(FIBONACCI.map(BigInt), found.records);
    assert.deepEqual(matches.map((m) => [m.id, m.source, m.start, m.prefix, m.next]), [
      ["A000045", "oeis", 1, false, [34n, 55n, 89n, 144n, 233n]],
      ["A212804", "oeis", 2, false, [34n, 55n, 89n, 144n, 233n]],
    ]);
    // A query past the terms the site shows has no place in them.
    const beyond = oeisMatches([999n, 1000n], found.records);
    assert.deepEqual(beyond.map((m) => [m.start, m.next]), [[null, []], [null, []]]);
  });
});

describe("recognizing a sequence with the table and the OEIS", () => {
  const oeisThatAnswers = (name: string) => {
    const served = fakeFetch(() => json(fixture(name)));
    return { oeis: new OeisClient({ fetch: served.fetch, minIntervalMs: 0 }), calls: served.calls };
  };

  it("does not ask the OEIS when the table has a strong match", async () => {
    const { oeis, calls } = oeisThatAnswers("oeis-fibonacci");
    const found = await lookupSequence(FIBONACCI, { oeis });
    assert.equal(found.strength, "strong");
    assert.deepEqual(found.matches.map((m) => [m.id, m.source]), [["A000045", "local"]]);
    assert.equal(calls.length, 0);
  });

  it("adds what the OEIS knows when asked to always look, once for each sequence", async () => {
    const { oeis, calls } = oeisThatAnswers("oeis-fibonacci");
    const found = await lookupSequence(FIBONACCI, { oeis }, { always: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(found.matches.map((m) => [m.id, m.source]), [["A000045", "local"], ["A212804", "oeis"]]);
    assert.equal(found.strength, "strong");
    assert.equal(found.note, "the OEIS has 3 sequences with these terms");
  });

  it("asks the OEIS for a short query the table matches weakly, or not at all", async () => {
    const { oeis, calls } = oeisThatAnswers("oeis-none");
    const found = await lookupSequence([7, 7, 7, 8, 13, 100, 1], { oeis });
    assert.equal(calls.length, 1);
    assert.deepEqual([found.matches, found.strength], [[], "none"]);
  });

  it("does not ask for fewer terms than a sequence needs, or without a client", async () => {
    const { oeis, calls } = oeisThatAnswers("oeis-fibonacci");
    const short = await lookupSequence([1, 1, 2], { oeis });
    assert.equal(short.strength, "none");
    assert.equal(calls.length, 0);
    const offline = await lookupSequence([7, 7, 7, 8, 13, 100, 1]);
    assert.equal(offline.strength, "none");
  });

  it("returns the local answer, with a note, when the OEIS does not answer", async () => {
    const down = new OeisClient({ fetch: fakeFetch(() => json({}, 503)).fetch, minIntervalMs: 0 });
    const found = await lookupSequence([2, 4, 6, 8, 10], { oeis: down });
    assert.equal(found.matches[0]?.id, "A005843");
    assert.equal(found.strength, "weak");
    assert.match(found.note ?? "", /the OEIS did not answer \(https:\/\/oeis\.org\/search\?q=2%2C4%2C6%2C8%2C10&fmt=json: HTTP 503\)/);
  });
});

describe("the LMFDB client", () => {
  it("queries a collection by fields, as JSON, and reads the records", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("lmfdb-nf-fields")));
    const lmfdb = new LmfdbClient({ fetch, minIntervalMs: 0 });
    const found = await lmfdb.query("nf_fields", { degree: 2, disc_abs: 5 });
    assert.equal(calls[0]?.url, "https://www.lmfdb.org/api/nf_fields/?degree=2&disc_abs=5&_format=json&_limit=10");
    assert.equal(found.url, calls[0]?.url);
    assert.deepEqual(found.records.map((r) => [r.label, r.degree, r.class_number]), [["2.2.5.1", 2, 1]]);
    await lmfdb.query("nf_fields", { label: "2.2.5.1" }, { limit: 1 });
    assert.match(calls[1]?.url ?? "", /label=2\.2\.5\.1&_format=json&_limit=1$/);
  });

  it("reads a list at the top of the answer, and refuses a name that is not a collection", async () => {
    const lmfdb = new LmfdbClient({ fetch: fakeFetch(() => json([{ label: "x" }, 3, { label: "y" }])).fetch, minIntervalMs: 0 });
    assert.deepEqual((await lmfdb.query("ec_curvedata", { conductor: 11 })).records, [{ label: "x" }, { label: "y" }]);
    await assert.rejects(lmfdb.query("../etc", {}), /not the name of a collection/);
    await assert.rejects(lmfdb.query("a b", {}), /not the name of a collection/);
    const odd = new LmfdbClient({ fetch: fakeFetch(() => json({ nothing: 1 })).fetch, minIntervalMs: 0 });
    await assert.rejects(odd.query("nf_fields", {}), /no list of records/);
  });
});

describe("the FindStat client", () => {
  it("posts objects with their values, and reads the statistics that agree", async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture("findstat-permutations")));
    const findstat = new FindStatClient({ fetch, minIntervalMs: 0 });
    const data: Array<[number[], number]> = [[[1, 2, 3], 0], [[1, 3, 2], 1], [[2, 1, 3], 1], [[3, 2, 1], 3]];
    const found = await findstat.identify("Permutations", data);
    assert.equal(calls[0]?.url, "https://www.findstat.org/StatisticFinder/");
    assert.equal(calls[0]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { collection: "Permutations", data });
    assert.equal((calls[0]?.init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.deepEqual(found.map((m) => [m.id, m.url]), [
      ["St000001", "https://www.findstat.org/StatisticsDatabase/St000001"],
      ["St000018", "https://www.findstat.org/StatisticsDatabase/St000018"],
    ]);
    assert.equal(found[1]?.name, "The number of inversions of a permutation.");
    await assert.rejects(findstat.identify("Permutations", []), /needs objects/);
  });
});
