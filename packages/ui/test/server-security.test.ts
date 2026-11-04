import assert from "node:assert/strict";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { after, describe, it } from "node:test";
import { raw, started, type Started } from "./helpers.ts";

const open: Started[] = [];
async function server(): Promise<Started> {
  const s = await started();
  open.push(s);
  return s;
}
after(async () => {
  for (const s of open) await s.server.close();
});

describe("the local server's guards", () => {
  it("answers no request to the API without the session token, and sets no cookie", async () => {
    const s = await server();
    const { port, token } = s.server;
    const host = { host: `127.0.0.1:${port}` };
    assert.equal((await raw(port, "/api/session", host)).status, 401, "no token");
    assert.equal((await raw(port, "/api/session", { ...host, authorization: "Bearer wrong" })).status, 401, "wrong token");
    assert.equal((await raw(port, "/api/session", { ...host, authorization: `Bearer ${token}x` })).status, 401, "a token with something added");
    assert.equal((await raw(port, "/api/session", { ...host, cookie: `seshat_session=${token}` })).status, 401, "a cookie is not a credential");
    assert.equal((await raw(port, "/api/session?token=" + token, host)).status, 401, "a token in the query is not a credential");
    assert.equal((await raw(port, "/api/session", { ...host, authorization: `Bearer ${token}` })).status, 200);
    // The page's own files hold nothing of any run, and the token is in the fragment, which is never sent.
    assert.match(s.server.url, /#token=/);
    const page = await fetch(`${s.server.origin}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    assert.equal((await s.call("GET", "/api/session")).headers.get("set-cookie"), null);
    // Nothing that changes anything without the token, even from the right origin.
    assert.equal((await fetch(`${s.server.origin}/api/jobs`, { method: "POST", headers: { origin: s.server.origin, "x-seshat-request": "1", "content-type": "application/json" }, body: "{}" })).status, 401);
  });

  it("keeps two instances apart: the token of one opens nothing of the other", async () => {
    const a = await server();
    const b = await server();
    assert.notEqual(a.server.token, b.server.token);
    assert.equal((await fetch(`${b.server.origin}/api/session`, { headers: { authorization: `Bearer ${a.server.token}` } })).status, 401);
    assert.equal((await fetch(`${a.server.origin}/api/session`, { headers: { authorization: `Bearer ${a.server.token}` } })).status, 200);
    assert.equal((await fetch(`${b.server.origin}/api/session`, { headers: { authorization: `Bearer ${b.server.token}` } })).status, 200);
  });

  it("refuses a Host that is not this server (DNS rebinding) even with the token", async () => {
    const s = await server();
    const { port, token } = s.server;
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await raw(port, "/api/session", { host: "evil.example.com", ...auth })).status, 403);
    assert.equal((await raw(port, "/api/session", { host: `evil.example.com:${port}`, ...auth })).status, 403);
    assert.equal((await raw(port, "/api/session", { host: `127.0.0.1:${port + 1}`, ...auth })).status, 403);
    assert.equal((await raw(port, "/api/session", { host: `localhost:${port}`, ...auth })).status, 200, "localhost is the same machine");
  });

  it("refuses a foreign Origin, a change with no origin, and a change without the request header", async () => {
    const s = await server();
    const { port, token } = s.server;
    const base = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = (extra: Record<string, string>) => raw(port, "/api/providers/x/key", { ...base, ...extra }, "PUT");
    assert.equal((await raw(port, "/api/session", { ...base, origin: "http://evil.example.com" })).status, 403, "a read from another origin");
    assert.equal((await raw(port, "/api/session", { ...base, origin: "null" })).status, 403);
    assert.equal((await post({ "x-seshat-request": "1" })).status, 403, "no origin on a change");
    assert.equal((await post({ origin: `http://127.0.0.1:${port}` })).status, 403, "no request header");
    assert.equal((await post({ origin: "http://evil.example.com", "x-seshat-request": "1" })).status, 403, "foreign origin");
    assert.equal((await post({ "sec-fetch-site": "cross-site", "x-seshat-request": "1" })).status, 403);
    // The right origin and header get past the guards (the provider does not exist, so the route says 404).
    assert.equal((await post({ origin: `http://127.0.0.1:${port}`, "x-seshat-request": "1" })).status, 404);
  });

  it("puts a content security policy and the other headers on every answer, failures included", async () => {
    const s = await server();
    for (const response of [await fetch(`${s.server.origin}/api/session`), await s.call("GET", "/api/session"), await s.call("GET", "/nothing-here")]) {
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  it("puts the policy on the event streams too", async () => {
    const s = await server();
    const controller = new AbortController();
    const response = await fetch(`${s.server.origin}/api/jobs/none/events`, { headers: { authorization: `Bearer ${s.server.token}` }, signal: controller.signal });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(s.runsDir, "r"));
    writeFileSync(join(s.runsDir, "r", "journal.jsonl"), "");
    const stream = await fetch(`${s.server.origin}/api/runs/r/events`, { headers: { authorization: `Bearer ${s.server.token}` }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /event-stream/);
    assert.match(stream.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(stream.headers.get("cache-control"), "no-store");
    controller.abort();
  });

  it("serves only the front end's files, and no path leaves them", async () => {
    const s = await server();
    for (const path of ["/..%2f..%2f..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/../../../etc/passwd", "/%00", "/%E0%A4%A"]) {
      const r = await s.call("GET", path);
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
      assert.doesNotMatch(r.text, /root:/);
    }
    assert.equal((await s.call("GET", "/api/runs/..%2f..%2fetc")).status, 404);
    assert.equal((await s.call("GET", "/api/runs/..")).status, 404);
  });

  it("listens on the loopback address only", async () => {
    const s = await server();
    const foreign = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && i.family === "IPv4" && !i.internal);
    if (foreign === undefined) return; // a machine with no other address has nothing to show
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: foreign.address, port: s.server.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    assert.equal(refused, true, `${foreign.address}:${s.server.port} must refuse`);
  });
});
