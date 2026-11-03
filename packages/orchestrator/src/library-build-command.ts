import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlobStore, Journal } from "@seshat/core";
import { LakeCertifier } from "@seshat/lean-local";
import {
  adoptBuild,
  type AgentSettings,
  type BuildPlan,
  CodingAgentBuilder,
  type LibraryBuilder,
  type LibraryBuildResult,
  type LibrarySpec,
  NoneBuilder,
  openGaps,
  recordBuild,
  specProblems,
} from "@seshat/library-builder";
import { MemoryStore } from "@seshat/memory";
import { REPO_ROOT } from "./implementations.ts";

export const DEFAULT_LIBRARY_BUILDER_CONFIG = join(REPO_ROOT, "config", "library-builder.json");

export class LibraryBuilderConfigError extends Error {}

/** The settings of the `coding-agent` builder as the config file writes them. */
export interface CodingAgentConfig {
  agent: AgentSettings;
  repo: string;
  build?: BuildPlan;
  certifier: { sandbox?: string[]; unsandboxed?: boolean; lean?: string; probe?: string; env?: Record<string, string>; command?: string };
  budget?: { usd?: number; seconds?: number };
  timeoutSec?: number;
}

export interface LibraryBuilderConfig {
  builder: "none" | "coding-agent";
  "coding-agent"?: CodingAgentConfig;
}

/** Replaces `${env:NAME}` by the variable; a variable that is not set is an error, never an empty string (a key is never guessed). */
export function expandEnv(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (v === undefined || v === "") throw new LibraryBuilderConfigError(`the variable ${name}, which the library builder's config names, is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  return value;
}

/** Reads the config. Only the section of the selected builder is expanded, so `none` needs no variable. */
export function loadLibraryBuilderConfig(path: string, env: Readonly<Record<string, string | undefined>> = process.env): LibraryBuilderConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new LibraryBuilderConfigError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.builder !== "none" && raw.builder !== "coding-agent") throw new LibraryBuilderConfigError(`${path}: builder must be none or coding-agent, got ${JSON.stringify(raw.builder)}`);
  if (raw.builder === "none") return { builder: "none" };
  const section = expandEnv(raw["coding-agent"], env) as CodingAgentConfig | undefined;
  if (section === undefined || typeof section.repo !== "string" || section.agent === undefined || section.certifier === undefined) {
    throw new LibraryBuilderConfigError(`${path}: coding-agent needs agent, repo and certifier`);
  }
  return { builder: "coding-agent", "coding-agent": section };
}

/** The builder the config selects. Throws when the sandbox rules are not met (the agent's, the certifier's). */
export function makeLibraryBuilder(config: LibraryBuilderConfig): { builder: LibraryBuilder; budget: { usd?: number; seconds?: number }; timeoutSec: number } {
  if (config.builder === "none") return { builder: new NoneBuilder(), budget: {}, timeoutSec: 60 };
  const c = config["coding-agent"] as CodingAgentConfig;
  const builder = new CodingAgentBuilder({
    settings: c.agent,
    repo: resolve(c.repo),
    ...(c.build !== undefined ? { build: c.build } : {}),
    certifierFor: (projectDir) => new LakeCertifier({ ...c.certifier, projectDir }),
  });
  return { builder, budget: c.budget ?? {}, timeoutSec: c.timeoutSec ?? 3600 };
}

export interface LibraryBuildIo {
  /** The config file. Default: config/library-builder.json. */
  config?: string | undefined;
  /** The journal directory of the build record. Default: runs/library-<build id>. */
  out?: string | undefined;
  /** Land the files of an accepted build in this checkout (default: not). */
  adoptInto?: string | undefined;
  approvedBy?: string | undefined;
  print: (line: string) => void;
  signal?: AbortSignal;
  /** Overrides, for the tests. */
  builder?: LibraryBuilder;
  budget?: { usd?: number; seconds?: number };
  timeoutSec?: number;
}

/**
 * `harness library build SPEC_FILE [--config FILE] [--out DIR] [--adopt DIR [--approve NAME]]`: builds one spec with the configured
 * builder, writes the build into a journal of its own (documentation/library-builder.md), and, with `--adopt`, lands the files of
 * an accepted build. Run it between runs: a build that lands changes the environment's hash, which a run keeps from its start to its
 * end. Returns the exit code: 0 accepted (or skipped by `none`), 1 rejected or failed.
 */
export async function libraryBuildCommand(specFile: string, io: LibraryBuildIo): Promise<number> {
  let spec: LibrarySpec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8")) as LibrarySpec;
  } catch (error) {
    throw new LibraryBuilderConfigError(`cannot read the spec ${specFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A spec file is a person's: the one who runs the command answers for its text. An author the file names is not believed.
  spec = { ...spec, author: "human:cli" };
  const problems = specProblems(spec);
  if (problems.length > 0) throw new LibraryBuilderConfigError(`the spec ${specFile} is not valid: ${problems.join("; ")}`);
  const made = io.builder !== undefined ? { builder: io.builder, budget: io.budget ?? {}, timeoutSec: io.timeoutSec ?? 60 } : makeLibraryBuilder(loadLibraryBuilderConfig(io.config ?? DEFAULT_LIBRARY_BUILDER_CONFIG));
  const result = await made.builder.build(spec, { budget: made.budget, timeoutSec: made.timeoutSec, ...(io.signal !== undefined ? { signal: io.signal } : {}), ...(io.approvedBy !== undefined ? { approvedBy: io.approvedBy } : {}) });
  const dir = resolve(io.out ?? join("runs", `library-${result.buildId}`));
  mkdirSync(dirname(dir), { recursive: true });
  const journal = Journal.open(dir, `library_${result.buildId}`);
  try {
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")), actor: "orchestrator" });
    recordBuild(memory, result);
    report(result, dir, io.print);
    if (io.adoptInto !== undefined && result.status === "accepted") {
      const written = adoptBuild(result, { root: resolve(io.adoptInto), runActive: () => false, ...(io.approvedBy !== undefined ? { approvedBy: io.approvedBy } : {}) });
      io.print(`adopted ${written.length} file(s) into ${resolve(io.adoptInto)}; run harness lean-env resolve for the environment that lists the library: its hash changes, and the next run is in it`);
    }
  } finally {
    journal.close();
  }
  return result.status === "accepted" || result.status === "skipped" ? 0 : 1;
}

function report(result: LibraryBuildResult, dir: string, print: (line: string) => void): void {
  print(`build ${result.buildId}: ${result.status}: ${result.reason}`);
  for (const c of result.gate) print(`  gate ${c.rule}: ${c.ok ? "ok" : "FAILED"}: ${c.detail}`);
  if (result.status === "accepted") {
    for (const d of result.definitions) print(`  definition ${d.name}: unreviewed (a claim statement may not use it until it is reviewed)`);
    if (result.needsApproval) print("  this port runs code while Lean elaborates: it is built and adopted only with --approve NAME");
  }
  print(`journaled in ${dir}`);
}

/** `harness library gaps RUN_DIR`: the gaps a run's memory holds that no accepted build closed. */
export function libraryGapsCommand(memory: MemoryStore, print: (line: string) => void): number {
  const gaps = openGaps(memory);
  if (gaps.length === 0) print("no open library gap");
  for (const { nodeId, gap } of gaps) print(`${nodeId}  ${gap.job}  ${gap.trigger}  ${gap.concept}  (seen ${gap.count})`);
  return 0;
}
