import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { CommandRunner, Fetcher, PackageFile } from "@seshat/lean-env";
import { leanEnvCommand, type LeanEnvIo } from "../src/lean-env-command.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

const FC = "https://github.com/google-deepmind/formal-conjectures";
const DUPER = "https://github.com/leanprover-community/duper";
const MATHLIB = "a".repeat(40);
const manifest = (name: string, rev = MATHLIB): string =>
  JSON.stringify({ name, packages: [{ name: "mathlib", type: "git", url: "https://github.com/leanprover-community/mathlib4", rev, inputRev: "v4.27.0" }] });

const BASE = `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "formal_conjectures"\ngit = "${FC}"\nrev = "bench-v1-lean4.27.0"\nlean_libs = ["FormalConjectures"]\n`;
const WITH_DUPER = `${BASE}\n[[package]]\nname = "Duper"\ngit = "${DUPER}"\nrev = "v4.27.0"\nlean_libs = ["Duper"]\n`;

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "seshat-lean-env-cmd-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function io(dir: string, remote: Record<string, { toolchain: string; manifest: string }> = {}): LeanEnvIo & { out_: string[]; err_: string[]; lakeCalls: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  const lakeCalls: string[] = [];
  const fetch: Fetcher = async ({ git, rev }, file: PackageFile) => {
    const entry = remote[`${git}@${rev}`];
    return entry === undefined ? undefined : file === "lean-toolchain" ? entry.toolchain : entry.manifest;
  };
  const runner: CommandRunner = async (_command, args) => {
    lakeCalls.push(args.join(" "));
    return { code: 0, output: "" };
  };
  return { root: dir, fetch, run: runner, out: (l) => out_.push(l), err: (l) => err_.push(l), out_, err_, lakeCalls };
}

const REMOTE = {
  [`${FC}@bench-v1-lean4.27.0`]: { toolchain: "leanprover/lean4:v4.27.0\n", manifest: manifest("formal_conjectures") },
  [`${DUPER}@v4.27.0`]: { toolchain: "leanprover/lean4:v4.27.0\n", manifest: manifest("Duper") },
};

describe("harness lean-env", () => {
  it("resolves an environment, writes its project and lock, and says what to run next", async () => {
    const dir = root({ "extended.toml": WITH_DUPER });
    const fake = io(dir, REMOTE);
    assert.equal(await leanEnvCommand("resolve", "extended", {}, fake), 0);
    assert.match(fake.out_.join("\n"), /ok: environment extended, hash [0-9a-f]{64}/);
    assert.match(fake.out_.join("\n"), /2 package\(s\), 1 dependencies \(1 shared, pinned in the lakefile\)/);
    assert.match(fake.out_.join("\n"), /next: harness lean-env build extended/);
    for (const file of ["lakefile.toml", "lean-toolchain", "lean-env.lock.json"]) assert.ok(existsSync(join(dir, "extended", file)), file);
    const shown = io(dir);
    assert.equal(await leanEnvCommand("show", "extended", {}, shown), 0);
    assert.match(shown.out_.join("\n"), /^extended: resolved, hash [0-9a-f]{64}, not built/);
    assert.match(shown.out_.join("\n"), /dep   mathlib aaaaaaaaaa \(Duper, formal_conjectures\)/);
  });

  it("refuses an environment whose packages disagree, writes nothing, and exits with 1", async () => {
    const dir = root({ "extended.toml": WITH_DUPER });
    const fake = io(dir, { ...REMOTE, [`${DUPER}@v4.27.0`]: { toolchain: "leanprover/lean4:v4.27.0\n", manifest: manifest("Duper", "b".repeat(40)) } });
    assert.equal(await leanEnvCommand("resolve", "extended", {}, fake), 1);
    assert.match(fake.err_.join("\n"), /refused: the environment extended is not consistent, and nothing was written/);
    assert.match(fake.err_.join("\n"), /the shared dependency mathlib is not the same everywhere/);
    assert.ok(!existsSync(join(dir, "extended")));
  });

  it("builds a resolved environment with the timings per package, and fails with 1 when lake fails", async () => {
    const dir = root({ "base.toml": BASE });
    const fake = io(dir, REMOTE);
    assert.equal(await leanEnvCommand("build", "base", {}, fake), 2, "an environment that is not resolved is a mistake of the command");
    assert.match(fake.err_.join("\n"), /cannot be built.*harness lean-env resolve base/);
    await leanEnvCommand("resolve", "base", {}, fake);
    const built = io(dir);
    assert.equal(await leanEnvCommand("build", "base", {}, built), 0);
    assert.deepEqual(built.lakeCalls, ["update", "exe cache get", "build formal_conjectures/FormalConjectures"]);
    assert.match(built.out_.join("\n"), /\(update and cache\)\n.*formal_conjectures\nok: environment base built, hash [0-9a-f]{64}/);
    const failing = io(dir);
    failing.run = async () => ({ code: 1, output: "boom" });
    rmSync(join(dir, "base", "lean-env.build.json"), { force: true });
    assert.equal(await leanEnvCommand("build", "base", {}, failing), 1);
    assert.match(failing.err_.join("\n"), /build of base failed: lake update exited with 1:\nboom/);
  });

  it("reports a command that is wrong with the usage, and an unknown environment with the ones there are", async () => {
    const dir = root({ "base.toml": BASE });
    const a = io(dir);
    assert.equal(await leanEnvCommand(undefined, undefined, {}, a), 2);
    assert.match(a.err_.join("\n"), /lean-env needs an action[\s\S]*harness lean-env resolve NAME/);
    assert.equal(await leanEnvCommand("nope", undefined, {}, a), 2);
    assert.equal(await leanEnvCommand("resolve", undefined, {}, io(dir)), 2);
    const b = io(dir);
    assert.equal(await leanEnvCommand("resolve", "missing", {}, b), 2);
    assert.match(b.err_.join("\n"), /no environment missing.*the environments are base/);
    const c = io(dir);
    assert.equal(await leanEnvCommand("show", undefined, {}, c), 0);
    assert.deepEqual(c.out_, ["base: unresolved"]);
  });

  it("runs from the command line against the repository's environments without the network (show)", async () => {
    const { stdout } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "lean-env", "show"]);
    assert.match(stdout, /^base: (unresolved|resolved)/m);
    assert.match(stdout, /^extended: (unresolved|resolved)/m);
    const failed = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "lean-env", "show", "nope"]).catch((e: { code: number; stderr: string; stdout: string }) => e);
    assert.equal((failed as { code: number }).code, 2);
  });
});
