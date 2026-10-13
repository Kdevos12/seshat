import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityError, loadCatalog, Registry, type HostProfile } from "@math-harness/registry";
import { KiminaChecker, kiminaFactory } from "../src/index.ts";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: Array<(body: { snippets: Array<{ id: string; code: string }> }) => Response | Error>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as (typeof replies)[number];
    const result = reply(JSON.parse(String(init?.body ?? "{}")));
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const noSleep = async () => {};

describe("KiminaChecker", () => {
  it("sends the snippets with the key and maps every kind of answer", async () => {
    const { fn, calls } = fakeFetch([
      () =>
        json({
          results: [
            { id: "ok", time: 0.5, response: { messages: [{ severity: "info", pos: { line: 9, column: 0 }, endPos: null, data: "'t' depends on axioms: [propext]" }] } },
            { id: "sorry", time: 0.1, response: { messages: [{ severity: "warning", pos: { line: 1, column: 8 }, data: "declaration uses 'sorry'" }], sorries: [{ pos: { line: 1, column: 20 }, endPos: { line: 1, column: 25 }, goal: "⊢ True" }] } },
            { id: "err", time: 0.2, response: { messages: [{ severity: "error", pos: { line: 2, column: 2 }, endPos: { line: 2, column: 7 }, data: "unknown identifier 'foo'" }] } },
            { id: "repl", time: 0, response: { message: "Lean error: invalid header" } },
            { id: "slow", time: 60, error: "Lean REPL command timed out in 60 seconds" },
            { id: "down", time: 0, error: "REPL process died" },
          ],
        }),
    ]);
    const checker = new KiminaChecker({ url: "http://lean:8000/", apiKey: "k", fetch: fn });
    const ids = ["ok", "sorry", "err", "repl", "slow", "down", "lost"];
    const results = await checker.check(ids.map((id) => ({ id, code: `import Mathlib\n-- ${id}` })), { timeoutSec: 60 });

    assert.equal(calls[0]?.url, "http://lean:8000/api/check");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer k");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual({ ...sent, snippets: sent.snippets.length }, { snippets: 7, timeout: 60, debug: false, reuse: true });

    assert.deepEqual(results.map((r) => [r.id, r.status]), [
      ["ok", "valid"], ["sorry", "sorry"], ["err", "lean_error"], ["repl", "repl_error"],
      ["slow", "timeout"], ["down", "server_error"], ["lost", "server_error"],
    ]);
    assert.deepEqual(results[0]?.messages, [{ severity: "info", pos: { line: 9, column: 0 }, text: "'t' depends on axioms: [propext]" }]);
    assert.deepEqual(results[1]?.sorries, [{ pos: { line: 1, column: 20 }, endPos: { line: 1, column: 25 }, goal: "⊢ True" }]);
    assert.equal(results[0]?.timeMs, 500);
    assert.equal(results[3]?.error, "Lean error: invalid header");
    assert.equal(results[6]?.error, "no result for this snippet");
  });

  it("retries when no REPL is free or the network fails, then reports the failure", async () => {
    const answer = () => json({ results: [{ id: "a", time: 0.1, response: { messages: [] } }] });
    const flaky = fakeFetch([() => json({ detail: "No available REPLs" }, 429), () => new Error("ECONNRESET"), answer]);
    const results = await new KiminaChecker({ fetch: flaky.fn, sleep: noSleep }).check([{ id: "a", code: "def x := 1" }]);
    assert.equal(results[0]?.status, "valid");
    assert.equal(flaky.calls.length, 3);

    const down = fakeFetch([() => json({ detail: "boom" }, 500)]);
    const failed = await new KiminaChecker({ fetch: down.fn, sleep: noSleep, retries: 2 }).check([{ id: "a", code: "x" }]);
    assert.equal(down.calls.length, 3);
    assert.equal(failed[0]?.status, "server_error");
    assert.match(failed[0]?.error ?? "", /HTTP 500/);
  });

  it("does not retry a refused request", async () => {
    const refused = fakeFetch([() => json({ detail: "Invalid API key" }, 401)]);
    const results = await new KiminaChecker({ fetch: refused.fn, sleep: noSleep }).check([{ id: "a", code: "x" }]);
    assert.equal(refused.calls.length, 1);
    assert.match(results[0]?.error ?? "", /HTTP 401: .*Invalid API key/);
  });

  it("refuses duplicate snippet ids", async () => {
    await assert.rejects(new KiminaChecker({ fetch: fakeFetch([]).fn }).check([{ id: "a", code: "" }, { id: "a", code: "" }]), /unique/);
  });
});

describe("kiminaFactory", () => {
  const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
  const host = (settings: Record<string, unknown>): HostProfile => ({
    host: "test",
    capabilities: { "lean.check": { use: ["kimina"], settings: { kimina: settings as never } } },
  });

  it("provides lean.check with the host's settings and the pinned version", async () => {
    const { fn, calls } = fakeFetch([() => json({ results: [{ id: "a", time: 0.1, response: { messages: [] } }] })]);
    const registry = new Registry({
      catalog,
      host: host({ url: "http://lean:9000", apiKey: "${env:LEAN_KEY:-}", timeoutSec: 30 }),
      factories: { kimina: kiminaFactory({ fetch: fn, sleep: noSleep }) },
      env: {},
    });
    const run = await registry.invoke("lean.check", { snippets: [{ id: "a", code: "def x := 1" }] });
    assert.deepEqual(run.output, { results: [{ id: "a", status: "valid", messages: [], sorries: [], timeMs: 100 }] });
    assert.equal(run.version, "fb2393de+lean-v4.27.0+fc-bench-v1");
    assert.equal(calls[0]?.url, "http://lean:9000/api/check");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(JSON.parse(String(calls[0]?.init.body)).timeout, 30);
  });

  it("refuses settings it does not know", async () => {
    const registry = new Registry({ catalog, host: host({ url: "http://lean:9000", port: 8000 }), factories: { kimina: kiminaFactory() } });
    await assert.rejects(
      registry.invoke("lean.check", { snippets: [{ id: "a", code: "x" }] }),
      (error: unknown) => error instanceof CapabilityError && error.code === "unavailable" && /settings: unexpected property "port"/.test(error.message),
    );
  });
});

// Against a real server: LEAN_SERVER_API_URL=http://... pnpm test
describe("KiminaChecker against a live server", { skip: !process.env.LEAN_SERVER_API_URL }, () => {
  it("checks a small Mathlib proof", async () => {
    const checker = new KiminaChecker();
    assert.ok(await checker.health());
    const [result] = await checker.check([{ id: "live", code: "import Mathlib\n\ntheorem t : (2 : ℕ) + 2 = 4 := by norm_num\n\n#print axioms t\n" }]);
    assert.equal(result?.status, "valid");
    assert.ok(result?.messages.some((m) => /depends on axioms|does not depend on any axioms/.test(m.text)));
  });
});
