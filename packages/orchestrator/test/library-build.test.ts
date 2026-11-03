import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import { BUILD_KIND, NoneBuilder, recordGap } from "@seshat/library-builder";
import { harness, SPEC } from "../../library-builder/test/fixtures.ts";
import {
  DEFAULT_LIBRARY_BUILDER_CONFIG,
  expandEnv,
  libraryBuildCommand,
  libraryGapsCommand,
  LibraryBuilderConfigError,
  loadLibraryBuilderConfig,
  makeLibraryBuilder,
} from "../src/library-build-command.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mh-libbuild-cli-"));
}

function specFile(): string {
  const path = join(tmp(), "spec.json");
  writeFileSync(path, JSON.stringify(SPEC));
  return path;
}

describe("the library builder's config", () => {
  it("ships with the none builder, which needs no variable", () => {
    const config = loadLibraryBuilderConfig(DEFAULT_LIBRARY_BUILDER_CONFIG, {});
    assert.equal(config.builder, "none");
    assert.equal(makeLibraryBuilder(config).builder.id, "none");
  });

  it("expands variables for the coding agent and refuses one that is not set", () => {
    const path = join(tmp(), "c.json");
    const section = JSON.parse(readFileSync(DEFAULT_LIBRARY_BUILDER_CONFIG, "utf8"))["coding-agent"];
    writeFileSync(path, JSON.stringify({ builder: "coding-agent", "coding-agent": section }));
    assert.throws(() => loadLibraryBuilderConfig(path, {}), /LIBRARY_BUILDER_API_KEY.*not set/);
    const config = loadLibraryBuilderConfig(path, { LIBRARY_BUILDER_API_KEY: "k", LIBRARY_BUILDER_REPO: "/p" });
    assert.equal(config["coding-agent"]?.repo, "/p");
    assert.deepEqual(config["coding-agent"]?.agent.env, { ANTHROPIC_API_KEY: "k" });
    // The shipped example names no sandbox, so it does not start an agent until the person sets one.
    assert.throws(() => makeLibraryBuilder(config), /needs a sandbox command/);
    assert.deepEqual(expandEnv(["${env:A}x", { b: "${env:A}" }], { A: "1" }), ["1x", { b: "1" }]);
    writeFileSync(path, JSON.stringify({ builder: "other" }));
    assert.throws(() => loadLibraryBuilderConfig(path, {}), LibraryBuilderConfigError);
  });
});

describe("harness library build", () => {
  it("with the none builder builds nothing and journals the skipped build", async () => {
    const out = join(tmp(), "j");
    const lines: string[] = [];
    const code = await libraryBuildCommand(specFile(), { out, builder: new NoneBuilder(), print: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.match(lines[0] as string, /: skipped: no library builder is configured/);
    const journal = Journal.open(out, "library_x");
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(out, "blobs")) });
    assert.equal(memory.nodes(BUILD_KIND).length, 1);
    journal.close();
  });

  it("journals an accepted build, lands its files only with --adopt, and exits 1 for a rejected one", async () => {
    const h = harness();
    const lines: string[] = [];
    const root = tmp();
    const accepted = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, print: (l) => lines.push(l) });
    assert.equal(accepted, 0);
    assert.ok(lines.some((l) => /definition SeshatLib\.Combinatorics\.mulDiv: unreviewed/.test(l)));
    assert.ok(!existsSync(join(root, "lean")));
    const adopted = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, adoptInto: root, print: (l) => lines.push(l) });
    assert.equal(adopted, 0);
    assert.ok(existsSync(join(root, "lean/SeshatLib/Combinatorics/Basic.lean")));
    const rejected = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), builder: h.builder("sorry"), budget: { seconds: 60 }, timeoutSec: 60, adoptInto: root, print: (l) => lines.push(l) });
    assert.equal(rejected, 1);
    assert.ok(lines.some((l) => /gate content: FAILED/.test(l)));
  });

  it("refuses an invalid spec before anything runs", async () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(path, JSON.stringify({ ...SPEC, domain: "x" }));
    await assert.rejects(libraryBuildCommand(path, { out: join(tmp(), "j"), builder: new NoneBuilder(), print: () => {} }), /is not valid/);
  });

  it("lists the gaps a run recorded", () => {
    const dir = tmp();
    const journal = Journal.open(dir, "run_g");
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) });
    const lines: string[] = [];
    libraryGapsCommand(memory, (l) => lines.push(l));
    assert.deepEqual(lines, ["no open library gap"]);
    recordGap(memory, { trigger: "prover_request", concept: "mulDiv", job: "fill", count: 1, evidence: [] });
    libraryGapsCommand(memory, (l) => lines.push(l));
    assert.match(lines[1] as string, /fill {2}prover_request {2}mulDiv/);
    journal.close();
  });
});
