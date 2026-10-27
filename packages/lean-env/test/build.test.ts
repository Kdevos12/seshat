import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildEnvironment, type CommandRunner, EnvSpecError, loadEnvSpec, lookupEnvironment, resolveEnvironment, spawnRunner, writeEnvironment } from "../src/index.ts";
import { agreeing, BASE_TOML, envRoot, EXTENDED_TOML, fixtureFetcher } from "./fixtures.ts";

async function resolved(toml: string, name: string) {
  const root = envRoot({ [`${name}.toml`]: toml });
  const spec = loadEnvSpec(name, root);
  const { lock } = await resolveEnvironment(spec, { fetch: fixtureFetcher(agreeing()) });
  const dir = join(root, name);
  writeEnvironment(spec, lock as NonNullable<typeof lock>, dir);
  return { root, dir, hash: (lock as NonNullable<typeof lock>).hash };
}

/** A runner that records the commands and answers from `answer`. */
function fakeLake(answer: (args: string[]) => { code: number | null; output?: string } = () => ({ code: 0 })) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const run: CommandRunner = async (command, args, { cwd, onLine }) => {
    calls.push({ command, args: [...args], cwd });
    onLine?.(`ran ${args.join(" ")}`);
    const { code, output } = answer([...args]);
    return { code, output: output ?? "" };
  };
  return { run, calls };
}

describe("building an environment", () => {
  it("updates Lake, gets the Mathlib cache, then builds each library of each package in order, timing each package", async () => {
    const { root, dir, hash } = await resolved(EXTENDED_TOML, "extended");
    const lake = fakeLake();
    let t = 0;
    const log: string[] = [];
    const report = await buildEnvironment("extended", { root, run: lake.run, now: () => (t += 1000), log: (l) => log.push(l) });
    assert.equal(report.ok, true);
    assert.deepEqual(lake.calls.map((c) => c.args.join(" ")), [
      "update",
      "exe cache get",
      "build formal_conjectures/FormalConjectures",
      "build Duper/Duper",
      "build PFR/PFR",
    ]);
    assert.ok(lake.calls.every((c) => c.command === "lake" && c.cwd === dir));
    assert.deepEqual(report.perPackage, [
      { package: null, ms: 2000 },
      { package: "formal_conjectures", ms: 1000 },
      { package: "Duper", ms: 1000 },
      { package: "PFR", ms: 1000 },
    ]);
    assert.equal(report.hash, hash);
    assert.ok(log.some((l) => l.includes("lake build Duper/Duper")) && log.some((l) => l.includes("ran exe cache get")));
    const stamp = JSON.parse(readFileSync(join(dir, "lean-env.build.json"), "utf8")) as { hash: string };
    assert.equal(stamp.hash, hash);
    assert.equal(lookupEnvironment("extended", { root }).built, true);
  });

  it("does not update Lake when it has resolved the project, and skips the cache when Mathlib is no dependency", async () => {
    const { root, dir } = await resolved(BASE_TOML, "base");
    writeFileSync(join(dir, "lake-manifest.json"), "{}");
    const lake = fakeLake();
    await buildEnvironment("base", { root, run: lake.run, lake: "/opt/elan/bin/lake" });
    assert.deepEqual(lake.calls.map((c) => `${c.command} ${c.args.join(" ")}`), [
      "/opt/elan/bin/lake exe cache get",
      "/opt/elan/bin/lake build formal_conjectures/FormalConjectures",
    ]);
    const noMathlib = envRoot({ "base.toml": BASE_TOML });
    const spec = loadEnvSpec("base", noMathlib);
    const files = agreeing();
    const key = Object.keys(files)[0] as string;
    (files[key] as { manifest: string }).manifest = JSON.stringify({ name: "formal_conjectures", packages: [] });
    const { lock } = await resolveEnvironment(spec, { fetch: fixtureFetcher(files) });
    writeEnvironment(spec, lock as NonNullable<typeof lock>, join(noMathlib, "base"));
    const second = fakeLake();
    await buildEnvironment("base", { root: noMathlib, run: second.run });
    assert.deepEqual(second.calls.map((c) => c.args.join(" ")), ["update", "build formal_conjectures/FormalConjectures"]);
  });

  it("stops at the first command that fails, says which and what it printed, and writes no stamp", async () => {
    const { root, dir } = await resolved(EXTENDED_TOML, "extended");
    const lake = fakeLake((args) => (args[1] === "Duper/Duper" ? { code: 1, output: "error: Duper.lean:3: unknown tactic\n" } : { code: 0 }));
    const report = await buildEnvironment("extended", { root, run: lake.run });
    assert.equal(report.ok, false);
    assert.match(report.failure ?? "", /^lake build Duper\/Duper exited with 1:\nerror: Duper\.lean:3: unknown tactic$/);
    assert.equal(lake.calls.length, 4, "PFR is not built");
    assert.equal(report.steps.at(-1)?.ok, false);
    assert.ok(!existsSync(join(dir, "lean-env.build.json")));
    assert.equal(lookupEnvironment("extended", { root }).built, false);
    const missing = fakeLake(() => ({ code: null, output: "spawn lake ENOENT" }));
    const none = await buildEnvironment("extended", { root, run: missing.run });
    assert.match(none.failure ?? "", /^lake update did not run:\nspawn lake ENOENT$/);
  });

  it("refuses an environment that is not resolved, or whose file changed since", async () => {
    const root = envRoot({ "base.toml": BASE_TOML });
    await assert.rejects(buildEnvironment("base", { root, run: fakeLake().run }), (e: Error) => e instanceof EnvSpecError && /cannot be built.*run harness lean-env resolve base/.test(e.message));
    const { root: root2 } = await resolved(BASE_TOML, "base");
    writeFileSync(join(root2, "base.toml"), BASE_TOML.replace("bench-v1-lean4.27.0", "main"));
    await assert.rejects(buildEnvironment("base", { root: root2, run: fakeLake().run }), /changed since it was resolved/);
  });
});

describe("spawnRunner", () => {
  it("runs a program, streams its lines and keeps the end of its output", async () => {
    const lines: string[] = [];
    const result = await spawnRunner(process.execPath, ["-e", 'console.log("one"); console.error("two"); process.exit(3)'], { cwd: process.cwd(), onLine: (l) => lines.push(l) });
    assert.equal(result.code, 3);
    assert.deepEqual(lines.sort(), ["one", "two"]);
    assert.match(result.output, /one/);
    const absent = await spawnRunner("/nonexistent/lake", ["build"], { cwd: process.cwd() });
    assert.equal(absent.code, null);
    assert.match(absent.output, /ENOENT/);
  });
});
