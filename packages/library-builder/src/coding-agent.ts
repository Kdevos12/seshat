import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeanCertifier } from "@seshat/core";
import { type CommandRunner, spawnRunner } from "@seshat/lean-env";
import { type AgentRunner, type AgentSettings, agentEnvironment, promptHash, renderCommand, renderPrompt, sandboxProblem, spawnAgent } from "./agent.ts";
import { type BuildOptions, type BuildProvenance, type BuildStatus, type LibraryBuildResult, type LibraryBuilder, newBuildId } from "./builder.ts";
import { changesFrom, DEFAULT_LIMITS, type DiffLimits } from "./diff.ts";
import { gateRunner } from "./runner.ts";
import { type BuildPlan, runGate } from "./gate.ts";
import { type LibrarySpec, specProblems } from "./spec.ts";

export interface CodingAgentOptions {
  settings: AgentSettings;
  /**
   * The project the agent works on: a git repository whose tree is a Lake project (the environment's), with the library's
   * Lean files under `build.libRoot`. The agent works in a clone of it, never in it.
   */
  repo: string;
  /** The certifier for a project directory: the fresh checkout of the gate, whose built modules the new files import. */
  certifierFor: (projectDir: string) => LeanCertifier;
  build?: BuildPlan;
  limits?: DiffLimits;
  maxTheorems?: number;
  /** Where the clones are made. Default: the system's temporary directory. */
  workRoot?: string;
  /** The ref the agent starts from. Default `HEAD`. */
  ref?: string;
  /** Runs `git` and `lake`, behind `gateRunner` (allowlisted environment, the agent's sandbox). Default: starts the programs. */
  run?: CommandRunner;
  /** Starts the agent. Default: starts the program. */
  agentRunner?: AgentRunner;
  log?: (line: string) => void;
  /** The environment the agent's `PATH` is read from. Default: the process's. */
  parentEnv?: Readonly<Record<string, string | undefined>>;
}

const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * The `coding-agent` builder (plan change LC4). It clones the project, runs an external CLI agent in the clone,
 * non-interactively, with the prompt on standard input and only the environment the settings name, and then judges what
 * the agent left by Seshat's gate (`runGate`), which the agent never touches: the diff is read from the files, not from the clone's
 * git directory; the gate builds its own fresh checkout; the certifier is Seshat's. The agent's own word is not used for anything.
 * Written against the agents' command lines and run here only with a fake agent script (documentation/library-builder.md).
 */
export class CodingAgentBuilder implements LibraryBuilder {
  readonly id = "coding-agent";
  readonly #o: CodingAgentOptions;

  constructor(options: CodingAgentOptions) {
    const refusal = sandboxProblem(options.settings);
    if (refusal !== undefined) throw new Error(`coding-agent: ${refusal}`);
    this.#o = options;
  }

  async build(spec: LibrarySpec, options: BuildOptions): Promise<LibraryBuildResult> {
    const o = this.#o;
    const startedAt = new Date().toISOString();
    const buildId = newBuildId();
    const provenance: BuildProvenance = {
      builder: this.id,
      agent: o.settings.agent,
      ...(o.settings.model !== undefined ? { model: o.settings.model } : {}),
      budget: options.budget,
      timeoutSec: options.timeoutSec,
      startedAt,
      finishedAt: startedAt,
    };
    const result = (status: BuildStatus, reason: string, extra: Partial<LibraryBuildResult> = {}): LibraryBuildResult => ({
      buildId,
      status,
      job: spec.job,
      domain: spec.domain,
      spec,
      reason,
      gate: [],
      files: [],
      theorems: [],
      definitions: [],
      needsApproval: false,
      diff: "",
      ...extra,
      provenance: { ...provenance, finishedAt: new Date().toISOString() },
    });

    const problems = specProblems(spec);
    if (problems.length > 0) return result("failed", `the spec is not valid: ${problems.join("; ")}`);

    const root = mkdtempSync(join(o.workRoot ?? tmpdir(), "seshat-build-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const run = gateRunner(o.run ?? spawnRunner, { settings: o.settings, home: join(root, "gate-home"), ...(o.parentEnv !== undefined ? { parentEnv: o.parentEnv } : {}), ...(o.build?.env !== undefined ? { env: o.build.env } : {}) });
      mkdirSync(join(root, "gate-home"), { recursive: true });
      const git = async (args: readonly string[], cwd: string) => await run("git", [...GIT, ...args], { cwd, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
      const rev = await git(["rev-parse", "--verify", `${o.ref ?? "HEAD"}^{commit}`], o.repo);
      if (rev.code !== 0) return result("failed", `the project ${o.repo} has no commit ${o.ref ?? "HEAD"}: ${rev.output.trim()}`);
      const base = rev.output.trim().split("\n").pop() as string;
      provenance.baseCommit = base;
      if (options.approvedBy !== undefined) provenance.approvedBy = options.approvedBy;
      const tree = await git(["ls-tree", "-r", "-z", "--full-tree", base], o.repo);
      if (tree.code !== 0) return result("failed", `cannot list the project's tree: ${tree.output.trim()}`);
      const known = new Map<string, string>();
      for (const entry of tree.output.split("\0")) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
        if (m !== null) known.set(m[2] as string, m[1] as string);
      }

      // The agent's clone, and a home of its own that holds nothing. The clone keeps no remote: the project's path is not something to fetch from.
      const work = join(root, "agent");
      const cloned = await git(["clone", "--quiet", "--local", "--no-hardlinks", o.repo, work], root);
      if (cloned.code === 0) await git(["checkout", "--quiet", "--detach", base], work);
      if (cloned.code === 0) await git(["remote", "remove", "origin"], work);
      if (cloned.code !== 0 || !existsSync(work)) return result("failed", `cannot clone the project: ${cloned.output.trim()}`);

      const prompt = renderPrompt(spec);
      const argv = renderCommand(o.settings, options.budget, options.timeoutSec);
      const env = agentEnvironment(o.settings, home, o.parentEnv);
      provenance.prompt = prompt;
      provenance.promptHash = promptHash(prompt);
      provenance.command = argv;
      provenance.envKeys = Object.keys(env).sort();
      const agentRun = await (o.agentRunner ?? spawnAgent)(argv, {
        cwd: work,
        env,
        stdin: prompt,
        timeoutMs: (options.budget.seconds ?? options.timeoutSec) * 1000,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      provenance.agentOutput = agentRun.output;
      provenance.agentMs = agentRun.ms;
      if (agentRun.aborted) return result("failed", "the build was aborted");
      if (agentRun.timedOut) return result("failed", `the agent did not finish within ${options.budget.seconds ?? options.timeoutSec} seconds`);
      if (agentRun.code === null) return result("failed", `the agent did not start: ${agentRun.output.trim().split("\n").pop() ?? ""}`);
      // The exit code is not a verdict: an agent that exits 1 after writing good files is judged by its files, and one that exits 0 by the same.

      let changes;
      try {
        changes = changesFrom(work, known, (o.limits ?? DEFAULT_LIMITS).maxBytesPerFile);
      } catch (error) {
        return result("failed", `the agent's directory could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const gate = await runGate({
        spec,
        changes,
        repo: o.repo,
        base,
        ...(options.approvedBy !== undefined ? { approvedBy: options.approvedBy } : {}),
        run,
        certifierFor: o.certifierFor,
        ...(o.build !== undefined ? { build: o.build } : {}),
        ...(o.limits !== undefined ? { limits: o.limits } : {}),
        ...(o.maxTheorems !== undefined ? { maxTheorems: o.maxTheorems } : {}),
        workRoot: root,
        certifyTimeoutSec: options.timeoutSec,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(o.log !== undefined ? { log: o.log } : {}),
      });
      const failedRule = gate.checks.find((c) => !c.ok);
      const status: BuildStatus = gate.verdict === "accepted" ? "accepted" : gate.verdict === "rejected" ? "rejected" : "failed";
      const reason =
        status === "accepted"
          ? `the gate accepts ${gate.files.length} file(s): ${gate.theorems.length} theorem(s) certified, ${gate.definitions.length} definition(s) recorded unreviewed`
          : `the gate ${status === "rejected" ? "rejects the work" : "could not decide"} at ${failedRule?.rule ?? "?"}: ${failedRule?.detail ?? ""}`;
      return result(status, reason, {
        gate: gate.checks,
        files: gate.files,
        theorems: gate.theorems,
        definitions: gate.definitions,
        needsApproval: gate.needsApproval,
        diff: gate.diff,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

