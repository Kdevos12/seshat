import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS,
  type AgentName,
  type AgentSettings,
  agentEnvironment,
  type AcpProbe,
  DEFAULT_ACP_COMMANDS,
  DEFAULT_COMMANDS,
  maskSecrets,
  probeAcp,
  probePlan,
  settingsProblem,
  type Transport,
} from "@seshat/library-builder";
import type { Check, DoctorSystem } from "./doctor.ts";

/**
 * The "coding agents" section of `harness doctor` (plan change EA1, documentation/library-builder.md, "Checking the agents"): for
 * each configured agent, whether its program is installed and its version, for the CLI transport whether the help of its
 * non-interactive mode names every flag Seshat passes, and for ACP whether it answers `initialize` within 10 seconds. It costs
 * nothing: no prompt, no session, no model call. No value of the agent's environment is ever printed. Everything it finds is a
 * warning at worst, because a run does not need a coding agent.
 */

export interface AgentsCheckOptions {
  /** `config/library-builder.json`: the section is shown when it selects `coding-agent`. */
  configPath: string;
  /** `--agents`: the section is shown whatever the config selects, with every agent of the default tables as well. */
  all: boolean;
  /** Sends `initialize` to an ACP agent. Default: `probeAcp`. */
  probe?: typeof probeAcp;
}

const ACP_TIMEOUT_MS = 10_000;

/**
 * The settings of the config's agent, with `${env:NAME}` expanded; a name that is not set is listed, never guessed, never shown.
 * `secrets` holds every value an expansion put in, wherever it was (the command, the sandbox, the variables), and the agent's
 * variables: none of them is printed.
 */
function expandAgent(raw: Record<string, unknown>, env: DoctorSystem["env"]): { settings: AgentSettings; unset: string[]; secrets: string[] } {
  const unset = new Set<string>();
  const secrets = new Set<string>();
  /** The text with its variables filled, or undefined when one of them is not set. */
  const fill = (text: string): string | undefined => {
    let complete = true;
    const out = text.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (v !== undefined && v !== "") {
        secrets.add(v);
        return v;
      }
      unset.add(name);
      complete = false;
      return "";
    });
    return complete ? out : undefined;
  };
  const expand = (value: unknown): unknown => {
    if (typeof value === "string") return fill(value) ?? "";
    if (Array.isArray(value)) return value.map(expand);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
    return value;
  };
  const { env: own, ...rest } = raw;
  const settings = expand(rest) as AgentSettings;
  // A variable of the agent's whose value names an unset variable is left out, as a build would refuse it: the checks run without it.
  if (own !== null && typeof own === "object") {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(own)) {
      const value = typeof v === "string" ? fill(v) : undefined;
      if (value !== undefined) vars[k] = value;
    }
    settings.env = vars;
    for (const v of Object.values(vars)) secrets.add(v);
  }
  return { settings, unset: [...unset].sort(), secrets: [...secrets] };
}

/** Text made safe to print: every secret of the config is hidden (`maskSecrets`), and it is cut to a line. */
function shown(text: string, secrets: readonly string[]): string {
  const out = maskSecrets(text.trim().split("\n")[0] ?? "", secrets);
  return out.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
}

function executable(system: DoctorSystem, program: string): string | undefined {
  if (!program.includes("/")) return system.which(program);
  try {
    accessSync(program, constants.X_OK);
    return program;
  } catch {
    return undefined;
  }
}

/** One agent: installed or not, and the check that says what was found. */
async function checkAgent(system: DoctorSystem, settings: AgentSettings, o: { probe: typeof probeAcp; unset?: readonly string[]; secrets?: readonly string[]; configured: boolean }): Promise<{ installed: boolean; check: Check }> {
  const transport: Transport = settings.transport ?? "cli";
  const secrets = [...(o.secrets ?? []), ...Object.values(settings.env ?? {})];
  const title = shown(`Coding agent ${settings.agent} (${transport}${o.configured ? ", configured" : ""})`, secrets);
  const problem = settingsProblem({ ...settings, ...(o.configured ? {} : { unsandboxed: true }) });
  if (problem !== undefined && !/needs a sandbox command/.test(problem)) {
    return { installed: false, check: { id: "coding-agent", status: "warn", title, detail: `The settings cannot make a builder: ${shown(problem, secrets)}.`, fix: "Correct the agent section of config/library-builder.json (documentation/library-builder.md, \"Config\")." } };
  }
  const plan = probePlan(settings);
  const path = executable(system, plan.program);
  if (path === undefined) {
    return {
      installed: false,
      check: {
        id: "coding-agent",
        status: "warn",
        title,
        detail: `\`${shown(plan.program, secrets)}\` is not installed here: it is not on your PATH (missing).`,
        fix: o.configured ? "Install the agent, or set agent.command in config/library-builder.json to the command that starts it." : `Install ${settings.agent} if you mean to use it; nothing needs it otherwise.`,
      },
    };
  }
  const home = mkdtempSync(join(tmpdir(), "seshat-doctor-agent-"));
  try {
    const env = agentEnvironment(settings, home, system.env);
    const notes: string[] = [];
    let warn = false;
    const [vProgram, ...vArgs] = plan.version as [string, ...string[]];
    const version = await system.run(vProgram, vArgs, 15_000, { env, cwd: home });
    const said = shown(version.stdout || version.stderr, secrets);
    notes.push(version.code === 0 && said !== "" ? `${said} (${shown(path, secrets)})` : `installed at ${shown(path, secrets)}, no version (\`${shown(plan.program, secrets)} --version\` exited ${version.code})`);
    if (plan.help !== undefined) {
      const [hProgram, ...hArgs] = plan.help as [string, ...string[]];
      const help = await system.run(hProgram, hArgs, 15_000, { env, cwd: home });
      const text = `${help.stdout}\n${help.stderr}`;
      const missing = plan.flags.filter((f) => !text.includes(f));
      const shownHelp = plan.help.slice((settings.sandbox ?? []).length).join(" ");
      if (help.code !== 0 && help.stdout.trim() === "") {
        warn = true;
        notes.push(`\`${shown(shownHelp, secrets)}\` failed (exit ${help.code}), so the non-interactive mode's flags could not be checked`);
      } else if (missing.length > 0) {
        warn = true;
        notes.push(`\`${shown(shownHelp, secrets)}\` does not name ${missing.join(", ")}, which the command passes: this release may not take it (some programs do not list every flag)`);
      } else if (plan.flags.length > 0) notes.push(`\`${shown(shownHelp, secrets)}\` names every flag the command passes (${plan.flags.join(", ")})`);
      else notes.push("the command passes no flag");
    } else {
      const answer: AcpProbe = await o.probe(plan.argv, { cwd: home, env, timeoutMs: ACP_TIMEOUT_MS });
      if (answer.ok) {
        const a = answer.agent;
        const yes = (b: boolean) => (b ? "yes" : "no");
        if (a.protocolVersion !== 1) warn = true;
        notes.push(
          `\`${shown(plan.argv.slice((settings.sandbox ?? []).length).join(" "), secrets)}\` answered initialize in ${answer.ms} ms: protocol version ${String(a.protocolVersion)}${a.protocolVersion === 1 ? "" : " (Seshat speaks 1)"}, loadSession ${yes(a.loadSession)}, MCP over http ${yes(a.mcp.http)}, over sse ${yes(a.mcp.sse)}${a.name !== undefined ? `, agent ${shown(`${a.name} ${a.version ?? ""}`, secrets)}` : ""}`,
        );
      } else {
        warn = true;
        notes.push(`\`${shown(plan.argv.slice((settings.sandbox ?? []).length).join(" "), secrets)}\` did not answer initialize: ${shown(answer.reason, secrets)}`);
      }
    }
    if ((o.unset ?? []).length > 0) {
      warn = true;
      notes.push(`the config names ${(o.unset ?? []).join(", ")}, which ${(o.unset ?? []).length === 1 ? "is" : "are"} not set: a build would stop before it starts (the checks ran without ${(o.unset ?? []).length === 1 ? "it" : "them"})`);
    }
    if (o.configured && problem !== undefined) {
      warn = true;
      notes.push(shown(problem, secrets));
    }
    return {
      installed: true,
      check: {
        id: "coding-agent",
        status: warn ? "warn" : "ok",
        title,
        detail: `${notes.join("; ")}. No prompt was sent and no model was called.`,
        ...(warn ? { fix: "Correct agent.command (or the default's flags) in config/library-builder.json for this release, set the variables it names, or give it a sandbox (documentation/library-builder.md)." } : {}),
      },
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The section, or undefined when it is not shown: the config does not select `coding-agent` and `--agents` was not given. */
export async function codingAgentChecks(system: DoctorSystem, o: AgentsCheckOptions): Promise<Check[] | undefined> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = JSON.parse(readFileSync(o.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    if (!o.all) return undefined;
  }
  const selected = raw?.builder === "coding-agent";
  if (!selected && !o.all) return undefined;
  const probe = o.probe ?? probeAcp;
  const checks: Check[] = [];
  const section = (raw?.["coding-agent"] ?? undefined) as { agent?: unknown } | undefined;
  let configured: { agent: AgentName; transport: Transport; custom: boolean } | undefined;
  if (section?.agent !== undefined && section.agent !== null && typeof section.agent === "object") {
    const { settings, unset, secrets } = expandAgent(section.agent as Record<string, unknown>, system.env);
    configured = { agent: settings.agent, transport: settings.transport ?? "cli", custom: settings.command !== undefined };
    checks.push((await checkAgent(system, settings, { probe, unset, secrets, configured: true })).check);
  } else if (selected) {
    checks.push({ id: "coding-agent", status: "warn", title: "Coding agent", detail: `${o.configPath} selects coding-agent but names no agent.`, fix: "Fill in coding-agent.agent (documentation/library-builder.md, \"Config\")." });
  }
  if (o.all) {
    const absent: string[] = [];
    for (const agent of AGENTS) {
      for (const transport of ["cli", "acp"] as const) {
        if ((transport === "cli" ? DEFAULT_COMMANDS : DEFAULT_ACP_COMMANDS)[agent] === undefined) continue;
        if (configured !== undefined && !configured.custom && configured.agent === agent && configured.transport === transport) continue;
        const { installed, check } = await checkAgent(system, { agent, transport }, { probe, configured: false });
        if (installed) checks.push(check);
        else absent.push(`${agent} (${transport}: ${probePlan({ agent, transport }).program})`);
      }
    }
    if (absent.length > 0) checks.push({ id: "coding-agent", status: "warn", title: "Coding agents not installed", detail: `Not on your PATH: ${absent.join(", ")}. Nothing needs them unless config/library-builder.json selects one.` });
  }
  return checks;
}
