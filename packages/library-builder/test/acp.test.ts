import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import {
  acpAgentRunner,
  type AgentSettings,
  type BuildOptions,
  CodingAgentBuilder,
  decidePermission,
  insideDirectory,
  type LibraryBuildResult,
  probeAcp,
  recordBuild,
  renderCommand,
} from "../src/index.ts";
import { harness, SPEC } from "./fixtures.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");
const OPTIONS: BuildOptions = { budget: { usd: 2, seconds: 60 }, timeoutSec: 60 };

/** The settings of an ACP agent that is the fake script in a scenario; FAKE_LOG receives every message Seshat sends it. */
function acpSettings(scenario: string, extra: Partial<AgentSettings> = {}): { settings: Partial<AgentSettings>; log: string } {
  const log = join(mkdtempSync(join(tmpdir(), "mh-acp-log-")), "messages.jsonl");
  return {
    log,
    settings: { transport: "acp", command: [process.execPath, FAKE_ACP], env: { FAKE_SCENARIO: scenario, FAKE_LOG: log }, acp: { cancelGraceSec: 1 }, ...extra },
  };
}

/** The messages Seshat sent, as the fake agent logged them. */
function sent(log: string): Array<Record<string, any>> {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, any>) : [];
}

async function acpRun(scenario: string, o: { options?: BuildOptions; extra?: Partial<AgentSettings>; builder?: Record<string, unknown> } = {}) {
  const h = harness();
  const { settings, log } = acpSettings(scenario, o.extra);
  const result = await h.builder(scenario, o.builder ?? {}, settings).build(SPEC, o.options ?? OPTIONS);
  return { result, h, log, messages: sent(log) };
}

function memory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-acp-mem-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_acp"), blobs: new BlobStore(join(dir, "blobs")) });
}

const failedRule = (r: LibraryBuildResult): string | undefined => r.gate.find((c) => !c.ok)?.rule;

describe("the ACP transport of the coding-agent builder (EA2)", () => {
  it("gives a fill job the same verdict, gate, files and record over ACP as over the CLI", async () => {
    // One project for both, so that the base commit is the same.
    const h = harness();
    const cli = await h.builder("good").build(SPEC, OPTIONS);
    const acp = await h.builder("good", {}, acpSettings("good", { env: { FAKE_SCENARIO: "good" } }).settings).build(SPEC, OPTIONS);
    assert.equal(acp.status, "accepted", acp.reason);
    assert.equal(acp.status, cli.status);
    assert.equal(acp.reason, cli.reason);
    assert.deepEqual(acp.gate, cli.gate);
    assert.deepEqual(acp.files, cli.files);
    assert.deepEqual(acp.theorems, cli.theorems);
    assert.deepEqual(acp.definitions, cli.definitions);
    assert.equal(acp.diff, cli.diff);
    // The journal's record is the same but for what differs by nature: when, the command, what the agent said, and the ACP session.
    const strip = (data: Record<string, unknown>) => {
      const { buildId: _b, startedAt: _s, finishedAt: _f, command: _c, agentOutputTail: _o, agentMs: _m, transport: _t, acp: _a, ...rest } = data;
      return rest;
    };
    const a = recordBuild(memory(), acp).node.data as Record<string, unknown>;
    const c = recordBuild(memory(), cli).node.data as Record<string, unknown>;
    assert.deepEqual(strip(a), strip(c));
    assert.equal(a.transport, "acp");
    assert.equal(c.transport, undefined);
  });

  it("declares no fs and no terminal, opens the session in the clone with the MCP servers, and records the session", async () => {
    const mcpServers = [{ name: "lean-lsp", command: "uvx", args: ["lean-lsp-mcp"], env: { LEAN_PROJECT_PATH: "{clone}" } }];
    const { result, messages } = await acpRun("good", { extra: { acp: { mcpServers } } });
    assert.equal(result.status, "accepted", result.reason);
    const init = messages.find((m) => m.method === "initialize");
    assert.deepEqual(init?.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.equal(init?.params.protocolVersion, 1);
    const session = messages.find((m) => m.method === "session/new");
    assert.match(session?.params.cwd, /seshat-build-[^/]+\/agent$/);
    assert.deepEqual(session?.params.mcpServers, [{ name: "lean-lsp", command: "uvx", args: ["lean-lsp-mcp"], env: [{ name: "LEAN_PROJECT_PATH", value: session?.params.cwd }] }]);
    const prompt = messages.find((m) => m.method === "session/prompt");
    assert.equal(prompt?.params.sessionId, "sess_fake");
    assert.equal(prompt?.params.prompt[0].type, "text");
    assert.equal(prompt?.params.prompt[0].text, result.provenance.prompt);
    const p = result.provenance;
    assert.equal(p.transport, "acp");
    assert.deepEqual(p.command?.slice(-1), [FAKE_ACP]);
    assert.equal(p.acp?.sessionId, "sess_fake");
    assert.equal(p.acp?.stopReason, "end_turn");
    assert.deepEqual(p.acp?.agent, { protocolVersion: 1, loadSession: true, mcp: { http: true, sse: false }, name: "fake-acp", version: "0.1.0" });
    assert.deepEqual(p.acp?.mcpServers, ["lean-lsp"]);
    assert.deepEqual(p.acp?.usage, { reports: 1, used: 1200, size: 200000, cost: { amount: 0.02, currency: "USD" } });
    assert.deepEqual(p.acp?.permissions.map((x) => [x.kind, x.decision, x.answer]), [["edit", "allow", "allow-once"]]);
    assert.match(p.agentOutput ?? "", /done/);
  });

  it("denies a fetch and any path outside the clone, and journals every answer", async () => {
    const { result } = await acpRun("denied");
    assert.equal(result.status, "accepted", result.reason);
    assert.match(result.provenance.agentOutput ?? "", /fetch allowed: false; outside allowed: false; dotdot allowed: false/);
    const answers = result.provenance.acp?.permissions ?? [];
    assert.deepEqual(answers.map((x) => [x.kind, x.decision, x.answer]), [["fetch", "deny", "reject-once"], ["edit", "deny", "reject-once"], ["edit", "deny", "reject-once"]]);
    assert.match(answers[0]?.reason ?? "", /deny the tool kind fetch/);
    assert.match(answers[1]?.reason ?? "", /\/etc\/passwd is outside the clone/);
    const data = recordBuild(memory(), result).node.data as Record<string, any>;
    assert.deepEqual(data.acp.permissions.map((x: { decision: string }) => x.decision), ["deny", "deny", "deny"]);
    // A person may allow a fetch: the network is then the sandbox's to refuse.
    const open = await acpRun("denied", { extra: { acp: { deny: [] } } });
    assert.deepEqual(open.result.provenance.acp?.permissions.map((x) => x.decision), ["allow", "deny", "deny"]);
  });

  it("refuses fs and terminal requests, so nothing is written for the agent and nothing is kept", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "mh-acp-out-")), "planted.txt");
    const { result } = await acpRun("fs_outside", { extra: { env: { FAKE_SCENARIO: "fs_outside", FAKE_OUTSIDE: outside } } });
    assert.equal(existsSync(outside), false);
    assert.match(result.provenance.agentOutput ?? "", /write error: -32601; read error: -32601; terminal error: -32601/);
    assert.deepEqual(result.provenance.acp?.refused.map((r) => r.method), ["fs/write_text_file", "fs/read_text_file", "terminal/create"]);
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /the agent changed nothing/);
    assert.deepEqual(result.files, []);
  });

  it("keeps nothing the gate refuses, whatever the transport", async () => {
    const { result, h } = await acpRun("outside_spec");
    assert.equal(result.status, "rejected");
    assert.equal(failedRule(result), "diff");
    assert.match(result.reason, /lean\/Other\/Elsewhere\.lean: outside/);
    assert.equal(h.certifier.calls.length, 0);
  });

  it("sends session/cancel at the time limit, and the job fails", async () => {
    const started = performance.now();
    const { result, messages, h } = await acpRun("hang", { options: { budget: { seconds: 0.5 }, timeoutSec: 1 } });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /did not finish within 0.5 seconds/);
    assert.deepEqual(messages.filter((m) => m.method === "session/cancel").map((m) => m.params), [{ sessionId: "sess_fake" }]);
    assert.equal(result.provenance.acp?.cancelled, "timeout");
    assert.equal(result.provenance.acp?.stopReason, "cancelled");
    assert.equal(h.certifier.calls.length, 0);
    assert.ok(performance.now() - started < 10_000);
  });

  it("kills an agent that ignores the cancel after the grace period, and one that never answers", async () => {
    for (const scenario of ["deaf", "silent"]) {
      const started = performance.now();
      const { result, messages } = await acpRun(scenario, { options: { budget: { seconds: 0.5 }, timeoutSec: 1 }, extra: { acp: { cancelGraceSec: 0.3 } } });
      assert.equal(result.status, "failed", scenario);
      assert.match(result.reason, /did not finish within 0.5 seconds/, scenario);
      assert.ok(performance.now() - started < 10_000, scenario);
      if (scenario === "silent") {
        assert.equal(messages.some((m) => m.method === "session/prompt"), false, "no prompt before initialize is answered");
        assert.equal(result.provenance.acp?.cancelled, undefined);
      } else assert.equal(result.provenance.acp?.cancelled, "timeout");
    }
  });

  it("fails, and keeps nothing, when the agent speaks no ACP, another version of it, or writes a line without end", async () => {
    const garbage = await acpRun("garbage");
    assert.equal(garbage.result.status, "failed");
    assert.match(garbage.result.reason, /the agent did not start: acp: the agent exited before answering initialize/);
    assert.match(garbage.result.provenance.agentOutput ?? "", /no protocol here/);
    assert.equal(garbage.result.provenance.acp?.ignoredLines, 2);
    const version = await acpRun("bad_version");
    assert.equal(version.result.status, "failed");
    assert.match(version.result.reason, /protocol version 99, and Seshat speaks 1/);
    assert.equal(version.messages.some((m) => m.method === "session/new"), false);
    const long = await acpRun("long_line", { builder: { agentRunner: acpAgentRunner({ maxLineBytes: 1000 }) } });
    assert.equal(long.result.status, "failed");
    assert.match(long.result.reason, /a line longer than 1000 bytes/);
    for (const r of [garbage, version, long]) assert.deepEqual(r.result.files, []);
  });

  it("ignores lines that are not JSON-RPC, and judges the files whatever the turn's end", async () => {
    const between = await acpRun("garbage_between");
    assert.equal(between.result.status, "accepted", between.result.reason);
    assert.equal(between.result.provenance.acp?.ignoredLines, 2);
    for (const scenario of ["prompt_error", "exit_mid_turn"]) {
      const { result } = await acpRun(scenario);
      assert.equal(result.status, "accepted", `${scenario}: ${result.reason}`);
    }
  });

  it("cancels the turn when the reported cost reaches the dollar budget, and judges what was written", async () => {
    const { result, messages } = await acpRun("budget", { options: { budget: { usd: 1, seconds: 60 }, timeoutSec: 60 } });
    assert.equal(result.provenance.acp?.cancelled, "budget");
    assert.equal(result.provenance.acp?.stopReason, "cancelled");
    assert.equal(messages.filter((m) => m.method === "session/cancel").length, 1);
    assert.equal(result.status, "accepted", result.reason);
  });

  it("reports an abort as an abort, after a cancel", async () => {
    const controller = new AbortController();
    const h = harness();
    const { settings, log } = acpSettings("hang");
    const pending = h.builder("hang", {}, settings).build(SPEC, { ...OPTIONS, signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    assert.equal(result.reason, "the build was aborted");
    assert.equal(sent(log).filter((m) => m.method === "session/cancel").length, 1);
  });

  it("gives the agent the same environment as the CLI transport: PATH, a home and the settings' variables only", async () => {
    process.env.HARNESS_SECRET_KEY = "do-not-leak";
    try {
      const { result } = await acpRun("good", { extra: { env: { FAKE_SCENARIO: "good", AGENT_API_KEY: "k" } } });
      const keys = /env keys: (.*)/.exec(result.provenance.agentOutput ?? "")?.[1]?.split(",") ?? [];
      assert.deepEqual(keys.filter((k) => !["PATH", "HOME", "TMPDIR", "FAKE_SCENARIO", "AGENT_API_KEY", "PWD", "SHLVL", "_", "OLDPWD"].includes(k)), []);
      assert.deepEqual(result.provenance.envKeys, ["AGENT_API_KEY", "FAKE_SCENARIO", "HOME", "PATH", "TMPDIR"]);
      assert.ok(!JSON.stringify(result.provenance).includes("do-not-leak"));
    } finally {
      delete process.env.HARNESS_SECRET_KEY;
    }
  });

  it("checks the settings: a command for the transport, known tool kinds, the sandbox rule", () => {
    const make = (settings: AgentSettings) => new CodingAgentBuilder({ settings, repo: "/nowhere", certifierFor: () => ({}) as never });
    assert.throws(() => make({ agent: "agy", transport: "acp", unsandboxed: true }), /agy has no default acp command: set command/);
    assert.throws(() => make({ agent: "gemini", unsandboxed: true }), /gemini has no default cli command/);
    assert.throws(() => make({ agent: "gemini", transport: "acp", unsandboxed: true, acp: { deny: ["network"] } }), /unknown tool kinds: network/);
    assert.throws(() => make({ agent: "gemini", transport: "acp" }), /needs a sandbox command/);
    assert.throws(() => make({ agent: "pi", transport: "ssh" as never, unsandboxed: true }), /unknown transport ssh/);
    assert.ok(make({ agent: "gemini", transport: "acp", unsandboxed: true }));
    assert.deepEqual(renderCommand({ agent: "gemini", transport: "acp", sandbox: ["bwrap"] }, {}, 60), ["bwrap", "gemini", "--experimental-acp"]);
    assert.deepEqual(renderCommand({ agent: "claude-code", transport: "acp", unsandboxed: true }, { usd: 3 }, 60), ["claude-agent-acp"]);
  });
});

describe("the CLI transport is unchanged (EA2)", () => {
  it("records no transport and no ACP session, and starts the program as before", async () => {
    const result = await harness().builder("good").build(SPEC, OPTIONS);
    assert.equal(result.status, "accepted");
    assert.equal("transport" in result.provenance, false);
    assert.equal("acp" in result.provenance, false);
    const data = recordBuild(memory(), result).node.data as Record<string, unknown>;
    assert.equal("transport" in data, false);
    assert.equal("acp" in data, false);
    // `transport: "cli"` said aloud is the default.
    const said = await harness().builder("good", {}, { transport: "cli" }).build(SPEC, OPTIONS);
    assert.equal(said.status, "accepted");
    assert.equal("transport" in said.provenance, false);
    assert.deepEqual(said.provenance.command, result.provenance.command);
  });
});

describe("the permission policy", () => {
  it("places a path inside or outside the clone, through links", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-acp-root-"));
    mkdirSync(join(root, "lean"));
    symlinkSync("/etc", join(root, "lean", "out"));
    assert.equal(insideDirectory(root, join(root, "lean", "New.lean")), true);
    assert.equal(insideDirectory(root, "lean/deep/New.lean"), true);
    assert.equal(insideDirectory(root, root), true);
    assert.equal(insideDirectory(root, join(root, "..", "x")), false);
    assert.equal(insideDirectory(root, "/etc/passwd"), false);
    assert.equal(insideDirectory(root, join(root, "lean", "out", "passwd")), false, "a link out of the clone is outside");
    assert.equal(insideDirectory(root, `${root}-sibling/x`), false);
    const request = { toolCallId: "c", kind: "edit", paths: [join(root, "a.lean")], options: [] };
    assert.equal(decidePermission(request, { clone: root, deny: [] }).decision, "allow");
    assert.equal(decidePermission({ ...request, kind: "execute" }, { clone: root, deny: ["execute"] }).decision, "deny");
    assert.equal(decidePermission({ ...request, paths: [join(root, "a.lean"), "/tmp/x"] }, { clone: root, deny: [] }).decision, "deny");
  });

  it("resolves each component physically: the root's first character, `..` after a link, `~`, URIs and NUL", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-acp-root-"));
    mkdirSync(join(root, "d"));
    mkdirSync(join(root, "lean", "sub"), { recursive: true });
    symlinkSync("/etc", join(root, "d", "link"));
    symlinkSync(join(root, "lean", "sub"), join(root, "lean", "in"));
    // A path that does not exist from its first component on: the walk reaches `/`, where one character too many was cut.
    assert.equal(insideDirectory(root, `/X${root.slice(1)}/evil`), false);
    // `..` after a link is the parent of the link's target (/etc/.. is /), not the directory that holds the link.
    assert.equal(insideDirectory(root, join(root, "d") + "/link/../passwd"), false);
    assert.equal(insideDirectory(root, "d/link/../passwd"), false);
    assert.equal(insideDirectory(root, `${root}/lean/in/../x.lean`), true, "a link inside the clone stays inside");
    assert.equal(insideDirectory(root, `${root}/lean/new/../x.lean`), false, "a `..` after a part that does not exist is refused");
    for (const path of ["~/x.lean", "~root/.ssh/x", `file://${root}/a.lean`, `file:${root}/a.lean`, `${root}/a\0b`, ""]) {
      assert.equal(insideDirectory(root, path), false, JSON.stringify(path));
    }
    assert.equal(insideDirectory("/", "/etc/passwd"), true, "everything is inside the root directory");
    // A path the walk cannot resolve is denied with the reason, never thrown.
    const long = decidePermission({ toolCallId: "c", kind: "edit", paths: [`${root}/${"a".repeat(300)}/x`], options: [] }, { clone: root, deny: [] });
    assert.equal(long.decision, "deny");
    assert.match(long.reason, /could not be resolved: ENAMETOOLONG/);
  });
});

describe("probeAcp (harness doctor --agents)", () => {
  it("sends initialize and nothing else, and reads the agent's capabilities", async () => {
    const { log } = acpSettings("good");
    const probe = await probeAcp([process.execPath, FAKE_ACP], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", FAKE_SCENARIO: "good", FAKE_LOG: log }, timeoutMs: 10_000 });
    assert.equal(probe.ok, true);
    if (probe.ok) assert.deepEqual(probe.agent, { protocolVersion: 1, loadSession: true, mcp: { http: true, sse: false }, name: "fake-acp", version: "0.1.0" });
    assert.deepEqual(sent(log).map((m) => m.method), ["initialize"]);
  });

  it("says why when the agent does not answer", async () => {
    const silent = await probeAcp([process.execPath, FAKE_ACP], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", FAKE_SCENARIO: "silent" }, timeoutMs: 300 });
    assert.deepEqual([silent.ok, silent.ok ? "" : silent.reason], [false, "no answer to initialize within 0.3 s"]);
    const garbage = await probeAcp([process.execPath, FAKE_ACP], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", FAKE_SCENARIO: "garbage" }, timeoutMs: 5000 });
    assert.equal(garbage.ok, false);
    if (!garbage.ok) assert.match(garbage.reason, /exited before answering initialize \(it said: fatal: no protocol here\)/);
    const missing = await probeAcp(["/nonexistent/agent-acp"], { cwd: tmpdir(), env: {}, timeoutMs: 5000 });
    assert.equal(missing.ok, false);
  });
});
