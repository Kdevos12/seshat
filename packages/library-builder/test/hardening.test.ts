import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { HASH_SKIPPED_DIRS, HASH_SKIPPED_FILE, hashDirectory, spawnRunner, type CommandRunner } from "@seshat/lean-env";
import { MemoryStore } from "@seshat/memory";
import { activeRuns, adoptBuild, BUILD_KIND, type Change, changesFrom, diffViolations, gateEnvironment, gateRunner, type LibraryBuildResult, recordBuild, UNHASHED_SEGMENTS } from "../src/index.ts";
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

describe("what is adopted is what is hashed, and adoption is all or nothing (review I4, M5)", () => {
  it("refuses the paths the environment hash leaves out, and keeps its own list aligned with hashDirectory", () => {
    for (const dir of HASH_SKIPPED_DIRS) assert.ok(UNHASHED_SEGMENTS.has(dir), dir);
    assert.ok(UNHASHED_SEGMENTS.has(HASH_SKIPPED_FILE));
    const add = (path: string): Change => ({ status: "A", path, content: Buffer.from("import Mathlib\n"), executable: false });
    for (const path of ["lean/SeshatLib/Combinatorics/build/X.lean", "lean/SeshatLib/Combinatorics/node_modules/X.lean"]) {
      assert.match(diffViolations([add(path), add("lean/SeshatLib/Combinatorics/Basic.lean")], SPEC, "lean").join(";"), /environment hash does not cover/, path);
    }
    const port = { ...SPEC, job: "port" as const, domain: "Ports", port: { name: "Foo", git: "g", rev: "r", libs: ["Foo"] } };
    assert.match(diffViolations([add("lean/ports/Foo/lake-manifest.json"), add("lean/ports/Foo/Foo.lean")], port, "lean").join(";"), /lake-manifest\.json/);
  });

  it("changes the environment hash of the local package when a build is adopted", async () => {
    const h = harness();
    const result = await h.builder("good").build(SPEC, OPTIONS);
    assert.equal(result.status, "accepted", result.reason);
    const root = mkdtempSync(join(tmpdir(), "mh-lb-hash-"));
    mkdirSync(join(root, "lean/SeshatLib"), { recursive: true });
    writeFileSync(join(root, "lean/SeshatLib/Base.lean"), "import Mathlib\n");
    const before = hashDirectory(join(root, "lean/SeshatLib"));
    adoptBuild(result, { root, runActive: () => false });
    // Every adopted file is under the hashed tree.
    assert.notEqual(hashDirectory(join(root, "lean/SeshatLib")), before);
  });

  it("leaves nothing behind when a file cannot be written", async () => {
    const h = harness();
    const result = await h.builder("good").build(SPEC, OPTIONS);
    const root = mkdtempSync(join(tmpdir(), "mh-lb-atomic-"));
    const two = { ...result, files: [...result.files, { path: "lean/SeshatLib/Combinatorics/Second.lean", content: "import Mathlib\n" }] };
    // The second file's parent is a regular file, so writing it fails after the first was put in place.
    mkdirSync(join(root, "lean/SeshatLib"), { recursive: true });
    writeFileSync(join(root, "lean/SeshatLib/Combinatorics"), "in the way");
    assert.throws(() => adoptBuild(two, { root, runActive: () => false }));
    const sibling = { ...result, files: [{ path: "lean/SeshatLib/A.lean", content: "import Mathlib\n" }, { path: "lean/SeshatLib/Combinatorics/Second.lean", content: "x" }] };
    assert.throws(() => adoptBuild(sibling, { root, runActive: () => false }));
    assert.equal(existsSync(join(root, "lean/SeshatLib/A.lean")), false, "the first file was taken back");
  });

  it("refuses a field name too short for the claim guard to match, rather than half-guarding it", async () => {
    const h = harness();
    const result = await h.builder("short_field").build(SPEC, OPTIONS);
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /shorter than three characters/);
  });

  it("writes nothing when one definition of a build cannot be recorded", async () => {
    const h = harness();
    const result = await h.builder("good").build(SPEC, OPTIONS);
    const dir = mkdtempSync(join(tmpdir(), "mh-lb-rec-"));
    const journal = Journal.open(dir, "run_rec");
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
    const first = result.definitions[0] as NonNullable<(typeof result.definitions)[number]>;
    const doubled = { ...result, definitions: [first, { ...first }] };
    assert.throws(() => recordBuild(memory, doubled), /appears twice/);
    assert.equal(memory.nodes(BUILD_KIND).length, 0);
    assert.equal(memory.definitions().length, 0);
    journal.close();
  });

  it("finds a run whose lock holds a live pid", () => {
    const runs = mkdtempSync(join(tmpdir(), "mh-lb-runs-"));
    mkdirSync(join(runs, "a"));
    mkdirSync(join(runs, "b"));
    writeFileSync(join(runs, "a/journal.jsonl.lock"), String(process.pid));
    writeFileSync(join(runs, "b/journal.jsonl.lock"), "2147483646");
    assert.deepEqual(activeRuns(runs), [join(runs, "a")]);
    assert.deepEqual(activeRuns(join(runs, "missing")), []);
  });
});
