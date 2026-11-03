import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Json } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";
import type { LibraryBuildResult } from "./builder.ts";

/** The node kinds of the library builder. This package owns them and the shape of their `data`. */
export const BUILD_KIND = "library_build";
export const GAP_KIND = "library_gap";

const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * Writes a build into the journal (plan change LC4, gate rule 5): one `library_build` node with the agent, model, budget,
 * the prompt and the diff (as blobs, by hash), the commands, the agent's environment keys, every gate check and the
 * verdict, and, for an accepted build, one `lean_definition` node per new definition, `unreviewed` (LC5). Called by the
 * orchestrator's store, not by a line: `recordDefinition` refuses a view. A build never changes a claim's status.
 */
export function recordBuild(memory: MemoryStore, result: LibraryBuildResult, options: { envHash?: string | null } = {}): { node: MemoryNode; definitions: string[] } {
  const p = result.provenance;
  const prompt = p.prompt !== undefined ? memory.blobs.put(p.prompt) : undefined;
  const diff = result.diff !== "" ? memory.blobs.put(result.diff) : undefined;
  const data = {
    buildId: result.buildId,
    status: result.status,
    reason: result.reason,
    job: result.job,
    domain: result.domain,
    builder: p.builder,
    ...(p.agent !== undefined ? { agent: p.agent } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.command !== undefined ? { command: p.command } : {}),
    ...(p.envKeys !== undefined ? { envKeys: p.envKeys } : {}),
    budget: { ...p.budget },
    timeoutSec: p.timeoutSec,
    ...(p.baseCommit !== undefined ? { baseCommit: p.baseCommit } : {}),
    ...(prompt !== undefined ? { promptBlob: prompt, promptHash: p.promptHash ?? sha(p.prompt as string) } : {}),
    ...(diff !== undefined ? { diffBlob: diff } : {}),
    ...(p.agentOutput !== undefined ? { agentOutputTail: p.agentOutput.slice(-2000) } : {}),
    ...(p.agentMs !== undefined ? { agentMs: p.agentMs } : {}),
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
    spec: result.spec as unknown as Json,
    gate: result.gate.map((c) => ({ rule: c.rule, ok: c.ok, detail: c.detail })),
    files: result.files.map((f) => ({ path: f.path, hash: sha(f.content) })),
    theorems: result.theorems,
    definitions: result.definitions.map((d) => d.name),
    needsApproval: result.needsApproval,
    ...(options.envHash !== undefined ? { envHash: options.envHash } : {}),
  };
  const node = memory.recordNode({ kind: BUILD_KIND, data: data as unknown as Json });
  const definitions: string[] = [];
  if (result.status === "accepted") {
    for (const d of result.definitions) {
      memory.recordDefinition({ name: d.name, keyword: d.keyword, module: d.module, buildId: node.nodeId, testLemmas: d.testLemmas, ...(options.envHash !== undefined ? { envHash: options.envHash } : {}) });
      definitions.push(d.name);
    }
  }
  return { node, definitions };
}

/** The builds the memory holds, in the order they were recorded. */
export function builds(memory: MemoryStore): Array<{ nodeId: string; data: Record<string, Json> }> {
  return memory.nodes(BUILD_KIND).map((n) => ({ nodeId: n.nodeId, data: n.data as Record<string, Json> }));
}

export interface AdoptOptions {
  /** The directory the result's paths are relative to: the project's checkout. */
  root: string;
  /** Whether a run is going: the files change the environment's hash, which a run is pinned to from start to end, so nothing lands then. */
  runActive: () => boolean;
  /** A port with code that runs at elaboration lands only with this: the name of the person who approved it. */
  approvedBy?: string;
}

/**
 * Lands an accepted build's files in the checkout, between runs. The next `harness lean-env resolve` of an environment
 * that lists the library as a local package then gives another environment hash (the hash of a local package is the
 * hash of its files), and a run started afterwards runs in it; a run that is going keeps the one it started in. Files are only
 * added: one that exists is an error. Returns the paths written.
 */
export function adoptBuild(result: LibraryBuildResult, options: AdoptOptions): string[] {
  if (result.status !== "accepted") throw new Error(`adoptBuild: the build ${result.buildId} is ${result.status}, not accepted`);
  if (options.runActive()) throw new Error("adoptBuild: a run is going, and a run is pinned to one environment from start to end; adopt between runs");
  if (result.needsApproval && (options.approvedBy === undefined || options.approvedBy.trim() === "")) {
    throw new Error(`adoptBuild: ${result.buildId} is a port whose files run code while Lean elaborates; a person approves it (approvedBy)`);
  }
  const targets = result.files.map((f) => ({ f, target: join(options.root, f.path) }));
  for (const { f, target } of targets) {
    if (!target.startsWith(`${options.root}/`) || f.path.includes("..")) throw new Error(`adoptBuild: ${f.path} leaves ${options.root}`);
    if (existsSync(target) && readFileSync(target, "utf8") !== f.content) throw new Error(`adoptBuild: ${target} exists with other content; a file is never edited in place`);
  }
  const written: string[] = [];
  for (const { f, target } of targets) {
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    written.push(target);
  }
  return written;
}
