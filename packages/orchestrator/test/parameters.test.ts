import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLI_OPTIONS } from "../src/cli-options.ts";
import { CLI_FLAGS, flagsOfKey, HOST_PROFILE_KEYS, renderParametersPage, RUN_PARAMETERS } from "../src/parameters.ts";
import { REPO_ROOT } from "../src/index.ts";
import type { RunConfig } from "../src/run.ts";

const keys = Object.keys(RUN_PARAMETERS) as Array<keyof RunConfig>;

describe("the catalogue of parameters", () => {
  it("lists every flag of the parser once, and no other", () => {
    const listed = CLI_FLAGS.map((f) => f.flag);
    assert.equal(new Set(listed).size, listed.length, "a flag is listed twice");
    assert.deepEqual([...listed].sort(), Object.keys(CLI_OPTIONS).sort());
  });

  it("agrees between a key's flags and the flags that map to it", () => {
    for (const key of keys) assert.deepEqual([...RUN_PARAMETERS[key].cli].sort(), flagsOfKey(key).sort(), `flags of ${key}`);
    for (const f of CLI_FLAGS) if (f.maps.kind === "RunConfig") assert.ok(f.maps.to.split(".")[0] as string in RUN_PARAMETERS, `--${f.flag} maps to an unknown key ${f.maps.to}`);
  });

  it("points to documentation sections and tests that exist", () => {
    for (const key of keys) {
      const p = RUN_PARAMETERS[key];
      if (p.docs !== "") {
        const [page, section] = p.docs.split("#") as [string, string];
        const file = join(REPO_ROOT, "documentation", page);
        assert.ok(existsSync(file), `${key}: no page ${page}`);
        assert.ok(readFileSync(file, "utf8").split("\n").some((l) => /^#+ /.test(l) && l.replace(/^#+ /, "") === section), `${key}: no section "${section}" in ${page}`);
      }
      if (p.tested !== "") {
        const file = join(REPO_ROOT, "packages", "orchestrator", "test", p.tested);
        assert.ok(existsSync(file), `${key}: no test ${p.tested}`);
        assert.match(readFileSync(file, "utf8"), new RegExp(`\\b${key}\\b`), `${key}: ${p.tested} does not mention it`);
      }
    }
  });

  it("knows every key of the shipped host profiles", () => {
    const known = new Set(HOST_PROFILE_KEYS.map((k) => k.key));
    for (const name of ["local", "server"]) {
      const profile = JSON.parse(readFileSync(join(REPO_ROOT, "config", "hosts", `${name}.json`), "utf8")) as Record<string, unknown>;
      for (const key of Object.keys(profile)) assert.ok(known.has(key), `${name}.json: unknown key ${key}`);
      for (const model of Object.values((profile.models ?? {}) as Record<string, Record<string, unknown>>)) for (const key of Object.keys(model)) assert.ok(known.has(`models.*.${key}`), `${name}.json: unknown model key ${key}`);
      for (const binding of Object.values((profile.capabilities ?? {}) as Record<string, Record<string, unknown>>)) for (const key of Object.keys(binding)) assert.ok(known.has(`capabilities.*.${key}`), `${name}.json: unknown capability key ${key}`);
    }
  });

  it("is the page documentation/parameters.md, as generated", () => {
    const committed = readFileSync(join(REPO_ROOT, "documentation", "parameters.md"), "utf8");
    assert.equal(committed, renderParametersPage(), "regenerate it: pnpm harness parameters --markdown --out documentation/parameters.md");
  });
});
