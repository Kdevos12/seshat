import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { libraryDefinitionsCommand, libraryDeprecateCommand, libraryReviewCommand, registryDefinitions, seedDefinitions } from "../src/library-registry.ts";

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
    const accepted = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), registry: join(tmp(), "reg"), builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, print: (l) => lines.push(l) });
    assert.equal(accepted, 0);
    assert.ok(lines.some((l) => /definition SeshatLib\.Combinatorics\.mulDiv: unreviewed/.test(l)));
    assert.ok(!existsSync(join(root, "lean")));
    const adopted = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), registry: join(tmp(), "reg"), builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, adoptInto: root, print: (l) => lines.push(l) });
    assert.equal(adopted, 0);
    assert.ok(existsSync(join(root, "lean/SeshatLib/Combinatorics/Basic.lean")));
    const rejected = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), registry: join(tmp(), "reg"), builder: h.builder("sorry"), budget: { seconds: 60 }, timeoutSec: 60, adoptInto: root, print: (l) => lines.push(l) });
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

describe("the registry of definitions, from a build to a run (review I1, I4)", () => {
  const fresh = (): { dir: string; memory: MemoryStore; journal: Journal } => {
    const dir = tmp();
    const journal = Journal.open(dir, "run_seed");
    return { dir, journal, memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }) };
  };

  it("carries an accepted build's definitions to a run's store, unreviewed until a person reviews them", async () => {
    const registry = join(tmp(), "registry");
    const h = harness();
    const code = await libraryBuildCommand(specFile(), { out: join(tmp(), "j"), registry, runsDir: tmp(), builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, print: () => {} });
    assert.equal(code, 0);
    const lines: string[] = [];
    libraryDefinitionsCommand({ registry, print: (l) => lines.push(l) });
    assert.match(lines[0] as string, /^unreviewed\s+SeshatLib\.Combinatorics\.mulDiv/);

    // A run that starts now refuses a statement over the definition.
    const before = fresh();
    seedDefinitions(before.memory, registryDefinitions(registry));
    await assert.rejects(before.memory.ensureClaim({ statement: "(n : Nat) : mulDiv n 1 = n", origin: "test" }), /unreviewed/);
    before.journal.close();

    // Only a named person reviews; then the next run may state it.
    assert.throws(() => libraryReviewCommand("SeshatLib.Combinatorics.mulDiv", { registry, as: undefined, print: () => {} }), /needs --as NAME/);
    libraryReviewCommand("SeshatLib.Combinatorics.mulDiv", { registry, as: "ana", print: () => {} });
    const after = fresh();
    seedDefinitions(after.memory, registryDefinitions(registry));
    assert.equal((await after.memory.ensureClaim({ statement: "(n : Nat) : mulDiv n 1 = n", origin: "test" })).created, true);
    after.journal.close();

    // A definition found wrong is deprecated, and the next run refuses it again.
    libraryDeprecateCommand("SeshatLib.Combinatorics.mulDiv", { registry, reason: "mulDiv divides by zero", print: () => {} });
    const last = fresh();
    seedDefinitions(last.memory, registryDefinitions(registry));
    await assert.rejects(last.memory.ensureClaim({ statement: "(n : Nat) : mulDiv n 2 = n", origin: "test" }), /deprecated/);
    last.journal.close();
  });

  it("does not adopt while a run is being written, and does once its process is gone", async () => {
    const h = harness();
    const runs = tmp();
    const run = join(runs, "run_1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "journal.jsonl.lock"), String(process.pid));
    const root = tmp();
    const registry = join(tmp(), "registry");
    const options = { out: join(tmp(), "j"), registry, runsDir: runs, builder: h.builder("good"), budget: { seconds: 60 }, timeoutSec: 60, adoptInto: root, print: () => {} };
    await assert.rejects(libraryBuildCommand(specFile(), options), /a run is going/);
    assert.ok(!existsSync(join(root, "lean")), "nothing landed");
    writeFileSync(join(run, "journal.jsonl.lock"), "2147483646");
    assert.equal(await libraryBuildCommand(specFile(), { ...options, out: join(tmp(), "j2"), registry: join(tmp(), "registry2") }), 0);
    assert.ok(existsSync(join(root, "lean/SeshatLib/Combinatorics/Basic.lean")));
  });

  it("ignores the author a spec file names", async () => {
    const path = join(tmp(), "spec.json");
    writeFileSync(path, JSON.stringify({ ...SPEC, author: "human:somebody-else" }));
    const out = join(tmp(), "j");
    await libraryBuildCommand(path, { out, registry: join(tmp(), "r"), builder: harness().builder("good"), budget: { seconds: 60 }, timeoutSec: 60, print: () => {} });
    const journal = Journal.open(out, "library_y");
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(out, "blobs")) });
    assert.equal(((memory.nodes(BUILD_KIND)[0]?.data as { spec: { author: string } }).spec).author, "human:cli");
    journal.close();
  });
});
