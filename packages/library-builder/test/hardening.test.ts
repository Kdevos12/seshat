import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnRunner, type CommandRunner } from "@seshat/lean-env";
import { changesFrom, gateEnvironment, gateRunner, type LibraryBuildResult } from "../src/index.ts";
import { fakeRunner, harness, SPEC } from "./fixtures.ts";

const OPTIONS = { budget: { seconds: 60 }, timeoutSec: 60 };
const failedRule = (r: LibraryBuildResult): string | undefined => r.gate.find((c) => !c.ok)?.rule;

describe("how the gate runs git and lake (review C3, I6)", () => {
  it("gives every command of the gate an allowlisted environment, never the harness's own keys", async () => {
    const seen: Array<{ command: string; env: Record<string, string> | undefined; group: boolean | undefined }> = [];
    const base = fakeRunner([]);
    const run: CommandRunner = async (command, args, options) => {
      seen.push({ command, env: options.env as Record<string, string> | undefined, group: options.group });
      return await base(command, args, options);
    };
    const h = harness();
    const parentEnv = { PATH: process.env.PATH, HOME: "/home/someone", ANTHROPIC_API_KEY: "secret-a", GITHUB_TOKEN: "secret-b", ELAN_HOME: "/elan", GIT_DIR: "/elsewhere" };
    const result = await h.builder("good", { run, parentEnv }, {}).build(SPEC, OPTIONS);
    assert.equal(result.status, "accepted", result.reason);
    assert.ok(seen.length >= 4);
    for (const s of seen) {
      assert.ok(s.env !== undefined, `${s.command} got an explicit environment`);
      assert.equal(s.group, true, `${s.command} runs in a process group`);
      for (const bad of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GIT_DIR"]) assert.equal(bad in (s.env as object), false, `${s.command}: ${bad}`);
      assert.notEqual(s.env?.HOME, "/home/someone");
    }
    const lake = seen.find((s) => s.command === "lake");
    assert.equal(lake?.env?.ELAN_HOME, "/elan");
    assert.equal(seen.find((s) => s.command === "git")?.env?.GIT_CONFIG_NOSYSTEM, "1");
  });

  it("runs lake behind the agent's sandbox command, and not git", async () => {
    const calls: Array<[string, string[]]> = [];
    const base: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      return { code: 0, output: "" };
    };
    const run = gateRunner(base, { settings: { agent: "pi", sandbox: ["bwrap", "--unshare-net"] }, home: tmpdir() });
    await run("lake", ["build", "A.B"], { cwd: tmpdir() });
    await run("git", ["status"], { cwd: tmpdir() });
    assert.deepEqual(calls, [["bwrap", ["--unshare-net", "lake", "build", "A.B"]], ["git", ["status"]]]);
  });

  it("does not run lake with neither a sandbox nor an explicit opt-out", async () => {
    let started = false;
    const base: CommandRunner = async () => {
      started = true;
      return { code: 0, output: "" };
    };
    const run = gateRunner(base, { settings: { agent: "pi" }, home: tmpdir() });
    const result = await run("lake", ["build"], { cwd: tmpdir() });
    assert.equal(result.code, null);
    assert.match(result.output, /needs a sandbox command/);
    assert.equal(started, false);
    assert.equal(gateEnvironment({ settings: { agent: "pi" }, home: "/h", parentEnv: { PATH: "/bin", SECRET: "x" }, env: { MATHLIB_CACHE_DIR: "/c" } }, "build").MATHLIB_CACHE_DIR, "/c");
  });

  it("kills the whole process group when a command is aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-lb-pg-"));
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const script = `sleep 300 & echo $! > ${pidFile}; wait`;
    const pending = spawnRunner("sh", ["-c", script], { cwd: dir, signal: controller.signal, group: true });
    for (let i = 0; i < 100; i++) {
      try {
        if (readFileSync(pidFile, "utf8").trim() !== "") break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    controller.abort();
    const result = await pending;
    assert.equal(result.code, null);
    await new Promise((r) => setTimeout(r, 100));
    let alive = true;
    try {
      process.kill(grandchild, 0);
      // A killed process nobody has reaped yet is a zombie, not alive.
      alive = !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${grandchild}/stat`, "utf8"));
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the grandchild is gone");
  });

  it("gives the agent a clone with no remote", async () => {
    const h = harness();
    const result = await h.builder("good").build(SPEC, OPTIONS);
    assert.match(result.provenance.agentOutput ?? "", /remotes: \[\]/);
  });
});

describe("file sizes and names (review I6, M)", () => {
  it("does not read a new file over the cap, and rejects it by its size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-lb-big-"));
    writeFileSync(join(dir, "Big.lean"), Buffer.alloc(2 * 1024 * 1024, 120));
    const changes = changesFrom(dir, new Map(), 1024);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.content, undefined);
    assert.equal(changes[0]?.size, 2 * 1024 * 1024);
    const h = harness();
    const result = await h.builder("huge_file").build(SPEC, OPTIONS);
    assert.equal(failedRule(result), "diff");
    assert.match(result.reason, /Huge\.lean: larger than/);
  });

  it("refuses a path with a look-alike letter", async () => {
    const h = harness();
    const result = await h.builder("odd_name").build(SPEC, OPTIONS);
    assert.equal(failedRule(result), "diff");
    assert.match(result.reason, /has a character outside/);
  });
});
