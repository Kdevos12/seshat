import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Json } from "@seshat/core";
import { loadHostProfile, Registry, runContract, type HostProfile } from "@seshat/registry";
import { defaultArgs, DISABLED_TOOLS, ALLOWED_TOOLS, FILE_OPS, LEAN_LSP_MCP_VERSION, LEANCLIENT_VERSION, leanLspFactory, OPS, SITES, SITE_OF_TOOL } from "../src/index.ts";
import { ALL_TOOLS, FakeLeanLspMcp, USED_TOOLS } from "./fixtures/fake-lean-lsp-mcp.ts";
import { capability, catalog, REPO, SKETCH, spec, standIns, tempProject } from "./helpers.ts";

const manifest = capability.manifest;
const properties = manifest.input.properties ?? {};

/** The operations of PC7 (plan-change-thinking-modes.md): goal at a position, term goal, diagnostics, multi-attempt, Loogle, LeanSearch, state search, hammer premises. */
const PC7 = ["goal", "term_goal", "diagnostics", "multi_attempt", "loogle", "leansearch", "state_search", "hammer_premise"];

describe("the manifest of lean.lsp", () => {
  it("offers the eight operations of PC7 and no other", () => {
    assert.deepEqual(properties.op?.enum, PC7);
    assert.deepEqual([...OPS], PC7);
    assert.deepEqual([...FILE_OPS].sort(), ["diagnostics", "goal", "hammer_premise", "multi_attempt", "state_search", "term_goal"]);
  });

  it("takes no path, file name or command: the only text a prover gives is Lean to look at or a query", () => {
    assert.deepEqual(Object.keys(properties), ["op", "sketch", "aux", "proof", "region", "line", "column", "tactics", "query", "limit", "severity", "timeoutSec"]);
    assert.equal(manifest.input.additionalProperties, false);
    assert.equal(manifest.output.additionalProperties, false);
    assert.deepEqual(Object.keys(properties).filter((name) => /path|file|dir|uri|url|cwd|command|module|import/i.test(name)), []);
    assert.deepEqual(manifest.input.required, ["op"]);
  });

  it("states no verdict: nothing in its output can pass for a check, and nothing it makes enters the memory", () => {
    assert.deepEqual(manifest.produces, []);
    assert.deepEqual(Object.keys(manifest.output.properties ?? {}).filter((name) => /verdict|valid|proved|proof|accepted|axiom|certif/i.test(name)), []);
    const text = readFileSync(join(capability.dir, "description.md"), "utf8");
    assert.match(text, /`lean_check` stays the only judge, and nothing here is a proof/);
    assert.match(text, /It refuses what `lean_check` refuses/);
  });

  it("is a direct and stateful capability, whose name for a model is a valid provider tool name", () => {
    assert.equal(manifest.exposure, "direct");
    assert.equal(manifest.stateful, true);
    const name = manifest.id.replace(/\./g, "_");
    assert.equal(name, "lean_lsp");
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(manifest.timeoutField, "timeoutSec");
  });

  it("pins the server, which the factory starts at that version and the health check verifies", () => {
    assert.equal(LEAN_LSP_MCP_VERSION, "0.31.0");
    assert.equal(spec.version, LEAN_LSP_MCP_VERSION);
    assert.equal(spec.factory, "lean-lsp");
    assert.equal(manifest.implementations.length, 1);
    assert.equal(manifest.implementations[0]?.id, "lean-lsp-mcp");
    // leanclient is pinned exactly beside the release: the server only asks for a minimum of it.
    assert.equal(LEANCLIENT_VERSION, "0.13.2");
    assert.deepEqual(defaultArgs("uvx", spec.version), ["--from", "lean-lsp-mcp==0.31.0", "--with", "leanclient==0.13.2", "lean-lsp-mcp"]);
    assert.deepEqual(defaultArgs("/usr/local/bin/uvx", spec.version), ["--from", "lean-lsp-mcp==0.31.0", "--with", "leanclient==0.13.2", "lean-lsp-mcp"]);
    assert.deepEqual(defaultArgs("lean-lsp-mcp", spec.version), []);
    const environment = (spec as unknown as { environment: Record<string, string> }).environment;
    assert.equal(environment.server, `lean-lsp-mcp ${LEAN_LSP_MCP_VERSION}`);
    assert.equal(environment.leanclient, `leanclient ${LEANCLIENT_VERSION}`);
  });

  it("uses 8 of the server's 22 tools, and switches the other 14 off in the server", () => {
    assert.equal(ALL_TOOLS.length, 22);
    assert.deepEqual([...ALLOWED_TOOLS].sort(), [...USED_TOOLS].sort());
    assert.equal(DISABLED_TOOLS.length, 14);
    assert.deepEqual([...ALLOWED_TOOLS, ...DISABLED_TOOLS].sort(), [...ALL_TOOLS].sort(), "every tool of the pinned release is one or the other");
    // The ones a prover must never reach.
    for (const tool of ["lean_build", "lean_run_code", "lean_file_outline", "lean_declaration_file", "lean_local_search", "lean_hover_info", "lean_verify", "lean_profile_proof"]) {
      assert.ok(DISABLED_TOOLS.includes(tool as never), tool);
    }
    assert.ok(!(ALLOWED_TOOLS as readonly string[]).includes("lean_state_search"), "removed in 0.31.0: state search is the goal and Lean Finder");
  });

  it("declares each network site that its searches ask, as the other site-backed capabilities do", () => {
    const environment = (spec as unknown as { environment: Record<string, string> }).environment;
    assert.deepEqual(Object.keys(environment).filter((k) => k.startsWith("site.")).sort(), SITES.map((s) => `site.${s}`).sort());
    for (const site of SITES) assert.match(environment[`site.${site}`] ?? "", /^https?:\/\/[a-z0-9.-]+$/, site);
    // Every tool that reaches out is tied to a site, and to a declared one.
    for (const [tool, site] of Object.entries(SITE_OF_TOOL)) assert.ok(SITES.includes(site as never), `${tool}: ${site}`);
    assert.deepEqual(Object.keys(SITE_OF_TOOL).sort(), ["lean_hammer_premise", "lean_leanfinder", "lean_leansearch", "lean_loogle"]);
  });

  it("says in its implementation that it has not run against a real Lean", () => {
    assert.match(spec.description ?? "", /Not run against a real Lean yet/);
  });
});

describe("the contract of lean.lsp", () => {
  const cases = capability.contract;
  const dry = (host: HostProfile, fake: FakeLeanLspMcp) =>
    new Registry({ catalog, host, factories: standIns({ "lean-lsp": leanLspFactory({ transport: () => fake.transport() }) }) });
  const hostOver = (project: string): HostProfile => ({
    host: "test",
    capabilities: { "lean.lsp": { use: ["lean-lsp-mcp"], settings: { "lean-lsp-mcp": { projectDir: project } } } },
  });

  it("covers every operation, the refusals and a line outside the region", () => {
    const ops = new Set(cases.map((c) => (c.input as { op: string }).op));
    assert.deepEqual([...ops].sort(), [...PC7].sort());
    assert.equal(cases.filter((c) => c.fails !== undefined).length, 3);
    assert.ok(cases.some((c) => c.fails?.matches === "Refused before Lean ran"));
    assert.ok(cases.some((c) => /there is no line 9/.test(c.fails?.matches ?? "")));
    assert.ok(cases.every((c) => (c.purpose ?? "").length > 20), "each case says what the harness relies on");
  });

  it("works on the sketch that prepareSketch makes of the contract's file, so that the cases cannot drift from it", () => {
    const withSketch = cases.filter((c) => "sketch" in (c.input as object));
    assert.equal(withSketch.length, cases.length - 2, "all but the two searches by text work on the file");
    for (const c of withSketch) assert.deepEqual((c.input as { sketch: Json }).sketch, SKETCH as unknown as Json, c.name);
    assert.equal(SKETCH.fullName, "seshat_contract");
    assert.equal(SKETCH.originalProof, "sorry");
    assert.equal(SKETCH.prefix, "", "no import: the cases need Lean's core only");
  });

  it("asks for the time a real Lean needs on the first call, within the tool's limit", () => {
    for (const c of cases) {
      const seconds = (c.input as { timeoutSec?: number }).timeoutSec;
      if (seconds !== undefined) assert.ok(seconds <= 300, c.name);
    }
    assert.ok(cases.some((c) => (c.input as { timeoutSec?: number }).timeoutSec === 240));
  });

  it("passes against a stand-in server that answers as the contract's file asks, through the registry", async () => {
    const project = tempProject();
    const fake = new FakeLeanLspMcp({ projectDir: project });
    const registry = dry(hostOver(project), fake);
    try {
      const report = await runContract(registry, "lean.lsp");
      const failures = report.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.failures.join("; ")}`);
      assert.deepEqual(failures, []);
      assert.equal(report.passed, cases.length);
    } finally {
      await registry.close();
    }
  });

  it("is not vacuous: a server that answers otherwise fails the cases that rely on the answer", async () => {
    const project = tempProject();
    const fake = new FakeLeanLspMcp({ projectDir: project });
    fake.on("lean_goal", (args, f) => ({
      structured: { line_context: f.lines(String(args.file_path))[Number(args.line) - 1], goals: ["⊢ False"], goals_before: [], goals_after: ["⊢ False"], status: "goals" },
    }));
    const registry = dry(hostOver(project), fake);
    try {
      const report = await runContract(registry, "lean.lsp");
      const failed = report.cases.filter((c) => !c.passed).map((c) => c.name);
      assert.ok(failed.includes("the goals around a line"), failed.join(", "));
      assert.ok(failed.includes("the goal at a position"), failed.join(", "));
      assert.ok(report.passed > 0 && report.failed >= 2);
    } finally {
      await registry.close();
    }
  });
});

const liveSkip =
  process.env.LEAN_PROJECT_DIR === undefined || process.env.LEAN_PROJECT_DIR === "" || !existsSync(process.env.LEAN_PROJECT_DIR)
    ? "needs a Lean host: LEAN_PROJECT_DIR (a Lean project that builds) and uvx or LEAN_LSP_MCP_COMMAND; not run against a real Lean yet"
    : false;

describe("the contract of lean.lsp against the real server", { skip: liveSkip }, () => {
  it("passes on a Lean host (the four cases that ask a site also need the network: set LEAN_LSP_SITES=1)", async () => {
    const siteCases = ["Loogle by name", "LeanSearch by meaning", "lemmas for a goal", "premises for a goal"];
    const registry = new Registry({
      catalog,
      host: loadHostProfile(join(REPO, "config", "hosts", "local.json")),
      factories: standIns({ "lean-lsp": leanLspFactory() }),
    });
    try {
      const only = capability.contract.map((c) => c.name).filter((name) => process.env.LEAN_LSP_SITES === "1" || !siteCases.includes(name));
      const report = await runContract(registry, "lean.lsp", { only });
      const failures = report.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.failures.join("; ")}`);
      assert.deepEqual(failures, []);
    } finally {
      await registry.close();
    }
  });
});
