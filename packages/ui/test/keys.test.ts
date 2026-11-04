import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { REPO_ROOT } from "@seshat/orchestrator";
import { KeyFileError, KeyStore, redact, validKey } from "../src/index.ts";
import { tempDir } from "../../orchestrator/test/m0-helpers.ts";
import { started, type Started } from "./helpers.ts";

const KEY = "sk-live-ABCDEF0123456789-this-must-never-leave";
const open: Started[] = [];
after(async () => {
  for (const s of open) await s.server.close();
});

/** Every file under a directory, with its text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

describe("the key file", () => {
  it("is written with mode 0600 in a directory with mode 0700, and replaced whole", () => {
    const dir = tempDir("ui-keys-");
    const file = join(dir, "config", "seshat", "keys.json");
    const store = new KeyStore(file);
    assert.deepEqual(store.providers(), []);
    store.set("alpha", "ALPHA_API_KEY", KEY);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "config", "seshat")).mode & 0o777, 0o700);
    store.set("beta", "BETA_API_KEY", `${KEY}-2`);
    assert.equal(statSync(file).mode & 0o777, 0o600, "still after a second write");
    assert.deepEqual(store.env(), { ALPHA_API_KEY: KEY, BETA_API_KEY: `${KEY}-2` });
    assert.equal(store.remove("alpha"), true);
    assert.equal(store.remove("alpha"), false);
    assert.deepEqual(store.providers(), ["beta"]);
    assert.deepEqual(readdirSync(join(dir, "config", "seshat")), ["keys.json"], "no temporary file is left");
  });

  it("refuses to read a file other users can read, a symbolic link, and a path inside the repository", () => {
    const dir = tempDir("ui-keys-");
    const file = join(dir, "keys.json");
    const store = new KeyStore(file);
    store.set("alpha", "ALPHA_API_KEY", KEY);
    chmodSync(file, 0o644);
    assert.throws(() => store.env(), (e) => e instanceof KeyFileError && /chmod 600/.test(e.message) && !e.message.includes(KEY));
    chmodSync(file, 0o600);
    assert.doesNotThrow(() => store.env());
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => new KeyStore(link).providers(), KeyFileError);
    assert.throws(() => new KeyStore(join(REPO_ROOT, "keys.json"), REPO_ROOT), /outside the repository/);
    assert.throws(() => new KeyStore(join(REPO_ROOT, "config", "keys.json"), REPO_ROOT), /outside the repository/);
    assert.doesNotThrow(() => new KeyStore(join(dir, "k.json"), REPO_ROOT));
    writeFileSync(join(dir, "bad.json"), "not json", { mode: 0o600 });
    assert.throws(() => new KeyStore(join(dir, "bad.json")).providers(), KeyFileError);
  });

  it("accepts only a plausible key and hides keys in text", () => {
    assert.equal(validKey(KEY), true);
    for (const bad of ["", "short", "has space in it 12345", "line\nbreak12345", "tab\t12345678", 12345678, undefined, "x".repeat(5000), "é-not-ascii-key"]) assert.equal(validKey(bad), false, String(bad));
    assert.equal(redact(`Authorization: Bearer ${KEY} and again ${KEY}`, [KEY]), "Authorization: Bearer [key hidden] and again [key hidden]");
    assert.equal(redact("nothing here", [KEY]), "nothing here");
  });
});

describe("provider settings through the API", () => {
  it("lists the providers of the library at run time, with no provider named by this package", async () => {
    const s = await started();
    open.push(s);
    const list = (await s.call("GET", "/api/providers")).json().providers as Array<{ id: string; models: number; variable: string | null; stored: boolean }>;
    assert.ok(list.length >= 10, "the library has many providers");
    assert.ok(list.some((p) => p.variable !== null), "most take an API key variable");
    assert.ok(list.every((p) => typeof p.id === "string" && p.stored === false));
    const withModels = list.find((p) => p.models > 0);
    assert.ok(withModels);
    const models = (await s.call("GET", `/api/providers/${withModels.id}/models`)).json().models as Array<{ id: string; name: string; inputPrice: number }>;
    assert.equal(models.length, withModels.models);
    assert.equal(models[0]?.name, `${withModels.id}/${models[0]?.id}`);
    assert.equal((await s.call("GET", "/api/providers/not-a-provider/models")).status, 404);
  });

  it("saves a key to a 0600 file, never sends it back, never logs it, and never writes it into a run", async () => {
    const s = await started();
    open.push(s);
    const providers = (await s.call("GET", "/api/providers")).json().providers as Array<{ id: string; variable: string | null }>;
    const target = providers.find((p) => p.variable !== null);
    assert.ok(target?.variable);

    const saved = await s.call("PUT", `/api/providers/${target.id}/key`, { key: KEY });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json(), { provider: target.id, stored: true });
    assert.equal(statSync(s.keyFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(s.keyFile, "utf8")).keys[target.id].variable, target.variable);

    // Nothing the server says afterwards holds the key.
    const after = (await s.call("GET", "/api/providers")).json().providers as Array<{ id: string; stored: boolean; configured: boolean; source: string | null }>;
    const mine = after.find((p) => p.id === target.id);
    assert.equal(mine?.stored, true);
    assert.equal(mine?.configured, true, "the stored key counts as credentials");
    for (const path of ["/api/providers", `/api/providers/${target.id}/models`, "/api/session", "/api/jobs", "/api/runs", "/api/doctor"]) {
      const r = await s.call("GET", path);
      assert.equal(r.text.includes(KEY), false, path);
    }
    // A bad key, a wrong content type and an unknown provider are refused without echoing the body.
    for (const key of ["short", "has a space in it", `${KEY}\n`, 12345678]) {
      const r = await s.call("PUT", `/api/providers/${target.id}/key`, { key });
      assert.equal(r.status, 400);
      assert.equal(r.text.includes(String(key).trim()) && String(key).trim().length > 8, false);
    }
    assert.equal((await s.call("PUT", `/api/providers/${target.id}/key`, undefined, { "content-type": "text/plain" })).status, 415);
    assert.equal((await s.call("PUT", "/api/providers/unknown/key", { key: KEY })).status, 404);

    // A command receives it through its environment; what it prints is scrubbed; the runs directory holds none of it.
    assert.deepEqual(s.server.keys.env(), { [target.variable]: KEY });
    for (const line of s.logs) assert.equal(line.includes(KEY), false);
    for (const f of filesUnder(s.runsDir)) assert.equal(f.text.includes(KEY), false, f.path);

    const gone = await s.call("DELETE", `/api/providers/${target.id}/key`);
    assert.deepEqual(gone.json(), { provider: target.id, stored: false, removed: true });
    assert.deepEqual(s.server.keys.env(), {});
  });

  it("reports a key file with loose permissions instead of using it", async () => {
    const s = await started();
    open.push(s);
    const providers = (await s.call("GET", "/api/providers")).json().providers as Array<{ id: string; variable: string | null }>;
    const target = providers.find((p) => p.variable !== null);
    assert.ok(target);
    await s.call("PUT", `/api/providers/${target.id}/key`, { key: KEY });
    chmodSync(s.keyFile, 0o644);
    const session = (await s.call("GET", "/api/session")).json();
    assert.equal(session.keyFile.ok, false);
    assert.match(session.keyFile.problem, /chmod 600/);
    assert.equal(JSON.stringify(session).includes(KEY), false);
    const refused = await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 });
    assert.equal(refused.status, 409, "no command starts with keys it cannot trust");
    assert.equal(refused.text.includes(KEY), false);
    mkdirSync(s.runsDir, { recursive: true });
  });
});
