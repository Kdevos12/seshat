import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_ENV_ROOT, listEnvironments, loadEnvSpec } from "../src/index.ts";

const REPO = join(DEFAULT_ENV_ROOT, "..", "..");

describe("the environments the repository ships", () => {
  it("are base and extended", () => {
    assert.deepEqual(listEnvironments(), ["base", "extended"]);
  });

  it("have base be the project the bench is pinned to, on the bench's Lean", () => {
    const { source } = JSON.parse(readFileSync(join(REPO, "bench", "fc-bench-v1-discrete.json"), "utf8")) as {
      source: { lean: string; repo: string; tag: string };
    };
    const base = loadEnvSpec("base");
    assert.equal(base.toolchain, source.lean);
    assert.equal(base.base.git, `https://github.com/${source.repo}`);
    assert.equal(base.base.rev, source.tag);
    assert.deepEqual(base.packages, []);
  });

  it("have extended be base plus Duper, LeanAPAP and PFR at their v4.27.0 tags", () => {
    const base = loadEnvSpec("base");
    const extended = loadEnvSpec("extended");
    assert.deepEqual(extended.base, base.base);
    assert.equal(extended.toolchain, base.toolchain);
    assert.deepEqual(extended.packages.map((p) => [p.name, p.rev]), [["Duper", "v4.27.0"], ["LeanAPAP", "v4.27.0"], ["PFR", "v4.27.0"]]);
  });
});
