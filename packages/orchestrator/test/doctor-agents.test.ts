import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadHostProfile } from "@seshat/registry";
import { codingAgentChecks } from "../src/doctor-agents.ts";
import { doctor, type DoctorSystem, realSystem, renderDoctor, REPO_ROOT } from "../src/index.ts";
import { fauxModels, tempDir } from "./m0-helpers.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "library-builder", "test", "fixtures", "fake-acp-agent.mjs");

/** A library-builder config file with this agent section, selecting `builder`. */
function config(agent: unknown, builder = "coding-agent"): string {
  const path = join(tempDir("mh-doctor-agents-"), "library-builder.json");
  writeFileSync(path, JSON.stringify({ builder, "coding-agent": { agent, repo: "/p", certifier: {} } }));
  return path;
}

/** A machine that has the commands named, and whose programs answer as `answers` says; every call is kept. */
function machine(o: { has?: string[]; answers?: (command: string, args: readonly string[]) => { code: number; stdout: string; stderr: string }; env?: Record<string, string>; calls?: Array<{ argv: string[]; env?: Record<string, string> }> } = {}): DoctorSystem {
  const has = new Set(o.has ?? []);
  return {
    env: o.env ?? {},
    which: (c) => (has.has(c) ? `/usr/bin/${c}` : undefined),
    run: async (c, args, _t, options) => {
      o.calls?.push({ argv: [c, ...args], ...(options?.env !== undefined ? { env: options.env } : {}) });
      return (o.answers ?? (() => ({ code: 0, stdout: "", stderr: "" })))(c, args);
    },
    http: async () => ({ status: 200 }),
    ids: () => undefined,
  };
}

const CLAUDE_HELP = "Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --verbose\n  --permission-mode <mode>\n  --model <model>\n";

describe("harness doctor: the coding agents (EA1)", () => {
  it("shows nothing when the config selects none and --agents is not given", async () => {
    assert.equal(await codingAgentChecks(machine(), { configPath: config({ agent: "claude-code" }, "none"), all: false }), undefined);
    assert.equal(await codingAgentChecks(machine(), { configPath: "/nonexistent/library-builder.json", all: false }), undefined);
  });

  it("reports a fake ACP agent that answers initialize as ready, with its version, and sends nothing else", async () => {
    const log = join(tempDir("mh-doctor-acp-"), "messages.jsonl");
    const system: DoctorSystem = { ...realSystem(), env: { PATH: process.env.PATH ?? "" } };
    const checks = await codingAgentChecks(system, { configPath: config({ agent: "gemini", transport: "acp", command: [process.execPath, FAKE_ACP], env: { FAKE_SCENARIO: "good", FAKE_LOG: log }, unsandboxed: true }), all: false });
    assert.equal(checks?.length, 1);
    const check = checks?.[0];
    assert.equal(check?.status, "ok", check?.detail);
    assert.equal(check?.title, "Coding agent gemini (acp, configured)");
    assert.match(check?.detail ?? "", /^fake-acp 0\.1\.0 \(/);
    assert.match(check?.detail ?? "", /answered initialize in \d+ ms: protocol version 1, loadSession yes, MCP over http yes, over sse no, agent fake-acp 0\.1\.0/);
    assert.match(check?.detail ?? "", /No prompt was sent and no model was called/);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).method), ["initialize"]);
  });

  it("says when an ACP agent does not answer, without failing the doctor", async () => {
    const system: DoctorSystem = { ...realSystem(), env: { PATH: process.env.PATH ?? "" } };
    const checks = await codingAgentChecks(system, { configPath: config({ agent: "gemini", transport: "acp", command: [process.execPath, FAKE_ACP], env: { FAKE_SCENARIO: "garbage" }, unsandboxed: true }), all: false });
    assert.equal(checks?.[0]?.status, "warn");
    assert.match(checks?.[0]?.detail ?? "", /did not answer initialize: the program exited before answering initialize/);
  });

  it("reports a missing command as missing, a warning and not an error of the doctor", async () => {
    const checks = await codingAgentChecks(machine(), { configPath: config({ agent: "claude-code", unsandboxed: true }), all: false });
    assert.equal(checks?.[0]?.status, "warn");
    assert.match(checks?.[0]?.detail ?? "", /`claude` is not installed here: it is not on your PATH \(missing\)/);
    const absolute = await codingAgentChecks(machine(), { configPath: config({ agent: "pi", command: ["/nonexistent/pi", "-p"], unsandboxed: true }), all: false });
    assert.match(absolute?.[0]?.detail ?? "", /`\/nonexistent\/pi` is not installed/);
  });

  it("checks the flags of the non-interactive mode against its help, and names a flag the release does not list", async () => {
    const calls: Array<{ argv: string[] }> = [];
    const answers = (_c: string, args: readonly string[]) => (args.includes("--version") ? { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" } : { code: 0, stdout: CLAUDE_HELP, stderr: "" });
    const checks = await codingAgentChecks(machine({ has: ["claude"], answers, calls }), { configPath: config({ agent: "claude-code", model: "m-1", unsandboxed: true }), all: false });
    const check = checks?.[0];
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /^2\.1\.300 \(Claude Code\) \(\/usr\/bin\/claude\)/);
    assert.match(check?.detail ?? "", /`claude --help` does not name --max-budget-usd, which the command passes/);
    assert.deepEqual(calls.map((c) => c.argv), [["claude", "--version"], ["claude", "--help"]]);
    const full = await codingAgentChecks(machine({ has: ["claude"], answers: (_c, args) => ({ code: 0, stdout: args.includes("--help") ? `${CLAUDE_HELP}  --max-budget-usd <amount>\n` : "2.1.300\n", stderr: "" }) }), { configPath: config({ agent: "claude-code", unsandboxed: true }), all: false });
    assert.equal(full?.[0]?.status, "ok", full?.[0]?.detail);
    assert.match(full?.[0]?.detail ?? "", /names every flag the command passes \(-p, --output-format, --verbose, --permission-mode, --model, --max-budget-usd\)/);
    // codex's non-interactive mode is a subcommand: its help is asked of the subcommand.
    const codexCalls: Array<{ argv: string[] }> = [];
    await codingAgentChecks(machine({ has: ["codex"], calls: codexCalls }), { configPath: config({ agent: "codex", unsandboxed: true }), all: false });
    assert.deepEqual(codexCalls.map((c) => c.argv), [["codex", "--version"], ["codex", "exec", "--help"]]);
  });

  it("runs the checks with the agent's environment only, behind its sandbox, and never prints a key", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const answers = () => ({ code: 0, stdout: "agent 1.0 key=sk-secret-value\n", stderr: "" });
    const checks = await codingAgentChecks(machine({ has: ["claude"], answers, calls, env: { PATH: "/bin", LB_KEY: "sk-secret-value", HARNESS_KEY: "h" } }), {
      configPath: config({ agent: "claude-code", env: { ANTHROPIC_API_KEY: "${env:LB_KEY}", OTHER: "${env:NOT_SET}" }, sandbox: ["bwrap", "--ro-bind", "/", "/"] }),
      all: false,
    });
    const text = renderDoctor({ host: "h", checks: checks ?? [], ok: true }).join("\n");
    assert.ok(!text.includes("sk-secret-value"), text);
    assert.match(text, /key=\[hidden\]/);
    assert.match(text, /the config names NOT_SET, which is not set/);
    assert.deepEqual(calls[0]?.argv.slice(0, 5), ["bwrap", "--ro-bind", "/", "/", "claude"]);
    assert.deepEqual(Object.keys(calls[0]?.env ?? {}).sort(), ["ANTHROPIC_API_KEY", "HOME", "PATH", "TMPDIR"]);
    assert.match(calls[0]?.env?.HOME ?? "", /seshat-doctor-agent-/);
  });

  it("never prints a value that a ${env:NAME} put in the command, over ACP or the CLI", async () => {
    const env = { PATH: process.env.PATH ?? "", LB_KEY: "sk-in-the-command" };
    const acp = await codingAgentChecks({ ...realSystem(), env }, {
      configPath: config({ agent: "gemini", transport: "acp", command: [process.execPath, FAKE_ACP, "--key=${env:LB_KEY}"], env: { FAKE_SCENARIO: "good" }, unsandboxed: true }),
      all: false,
    });
    const answers = (_c: string, args: readonly string[]) => (args.includes("--version") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "usage", stderr: "" });
    const cli = await codingAgentChecks(machine({ has: ["claude"], answers, env }), { configPath: config({ agent: "claude-code", command: ["claude", "${env:LB_KEY}", "-p"], unsandboxed: true }), all: false });
    const text = renderDoctor({ host: "h", checks: [...(acp ?? []), ...(cli ?? [])], ok: true }).join("\n");
    assert.match(text, /answered initialize/);
    assert.match(text, /`claude \[hidden\] --help`/);
    assert.ok(!text.includes("sk-in-the-command"), text);
  });

  it("with --agents lists every default agent, the installed ones checked and the others in one line", async () => {
    const calls: Array<{ argv: string[] }> = [];
    const checks = await codingAgentChecks(machine({ has: ["codex"], calls }), { configPath: "/nonexistent/library-builder.json", all: true });
    const titles = (checks ?? []).map((c) => c.title);
    assert.deepEqual(titles, ["Coding agent codex (cli)", "Coding agents not installed"]);
    const absent = checks?.find((c) => c.title === "Coding agents not installed")?.detail ?? "";
    for (const name of ["claude-code (cli: claude)", "claude-code (acp: claude-agent-acp)", "codex (acp: codex-acp)", "gemini (acp: gemini)", "goose (acp: goose)", "hermes (acp: hermes)", "pi (acp: pi-acp)", "agy (cli: agy)"]) assert.ok(absent.includes(name), name);
    assert.ok(!calls.some((c) => c.argv[0] !== "codex"), "only what is installed is run");
  });

  it("joins the doctor's report as warnings, so that a run's readiness does not change", async () => {
    const dir = tempDir("mh-doctor-cfg-");
    mkdirSync(join(dir, "hosts"), { recursive: true });
    cpSync(join(REPO_ROOT, "config", "hosts", "local.json"), join(dir, "hosts", "local.json"));
    const { models } = fauxModels(3);
    const base = machine({ has: ["lake", "bwrap", "prlimit"] });
    const report = await doctor({ system: base, models, profile: loadHostProfile(join(dir, "hosts", "local.json")), configDir: dir, leanProject: "/lean", write: "never", agents: { configPath: config({ agent: "claude-code", unsandboxed: true }), all: false } });
    const without = await doctor({ system: base, models, profile: loadHostProfile(join(dir, "hosts", "local.json")), configDir: dir, leanProject: "/lean", write: "never" });
    assert.equal(report.ok, without.ok);
    assert.deepEqual(report.checks.slice(0, without.checks.length), without.checks);
    assert.deepEqual(report.checks.slice(without.checks.length).map((c) => [c.id, c.status]), [["coding-agent", "warn"]]);
    const lines = renderDoctor(report);
    assert.ok(lines.includes("Coding agents (the library builder's; a run does not need them):"));
    assert.ok(!renderDoctor(without).some((l) => l.startsWith("Coding agents")));
  });
});
