import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adoptBuild, type LibrarySpec } from "../src/index.ts";
import { harness } from "./fixtures.ts";

const PORT: LibrarySpec = {
  job: "port",
  domain: "Ports",
  reason: "Foo has no tag for the pinned toolchain",
  imports: [],
  items: [],
  testLemmas: [],
  port: { name: "Foo", git: "https://example.com/foo", rev: "main", libs: ["Foo"] },
};
const OPTIONS = { budget: { seconds: 60 }, timeoutSec: 60 };

describe("the port job", () => {
  it("accepts a ported package under its own directory and builds its libraries", async () => {
    const h = harness();
    const result = await h.builder("port").build(PORT, OPTIONS);
    assert.equal(result.status, "accepted", result.reason);
    assert.deepEqual(result.files.map((f) => f.path), ["lean/ports/Foo/Foo.lean", "lean/ports/Foo/lakefile.toml"]);
    assert.match(h.commands[0] as string, /^lake build Foo /);
    assert.deepEqual(result.theorems, ["Foo.two_eq"]);
    assert.equal(result.needsApproval, false);
    assert.match(result.provenance.prompt ?? "", /Port the Lean package Foo/);
  });

  it("flags code that runs while Lean elaborates, and adoption then needs a person", async () => {
    const h = harness();
    const result = await h.builder("port_meta").build(PORT, OPTIONS);
    assert.equal(result.status, "accepted", result.reason);
    assert.equal(result.needsApproval, true);
    const root = mkdtempSync(join(tmpdir(), "mh-lb-adopt-"));
    assert.throws(() => adoptBuild(result, { root, runActive: () => false }), /a person approves it/);
    const written = adoptBuild(result, { root, runActive: () => false, approvedBy: "ana" });
    assert.equal(written.length, 1);
    assert.match(readFileSync(join(root, "lean/ports/Foo/Foo.lean"), "utf8"), /macro "two"/);
  });

  it("is refused in a fill's directory", async () => {
    const h = harness();
    const result = await h.builder("good").build(PORT, OPTIONS);
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /outside lean\/ports\/Foo\//);
  });
});
