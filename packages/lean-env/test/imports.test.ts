import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { environmentImports, environmentProbe, M17, M17_DEFAULT_ENV, withEnvironmentImports } from "../src/index.ts";

const pkg = (name: string, role: "base" | "extra", leanLibs: string[]) => ({ name, role, leanLibs, toolchain: "t", manifestHash: null });

describe("what an environment adds to the files of a run", () => {
  const lock = { packages: [pkg("formal_conjectures", "base", ["FormalConjectures"]), pkg("Duper", "extra", ["Duper"]), pkg("PFR", "extra", ["PFR", "PFR.Extra", "Duper"])] };

  it("is the libraries of the extra packages, once each, and nothing for the base project", () => {
    assert.deepEqual(environmentImports(lock), ["Duper", "PFR", "PFR.Extra"]);
    assert.deepEqual(environmentImports({ packages: [pkg("formal_conjectures", "base", ["FormalConjectures"])] }), []);
    assert.equal(environmentProbe({ packages: [pkg("formal_conjectures", "base", ["FormalConjectures"])] }), undefined);
    assert.equal(environmentProbe(lock), "import Duper\nimport PFR\nimport PFR.Extra\n");
  });

  it("goes into a file after its last import and changes nothing else", () => {
    const source = "import Mathlib.Data.Nat.Basic\nimport FormalConjectures.Util.ProblemImports\n\nopen Nat\n\ntheorem t : True := trivial\n-- import Duper\n";
    assert.equal(
      withEnvironmentImports(source, ["Duper", "PFR"]),
      "import Mathlib.Data.Nat.Basic\nimport FormalConjectures.Util.ProblemImports\nimport Duper\nimport PFR\n\nopen Nat\n\ntheorem t : True := trivial\n-- import Duper\n",
    );
    assert.equal(withEnvironmentImports(source, []), source);
  });

  it("does not add a module the file imports already, and finds the imports after blank lines and comments", () => {
    const source = "\n-- a comment\nimport Duper  -- already\nimport Mathlib\n\ndef x := 1\n";
    assert.equal(withEnvironmentImports(source, ["Duper", "PFR"]), "\n-- a comment\nimport Duper  -- already\nimport Mathlib\nimport PFR\n\ndef x := 1\n");
    assert.equal(withEnvironmentImports(source, ["Duper"]), source);
  });

  it("reads several modules on one import line: none is added again, and the new lines follow that line", () => {
    const source = "import Mathlib Duper\nimport Aesop\n\ndef x := 1\n";
    assert.equal(withEnvironmentImports(source, ["Duper", "PFR"]), "import Mathlib Duper\nimport Aesop\nimport PFR\n\ndef x := 1\n");
    assert.equal(withEnvironmentImports("import Mathlib Duper -- both\n\ndef x := 1\n", ["Duper", "PFR"]), "import Mathlib Duper -- both\nimport PFR\n\ndef x := 1\n");
    assert.equal(withEnvironmentImports("import Mathlib Duper\n", ["Duper"]), "import Mathlib Duper\n");
  });

  it("goes first into a file with no imports, and does not take an import in the middle of the file for a header", () => {
    assert.equal(withEnvironmentImports("def x := 1\n", ["Duper"]), "import Duper\ndef x := 1\n");
    assert.equal(withEnvironmentImports("def x := 1\nimport Mathlib\n", ["Duper"]), "import Duper\ndef x := 1\nimport Mathlib\n");
  });
});

describe("line M17", () => {
  it("names the extended environment unless its option says another, and has no hook", () => {
    assert.equal(M17.id, "M17");
    assert.deepEqual(M17.options, { env: M17_DEFAULT_ENV });
    assert.equal(M17_DEFAULT_ENV, "extended");
    assert.equal(M17.leanEnv?.({ env: "extended" }), "extended");
    assert.equal(M17.leanEnv?.({ env: "other" }), "other");
    assert.equal(M17.leanEnv?.({ env: "" }), "extended");
    assert.deepEqual(M17.requires, []);
    assert.deepEqual(M17.hooks, {});
    assert.equal(M17.resume, "stateless");
    assert.ok(M17.version !== undefined);
  });
});
