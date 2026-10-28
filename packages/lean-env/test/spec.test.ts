import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allPackages, EnvSpecError, listEnvironments, loadEnvSpec, normalizeToolchain, specHash, toolchainTag } from "../src/index.ts";
import { BASE_TOML, EXTENDED_TOML, envRoot, FC } from "./fixtures.ts";

describe("environment files", () => {
  it("reads the base project and the extra packages", () => {
    const root = envRoot({ "extended.toml": EXTENDED_TOML, "base.toml": BASE_TOML });
    const spec = loadEnvSpec("extended", root);
    assert.equal(spec.toolchain, "leanprover/lean4:v4.27.0");
    assert.deepEqual(spec.base, { name: "formal_conjectures", git: FC, rev: "bench-v1-lean4.27.0", leanLibs: ["FormalConjectures"] });
    assert.deepEqual(allPackages(spec).map((p) => p.name), ["formal_conjectures", "Duper", "PFR"]);
    assert.deepEqual(listEnvironments(root), ["base", "extended"]);
  });

  it("names the environments there are when one is missing", () => {
    const root = envRoot({ "base.toml": BASE_TOML });
    assert.throws(() => loadEnvSpec("nope", root), (e: Error) => e instanceof EnvSpecError && /no environment nope.*the environments are base/.test(e.message));
    assert.throws(() => loadEnvSpec("../etc", root), /not an environment name/);
  });

  it("reports every problem of a file together", () => {
    const root = envRoot({
      "bad.toml": `
name = "other"
toolchain = "nonsense"
colour = "blue"

[base]
name = "formal_conjectures"
git = "http://not-https"
lean_libs = []

[[package]]
name = "Duper"
rev = "v4.27.0"
lean_libs = ["Duper"]

[[package]]
name = "duper"
git = "https://github.com/x/duper"
path = "../x"
lean_libs = ["Duper"]
`,
    });
    assert.throws(
      () => loadEnvSpec("bad", root),
      (e: Error) => {
        for (const part of [
          'name is "other" but the file is bad.toml',
          "toolchain must be",
          "unknown key colour",
          "[base]: git must be an https URL",
          "[base]: lean_libs must be",
          "[[package]] #1: give git (with rev) or path",
          "[[package]] #2: give git (with rev) or path",
        ]) assert.ok(e.message.includes(part), `${part} in ${e.message}`);
        return true;
      },
    );
  });

  it("requires the base project's rev and refuses a local base or a package listed twice", () => {
    const root = envRoot({
      "nobase.toml": `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "a"\ngit = "https://github.com/x/a"\nlean_libs = ["A"]\n`,
      "localbase.toml": `toolchain = "leanprover/lean4:v4.27.0"\n[base]\nname = "a"\npath = "../a"\nlean_libs = ["A"]\n`,
      "twice.toml": `${BASE_TOML}\n[[package]]\nname = "Formal_Conjectures"\npath = "../x"\nlean_libs = ["X"]\n`,
    });
    assert.throws(() => loadEnvSpec("nobase", root), /the base project's rev is the bench's tag/);
    assert.throws(() => loadEnvSpec("localbase", root), /the base project is a git repository/);
    assert.throws(() => loadEnvSpec("twice", root), /listed twice/);
  });

  it("reports a file that is not TOML with its line", () => {
    const root = envRoot({ "broken.toml": 'toolchain = "x"\n[base\n' });
    assert.throws(() => loadEnvSpec("broken", root), /broken\.toml: line 2/);
  });

  it("writes a toolchain in its one form", () => {
    assert.equal(normalizeToolchain("v4.27.0"), "leanprover/lean4:v4.27.0");
    assert.equal(normalizeToolchain(" 4.27.0\n"), "leanprover/lean4:v4.27.0");
    assert.equal(normalizeToolchain("leanprover/lean4:v4.27.0-rc1"), "leanprover/lean4:v4.27.0-rc1");
    assert.equal(normalizeToolchain("leanprover/lean4-nightly:nightly-2026-01-01"), "leanprover/lean4-nightly:nightly-2026-01-01");
    assert.equal(toolchainTag("leanprover/lean4:v4.27.0"), "v4.27.0");
    assert.equal(toolchainTag("leanprover/lean4-nightly:nightly-2026-01-01"), undefined);
  });

  it("hashes what the file says, not its description", () => {
    const a = loadEnvSpec("base", envRoot({ "base.toml": BASE_TOML }));
    const b = loadEnvSpec("base", envRoot({ "base.toml": BASE_TOML.replace("the bench", "something else") }));
    const c = loadEnvSpec("base", envRoot({ "base.toml": BASE_TOML.replace("bench-v1-lean4.27.0", "main") }));
    assert.equal(specHash(a), specHash(b));
    assert.notEqual(specHash(a), specHash(c));
  });
});
