import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadHostProfile } from "@seshat/registry";
import { doctor, type DoctorSystem, renderDoctor, REPO_ROOT, STUDENT_DEFAULT_MAX_USD, cheapestModel, checkAllowance, studentConfig, STUDENT_LINES } from "../src/index.ts";
import { fauxModels, tempDir } from "./m0-helpers.ts";

/** A machine described by what it has: commands on PATH, the answers of its servers. */
function machine(o: { has?: string[]; fails?: string[]; http?: (url: string) => { status: number } | { error: string }; env?: Record<string, string> } = {}): DoctorSystem {
  const has = new Set(o.has ?? []);
  const fails = new Set(o.fails ?? []);
  return {
    env: o.env ?? {},
    which: (c) => (has.has(c) ? `/usr/bin/${c}` : undefined),
    run: async (c, args) => (fails.has(c) || fails.has(`${c} ${args[0]}`) ? { code: 1, stdout: "", stderr: `${c}: failed` } : { code: 0, stdout: "Lake version 5\n", stderr: "" }),
    http: async (url) => (o.http ?? (() => ({ status: 200 })))(url),
    ids: () => ({ uid: 1000, gid: 1000 }),
  };
}

function config(): string {
  const dir = tempDir("mh-doctor-");
  mkdirSync(join(dir, "hosts"), { recursive: true });
  cpSync(join(REPO_ROOT, "config", "hosts", "local.json"), join(dir, "hosts", "local.json"));
  return dir;
}

async function run(system: DoctorSystem, extra: { leanProject?: string | undefined; write?: "auto" | "rewrite" | "never"; model?: string; price?: number | null } = {}) {
  const dir = config();
  const { models, name } = fauxModels(extra.price ?? 3);
  const report = await doctor({
    system,
    models: extra.price === null ? { ...models, getAvailable: async () => [] } as typeof models : models,
    profile: loadHostProfile(join(dir, "hosts", "local.json")),
    configDir: dir,
    leanProject: "leanProject" in extra ? extra.leanProject : "/lean/project",
    ...(extra.write !== undefined ? { write: extra.write } : {}),
    ...(extra.model !== undefined ? { model: extra.model } : {}),
  });
  return { report, dir, name };
}

const ALL = ["lake", "bwrap", "prlimit"];
const byId = (r: Awaited<ReturnType<typeof run>>["report"], id: string) => r.checks.find((c) => c.id === id)!;

describe("harness doctor", () => {
  it("finds nothing missing on a complete machine and writes the isolation profile", async () => {
    const { report, dir } = await run(machine({ has: ALL }));
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((c) => c.status), ["ok", "ok", "ok", "ok", "ok", "ok"]);
    assert.equal(report.isolation?.written, true);
    const profile = JSON.parse(readFileSync(join(dir, "hosts", "sandboxed.json"), "utf8"));
    const lake = profile.capabilities["lean.certify"].settings.lake;
    assert.equal(lake.sandbox[0], "prlimit");
    assert.ok(lake.sandbox.includes("bwrap") && lake.sandbox.includes("--unshare-net"));
    assert.equal(lake.unsandboxed, undefined);
    assert.equal(profile.host, "sandboxed");
    loadHostProfile(join(dir, "hosts", "sandboxed.json"));
    assert.match(renderDoctor(report).join("\n"), /Everything a run needs is here/);
  });

  it("says how to install Lean when lake is missing, and when there is no project", async () => {
    const none = await run(machine({ has: ["bwrap", "prlimit"] }));
    assert.equal(byId(none.report, "lean").status, "missing");
    assert.match(byId(none.report, "lean").detail, /no `lake`/);
    assert.match(byId(none.report, "lean").fix ?? "", /elan/);
    assert.equal(none.report.ok, false);
    const noProject = await run(machine({ has: ALL }), { leanProject: undefined });
    assert.match(byId(noProject.report, "lean").fix ?? "", /lean-env build/);
  });

  it("says what is wrong with the Kimina server: nothing answering, a key wanted, a wrong answer", async () => {
    const down = await run(machine({ has: ALL, http: (u) => (u.endsWith("/health") ? { error: "ECONNREFUSED" } : { status: 200 }) }));
    assert.equal(byId(down.report, "kimina").status, "missing");
    assert.match(byId(down.report, "kimina").detail, /ECONNREFUSED/);
    const key = await run(machine({ has: ALL, http: (u) => (u.endsWith("/health") ? { status: 401 } : { status: 200 }) }));
    assert.match(byId(key.report, "kimina").fix ?? "", /LEAN_SERVER_API_KEY/);
    const odd = await run(machine({ has: ALL, http: (u) => (u.endsWith("/health") ? { status: 500 } : { status: 200 }) }));
    assert.equal(byId(odd.report, "kimina").status, "missing");
  });

  it("reports missing credentials, an unknown model, and an unpriced model", async () => {
    const none = await run(machine({ has: ALL }), { price: null });
    assert.equal(byId(none.report, "credentials").status, "missing");
    assert.match(byId(none.report, "credentials").fix ?? "", /API key/);
    assert.equal(byId(none.report, "network").status, "warn");
    const unknown = await run(machine({ has: ALL }), { model: "nobody/nothing" });
    assert.equal(byId(unknown.report, "prices").status, "missing");
    const free = await run(machine({ has: ALL }), { price: 0.0000001 });
    // Priced at a fraction of a cent per million is still a price; a zero price is the unpriced case.
    assert.equal(byId(free.report, "prices").status, "ok");
  });

  it("reports an unpriced model as missing", async () => {
    const dir = config();
    const { models, name } = fauxModels(0);
    const report = await doctor({ system: machine({ has: ALL }), models, profile: loadHostProfile(join(dir, "hosts", "local.json")), configDir: dir, leanProject: "/p", model: name });
    assert.equal(byId(report, "prices").status, "missing");
    assert.match(byId(report, "prices").detail, /no price/);
    assert.equal(report.ok, false);
  });

  it("reports an unreachable provider", async () => {
    const { report, name } = await run(machine({ has: ALL, http: (u) => (u.endsWith("/health") ? { status: 200 } : { error: "ENOTFOUND" }) }));
    assert.equal(byId(report, "network").status, "missing");
    assert.match(byId(report, "network").detail, /ENOTFOUND/);
    assert.ok(name.length > 0);
  });

  it("writes no profile and says results stay computed when there is no isolation", async () => {
    const { report, dir } = await run(machine({ has: ["lake"] }));
    const c = byId(report, "isolation");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /stays? `computed`/);
    assert.equal(report.ok, true, "a missing isolation does not stop a run");
    assert.equal(existsSync(join(dir, "hosts", "sandboxed.json")), false);
    assert.equal(report.isolation, undefined);
    assert.match(renderDoctor(report).join("\n"), /can only reach `computed`/);
  });

  it("does not trust bubblewrap that cannot make a sandbox, and falls back on nothing", async () => {
    const { report, dir } = await run(machine({ has: ALL, fails: ["bwrap"] }));
    assert.equal(byId(report, "isolation").status, "warn");
    assert.match(byId(report, "isolation").detail, /cannot make a sandbox/);
    assert.equal(existsSync(join(dir, "hosts", "sandboxed.json")), false);
  });

  it("uses Docker when bubblewrap is absent and the image exists; says so when it does not", async () => {
    const ok = await run(machine({ has: ["lake", "docker"] }));
    assert.equal(ok.report.isolation?.tool, "docker");
    const profile = JSON.parse(readFileSync(join(ok.dir, "hosts", "sandboxed.json"), "utf8"));
    const lake = profile.capabilities["lean.certify"].settings.lake;
    assert.ok(lake.sandbox.includes("--network") && lake.sandbox.includes("none"));
    assert.ok(lake.sandbox.includes("1000:1000"));
    assert.equal(lake.unsandboxed, undefined);
    const noImage = await run(machine({ has: ["lake", "docker"], fails: ["docker image"] }));
    assert.match(byId(noImage.report, "isolation").detail, /image/);
    assert.equal(existsSync(join(noImage.dir, "hosts", "sandboxed.json")), false);
    const noDaemon = await run(machine({ has: ["lake", "docker"], fails: ["docker info"] }));
    assert.match(byId(noDaemon.report, "isolation").detail, /daemon/);
  });

  it("never overwrites an existing profile unless asked, and writes nothing with write never", async () => {
    const first = await run(machine({ has: ALL }), { write: "never" });
    assert.equal(first.report.isolation?.written, false);
    assert.equal(existsSync(join(first.dir, "hosts", "sandboxed.json")), false);
    const dir = config();
    writeFileSync(join(dir, "hosts", "sandboxed.json"), "{\"mine\":true}\n");
    const { models } = fauxModels();
    const profile = loadHostProfile(join(dir, "hosts", "local.json"));
    const again = await doctor({ system: machine({ has: ALL }), models, profile, configDir: dir, leanProject: "/p" });
    assert.equal(again.isolation?.written, false);
    assert.equal(readFileSync(join(dir, "hosts", "sandboxed.json"), "utf8"), "{\"mine\":true}\n");
    const rewritten = await doctor({ system: machine({ has: ALL }), models, profile, configDir: dir, leanProject: "/p", write: "rewrite" });
    assert.equal(rewritten.isolation?.written, true);
    assert.equal(JSON.parse(readFileSync(join(dir, "hosts", "sandboxed.json"), "utf8")).host, "sandboxed");
  });

  it("does not turn an unsandboxed choice into isolation, and leaves a sandboxed profile alone", async () => {
    const dir = config();
    const path = join(dir, "hosts", "local.json");
    const base = JSON.parse(readFileSync(path, "utf8"));
    base.capabilities["lean.certify"].settings.lake.unsandboxed = true;
    writeFileSync(path, JSON.stringify(base));
    const { models } = fauxModels();
    const r = await doctor({ system: machine({ has: ALL }), models, profile: loadHostProfile(path), configDir: dir, leanProject: "/p" });
    assert.equal(byId(r, "isolation").status, "warn");
    assert.match(byId(r, "isolation").detail, /You chose that/);
    assert.equal(existsSync(join(dir, "hosts", "sandboxed.json")), false);
    base.capabilities["lean.certify"].settings.lake = { sandbox: ["bwrap", "--"] };
    writeFileSync(path, JSON.stringify(base));
    const s = await doctor({ system: machine({ has: ALL }), models, profile: loadHostProfile(path), configDir: dir, leanProject: "/p" });
    assert.match(byId(s, "isolation").detail, /behind `bwrap`/);
  });
});

describe("student defaults", () => {
  it("picks the cheapest priced model and leaves the unpriced out", async () => {
    const { models, name } = fauxModels(3, ["zdear"]);
    const choice = await cheapestModel(models);
    assert.ok(choice !== undefined);
    assert.equal(choice.name, name);
    assert.equal(choice.others.length, 1);
    const free = fauxModels(0);
    assert.equal(await cheapestModel(free.models), undefined);
  });

  it("builds a capped, gated, probe-first, consortium configuration", () => {
    const c = studentConfig({ selection: { kind: "all" }, model: "p/m", maxUsd: STUDENT_DEFAULT_MAX_USD });
    assert.deepEqual(c.budget, { problemUsd: 2, runUsd: 2 });
    assert.deepEqual(c.gate, {});
    assert.deepEqual(c.lines, [...STUDENT_LINES]);
    assert.equal(c.consortium?.limit.usd, 1);
    assert.equal(c.consortium?.narrative, false);
    assert.equal(studentConfig({ selection: { kind: "all" }, model: "p/m", maxUsd: 2, turnUsd: 0.25 }).consortium?.limit.usd, 0.25);
    assert.deepEqual(studentConfig({ selection: { kind: "all" }, model: "p/m", maxUsd: 2, lines: [] }).lines, undefined);
  });

  it("refuses a non-positive allowance and a turn above it", () => {
    assert.deepEqual(checkAllowance(2), []);
    assert.equal(checkAllowance(0).length, 1);
    assert.equal(checkAllowance(Number.NaN).length, 1);
    assert.equal(checkAllowance(1, 2).length, 1);
    assert.equal(checkAllowance(1, -1).length, 1);
  });
});
