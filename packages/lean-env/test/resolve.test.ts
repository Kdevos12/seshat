import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type EnvSpec, loadEnvSpec, readLock, resolveEnvironment, writeEnvironment } from "../src/index.ts";
import { agreeing, BASE_TOML, batteries, DUPER, envRoot, EXTENDED_TOML, FC, fixtureFetcher, manifest, MATHLIB, mathlib, PFR, TOOLCHAIN } from "./fixtures.ts";

const spec = (toml: string, extra: Record<string, string> = {}): EnvSpec => loadEnvSpec("env", envRoot({ "env.toml": toml, ...extra }));

describe("resolving an environment", () => {
  it("accepts the base project alone, and pins nothing the base project's manifest already pins", async () => {
    const s = spec(BASE_TOML);
    const { lock, problems } = await resolveEnvironment(s, { fetch: fixtureFetcher(agreeing()) });
    assert.deepEqual(problems, []);
    assert.ok(lock);
    assert.match(lock.hash, /^[0-9a-f]{64}$/);
    assert.equal(lock.toolchain, TOOLCHAIN);
    assert.deepEqual(lock.packages.map((p) => [p.name, p.role, p.rev]), [["formal_conjectures", "base", "bench-v1-lean4.27.0"]]);
    assert.deepEqual(lock.dependencies.map((d) => [d.name, d.rev, d.usedBy]), [
      ["aesop", "c".repeat(40), ["formal_conjectures"]],
      ["batteries", "b".repeat(40), ["formal_conjectures"]],
      ["mathlib", MATHLIB, ["formal_conjectures"]],
    ]);
  });

  it("accepts packages that agree, and the lakefile pins the dependencies that several of them list", async () => {
    const s = spec(EXTENDED_TOML);
    const fetch = fixtureFetcher(agreeing());
    const { lock, problems } = await resolveEnvironment(s, { fetch });
    assert.deepEqual(problems, []);
    assert.ok(lock);
    // Two files per package and nothing else.
    assert.equal(fetch.calls.length, 6);
    assert.deepEqual(new Set(fetch.calls.map((c) => c.split(" ")[1])), new Set(["lean-toolchain", "lake-manifest.json"]));
    const dir = join(envRoot({}), "extended");
    const written = writeEnvironment(s, lock, dir);
    assert.deepEqual(written.files.map((f) => f.slice(dir.length + 1)), ["lakefile.toml", "lean-toolchain", "lean-env.lock.json"]);
    const lakefile = readFileSync(join(dir, "lakefile.toml"), "utf8");
    const requires = [...lakefile.matchAll(/\[\[require\]\]\nname = "([^"]+)"/g)].map((m) => m[1]);
    // The three packages, then the dependencies listed by two or more: mathlib and batteries (three), aesop (two).
    assert.deepEqual(requires, ["formal_conjectures", "Duper", "PFR", "aesop", "batteries", "mathlib"]);
    assert.ok(lakefile.includes(`rev = "${MATHLIB}"`));
    assert.ok(lakefile.includes(`git = "${FC}"`) && lakefile.includes('rev = "bench-v1-lean4.27.0"'));
    assert.ok(lakefile.includes(`# Environment hash ${lock.hash}`));
    assert.equal(readFileSync(join(dir, "lean-toolchain"), "utf8"), `${TOOLCHAIN}\n`);
    assert.deepEqual(readLock(dir), lock);
  });

  it("refuses a package on another toolchain, and says which", async () => {
    const files = agreeing();
    files[`${PFR}@v4.27.0`] = { toolchain: "leanprover/lean4:v4.28.0\n", manifest: manifest("PFR", [mathlib()]) };
    const { lock, problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.equal(lock, undefined);
    assert.deepEqual(problems, ["the packages disagree on the toolchain: formal_conjectures uses leanprover/lean4:v4.27.0, Duper uses leanprover/lean4:v4.27.0, PFR uses leanprover/lean4:v4.28.0"]);
  });

  it("refuses packages that agree with each other but not with the toolchain the environment declares", async () => {
    const files = agreeing();
    for (const key of Object.keys(files)) (files[key] as { toolchain: string }).toolchain = "v4.28.0\n";
    const { problems } = await resolveEnvironment(spec(BASE_TOML), { fetch: fixtureFetcher(files) });
    assert.deepEqual(problems, ["formal_conjectures uses the toolchain leanprover/lean4:v4.28.0, the environment declares leanprover/lean4:v4.27.0"]);
  });

  it("refuses a shared dependency at two revisions, naming who wants which", async () => {
    const files = agreeing();
    files[`${DUPER}@v4.27.0`] = { toolchain: TOOLCHAIN, manifest: manifest("Duper", [mathlib("d".repeat(40))]) };
    const { lock, problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.equal(lock, undefined);
    const mathlibProblem = problems.find((p) => p.startsWith("the shared dependency mathlib"));
    assert.ok(mathlibProblem);
    assert.match(mathlibProblem, /formal_conjectures wants a3a10db000/);
    assert.match(mathlibProblem, /Duper wants dddddddddd/);
    assert.match(mathlibProblem, /PFR wants a3a10db000/);
    // Batteries and Aesop agree and are not mentioned.
    assert.equal(problems.length, 1);
  });

  it("refuses a dependency from another repository under the same name", async () => {
    const files = agreeing();
    files[`${DUPER}@v4.27.0`] = {
      toolchain: TOOLCHAIN,
      manifest: manifest("Duper", [{ name: "mathlib", url: "https://github.com/someone/mathlib4-fork.git", rev: MATHLIB }]),
    };
    const { problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.match(problems[0] ?? "", /shared dependency mathlib is not the same everywhere.*Duper wants a3a10db000 of https:\/\/github.com\/someone\/mathlib4-fork\.git/);
  });

  it("takes the same repository however its URL is written", async () => {
    const files = agreeing();
    files[`${DUPER}@v4.27.0`] = {
      toolchain: TOOLCHAIN,
      manifest: manifest("Duper", [{ name: "mathlib", url: "https://GitHub.com/leanprover-community/mathlib4.git", rev: MATHLIB }]),
    };
    const { problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.deepEqual(problems, []);
  });

  it("reports a package that cannot be read and goes on with the others", async () => {
    const files = agreeing();
    delete files[`${PFR}@v4.27.0`];
    const fetch = (async (source, file) => {
      if (source.name === "Duper") throw new Error("connection reset");
      return await fixtureFetcher(files)(source, file);
    }) as Parameters<typeof resolveEnvironment>[1]["fetch"];
    const { problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch });
    assert.deepEqual(problems, [
      `Duper: could not read ${DUPER} at v4.27.0: connection reset`,
      `PFR: ${PFR} has no lean-toolchain at v4.27.0 (does the rev exist?)`,
    ]);
  });

  it("refuses a package with no manifest, a manifest that is not JSON, and a manifest of another package", async () => {
    const files = agreeing();
    files[`${DUPER}@v4.27.0`] = { toolchain: TOOLCHAIN };
    files[`${PFR}@v4.27.0`] = { toolchain: TOOLCHAIN, manifest: "{not json" };
    const { problems } = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.match(problems[0] ?? "", /Duper: .* has no lake-manifest\.json at v4\.27\.0, so its dependencies cannot be compared/);
    assert.match(problems[1] ?? "", /PFR's lake-manifest\.json is not JSON/);
    const wrong = agreeing();
    wrong[`${DUPER}@v4.27.0`] = { toolchain: TOOLCHAIN, manifest: manifest("duper_fork", [mathlib()]) };
    const named = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(wrong) });
    assert.deepEqual(named.problems, ["Duper: its lake-manifest.json names the package duper_fork; use that name in the environment file"]);
  });

  it("needs --find for a package without a rev, and then tries the tag of the toolchain", async () => {
    const toml = `${BASE_TOML}\n[[package]]\nname = "Duper"\ngit = "${DUPER}"\nlean_libs = ["Duper"]\n`;
    const files = agreeing();
    const refused = await resolveEnvironment(spec(toml), { fetch: fixtureFetcher(files) });
    assert.deepEqual(refused.problems, ["Duper has no rev: give one in the environment file, or use --find to try the tag v4.27.0"]);
    const fetch = fixtureFetcher(files);
    const found = await resolveEnvironment(spec(toml), { fetch, find: true });
    assert.deepEqual(found.problems, []);
    assert.ok(fetch.calls.includes(`${DUPER}@v4.27.0 lean-toolchain`));
    assert.equal(found.lock?.packages.find((p) => p.name === "Duper")?.rev, "v4.27.0");
    assert.match(found.notes[0] ?? "", /Duper: no rev in the file, tried the tag v4\.27\.0/);
    // A tag that does not exist is refused.
    const missing = await resolveEnvironment(spec(toml), { fetch: fixtureFetcher({ [`${FC}@bench-v1-lean4.27.0`]: files[`${FC}@bench-v1-lean4.27.0`] as never }), find: true });
    assert.match(missing.problems[0] ?? "", /Duper: .* has no lean-toolchain at v4\.27\.0$/);
  });

  it("compares a package of the environment that another one depends on, through its commit", async () => {
    const duperCommit = "e".repeat(40);
    const files = agreeing();
    files[`${PFR}@v4.27.0`] = {
      toolchain: TOOLCHAIN,
      manifest: manifest("PFR", [mathlib(), batteries(), { name: "Duper", url: DUPER, rev: duperCommit, inputRev: "v4.27.0" }]),
    };
    // The tag the other manifest recorded as its input is the tag the environment uses: they agree.
    const sameTag = await resolveEnvironment(spec(EXTENDED_TOML), { fetch: fixtureFetcher(files) });
    assert.deepEqual(sameTag.problems, []);
    assert.ok(!sameTag.lock?.dependencies.some((d) => d.name === "Duper"), "a package of the environment is not also a dependency");
    // Another tag cannot be compared with a commit: the environment must give the commit.
    const otherTag = EXTENDED_TOML.replace(`git = "${DUPER}"\nrev = "v4.27.0"`, `git = "${DUPER}"\nrev = "v4.27.1"`);
    files[`${DUPER}@v4.27.1`] = files[`${DUPER}@v4.27.0`] as never;
    const undecided = await resolveEnvironment(spec(otherTag), { fetch: fixtureFetcher(files) });
    assert.deepEqual(undecided.problems, [
      `PFR wants Duper at eeeeeeeeee (v4.27.0) and the environment has v4.27.1, a tag: they cannot be compared without a network call, so give Duper by commit in the environment file`,
    ]);
    // By commit, they are compared: the same commit agrees, another one does not.
    const same = otherTag.replace('rev = "v4.27.1"', `rev = "${duperCommit}"`);
    files[`${DUPER}@${duperCommit}`] = files[`${DUPER}@v4.27.0`] as never;
    assert.deepEqual((await resolveEnvironment(spec(same), { fetch: fixtureFetcher(files) })).problems, []);
    const different = otherTag.replace('rev = "v4.27.1"', `rev = "${"f".repeat(40)}"`);
    files[`${DUPER}@${"f".repeat(40)}`] = files[`${DUPER}@v4.27.0`] as never;
    assert.deepEqual((await resolveEnvironment(spec(different), { fetch: fixtureFetcher(files) })).problems, [
      `PFR wants Duper at eeeeeeeeee (v4.27.0), the environment has ffffffffff`,
    ]);
  });

  describe("the environment hash", () => {
    const hashOf = async (toml: string, files = agreeing()): Promise<string> => {
      const { lock, problems } = await resolveEnvironment(spec(toml), { fetch: fixtureFetcher(files) });
      assert.deepEqual(problems, []);
      return (lock as NonNullable<typeof lock>).hash;
    };

    it("is the same for the same environment, whatever its description, name, or the order of its extra packages", async () => {
      const a = await hashOf(EXTENDED_TOML);
      assert.equal(await hashOf(EXTENDED_TOML), a);
      assert.equal(await hashOf(EXTENDED_TOML.replace("the bench", "described otherwise")), a);
      const reversed = BASE_TOML + EXTENDED_TOML.slice(EXTENDED_TOML.indexOf("[[package]]")).split("[[package]]").filter(Boolean).reverse().map((p) => `[[package]]${p}`).join("");
      assert.equal(await hashOf(reversed), a);
      const renamed = loadEnvSpec("other", envRoot({ "other.toml": EXTENDED_TOML }));
      const lock = (await resolveEnvironment(renamed, { fetch: fixtureFetcher(agreeing()) })).lock;
      assert.equal(lock?.hash, a);
    });

    it("changes with a package, a rev, a library, or the commit of a dependency", async () => {
      const a = await hashOf(EXTENDED_TOML);
      const without = await hashOf(BASE_TOML);
      assert.notEqual(without, a);
      const files = agreeing();
      files[`${PFR}@v4.27.1`] = files[`${PFR}@v4.27.0`] as never;
      assert.notEqual(await hashOf(EXTENDED_TOML.replace(`git = "${PFR}"\nrev = "v4.27.0"`, `git = "${PFR}"\nrev = "v4.27.1"`), files), a);
      assert.notEqual(await hashOf(EXTENDED_TOML.replace('lean_libs = ["PFR"]', 'lean_libs = ["PFR", "PFR.Extra"]')), a);
      // The same files with the Mathlib commit moved in every manifest: the environment names another Mathlib.
      const moved = agreeing();
      for (const [key, value] of Object.entries(moved)) {
        const name = key.includes("duper") ? "Duper" : key.includes("pfr") ? "PFR" : "formal_conjectures";
        value.manifest = manifest(name, [mathlib("9".repeat(40)), { name: "batteries", url: "https://github.com/leanprover-community/batteries", rev: "b".repeat(40) }]);
      }
      assert.notEqual(await hashOf(EXTENDED_TOML, moved), a);
    });
  });

  describe("local packages", () => {
    const local = (toolchain: string) => {
      const root = envRoot({
        "env.toml": `${BASE_TOML}\n[[package]]\nname = "SeshatMeta"\npath = "pkgs/SeshatMeta"\nlean_libs = ["SeshatMeta"]\n`,
        "pkgs/SeshatMeta/lean-toolchain": `${toolchain}\n`,
        "pkgs/SeshatMeta/SeshatMeta.lean": "def x := 1\n",
        "pkgs/SeshatMeta/lakefile.toml": 'name = "SeshatMeta"\n',
      });
      return { root, spec: loadEnvSpec("env", root) };
    };

    it("checks the toolchain, hashes the files, and writes the path relative to the project", async () => {
      const { root, spec: s } = local(TOOLCHAIN);
      const first = await resolveEnvironment(s, { fetch: fixtureFetcher(agreeing()) });
      assert.deepEqual(first.problems, []);
      assert.match(first.notes[0] ?? "", /SeshatMeta: a local package without a lake-manifest\.json/);
      const dir = join(root, "env");
      writeEnvironment(s, first.lock as NonNullable<typeof first.lock>, dir);
      assert.match(readFileSync(join(dir, "lakefile.toml"), "utf8"), /name = "SeshatMeta"\npath = "..\/pkgs\/SeshatMeta"/);
      writeFileSync(join(root, "pkgs/SeshatMeta/SeshatMeta.lean"), "def x := 2\n");
      mkdirSync(join(root, "pkgs/SeshatMeta/.lake"), { recursive: true });
      writeFileSync(join(root, "pkgs/SeshatMeta/.lake/ignored"), "build output");
      const second = await resolveEnvironment(s, { fetch: fixtureFetcher(agreeing()) });
      assert.notEqual(second.lock?.hash, first.lock?.hash, "the hash follows the harness's own Lean files");
      writeFileSync(join(root, "pkgs/SeshatMeta/.lake/ignored"), "other build output");
      assert.equal((await resolveEnvironment(s, { fetch: fixtureFetcher(agreeing()) })).lock?.hash, second.lock?.hash, "but not its build");
    });

    it("refuses another toolchain, or a directory that is not there", async () => {
      const wrong = local("leanprover/lean4:v4.26.0");
      const { problems } = await resolveEnvironment(wrong.spec, { fetch: fixtureFetcher(agreeing()) });
      assert.match(problems[0] ?? "", /the packages disagree on the toolchain/);
      const missing = loadEnvSpec("env", envRoot({ "env.toml": `${BASE_TOML}\n[[package]]\nname = "X"\npath = "nowhere"\nlean_libs = ["X"]\n` }));
      assert.match((await resolveEnvironment(missing, { fetch: fixtureFetcher(agreeing()) })).problems[0] ?? "", /X: the local package .*nowhere does not exist/);
    });
  });

  describe("writing", () => {
    it("rewrites the same files for the same hash, and clears what Lake resolved and built when the hash changes", async () => {
      const s = spec(EXTENDED_TOML);
      const dir = join(envRoot({}), "extended");
      const first = (await resolveEnvironment(s, { fetch: fixtureFetcher(agreeing()) })).lock as NonNullable<Awaited<ReturnType<typeof resolveEnvironment>>["lock"]>;
      assert.equal(writeEnvironment(s, first, dir).changed, true);
      writeFileSync(join(dir, "lake-manifest.json"), "{}");
      writeFileSync(join(dir, "lean-env.build.json"), "{}");
      assert.equal(writeEnvironment(s, first, dir).changed, false);
      assert.ok(existsSync(join(dir, "lake-manifest.json")) && existsSync(join(dir, "lean-env.build.json")));
      const smaller = spec(BASE_TOML);
      const second = (await resolveEnvironment(smaller, { fetch: fixtureFetcher(agreeing()) })).lock as typeof first;
      assert.notEqual(second.hash, first.hash);
      assert.equal(writeEnvironment(smaller, second, dir).changed, true);
      assert.ok(!existsSync(join(dir, "lake-manifest.json")) && !existsSync(join(dir, "lean-env.build.json")));
    });
  });
});
