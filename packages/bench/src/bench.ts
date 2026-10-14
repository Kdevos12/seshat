import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, hashJson, sha256Hex } from "@seshat/core";
import { type ProblemEntry, scanCheckout } from "./formal-conjectures.ts";

export interface BenchFilter {
  categories: string[];
  /** A problem qualifies when every one of its AMS codes is in this list. */
  ams: number[];
  /** Problems whose file already holds a proof (and maybe lemmas made for it). Default: left out. */
  includeProofInFile: boolean;
  /** Leave out problems below a sorried definition or an axiom of their file. */
  excludeUnprovedBefore: boolean;
}

/**
 * The first bench (choice of 13 October): combinatorics (05), number theory (11), order and lattices
 * (06), general algebraic systems (08) and group theory (20), solved research problems only.
 */
export const DISCRETE: BenchFilter = {
  categories: ["research solved"],
  ams: [5, 6, 8, 11, 20],
  includeProofInFile: false,
  excludeUnprovedBefore: true,
};

export function select(problems: readonly ProblemEntry[], filter: BenchFilter): ProblemEntry[] {
  return problems.filter(
    (p) =>
      filter.categories.includes(p.category) &&
      p.ams.length > 0 &&
      p.ams.every((code) => filter.ams.includes(code)) &&
      !p.sorryInStatement &&
      (filter.includeProofInFile || !p.proofInFile) &&
      (!filter.excludeUnprovedBefore || p.unprovedBefore.length === 0),
  );
}

/** A deterministic sample: the `n` problems whose hash with `seed` is smallest. */
export function sample(problems: readonly ProblemEntry[], n: number, seed: string): ProblemEntry[] {
  return [...problems]
    .map((p) => ({ p, key: sha256Hex(`${seed}\n${p.id}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, n)
    .map(({ p }) => p)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface BenchSource {
  repo: string;
  rev: string;
  tag?: string;
  /** Content of `lean-toolchain`, e.g. `leanprover/lean4:v4.27.0`. */
  lean: string;
}

export interface BenchIndex {
  v: 1;
  benchId: string;
  source: BenchSource;
  filter: BenchFilter;
  counts: { theorems: number; selected: number; unreadable: number };
  problems: ProblemEntry[];
  /** sha256 of the canonical JSON of the index without `hash`. */
  hash: string;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** Where a checkout comes from: remote, commit, tag pointing at it, and Lean version. */
export function describeCheckout(root: string): BenchSource {
  const remote = git(root, ["remote", "get-url", "origin"]) ?? "unknown";
  const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote)?.[1] ?? remote;
  const rev = git(root, ["rev-parse", "HEAD"]) ?? "unknown";
  const tag = git(root, ["describe", "--tags", "--exact-match", "HEAD"]);
  const toolchain = join(root, "lean-toolchain");
  const lean = existsSync(toolchain) ? readFileSync(toolchain, "utf8").trim() : "unknown";
  return { repo, rev, ...(tag ? { tag } : {}), lean };
}

export function buildIndex(root: string, benchId: string, filter: BenchFilter = DISCRETE): BenchIndex & { errors: string[] } {
  const { problems, errors } = scanCheckout(root);
  const selected = select(problems, filter);
  const body = {
    v: 1 as const,
    benchId,
    source: describeCheckout(root),
    filter,
    counts: { theorems: problems.length, selected: selected.length, unreadable: errors.length },
    problems: selected,
  };
  return { ...body, hash: hashJson(body), errors };
}

export function writeIndex(path: string, index: BenchIndex): void {
  const { v, benchId, source, filter, counts, problems, hash } = index;
  writeFileSync(path, `${JSON.stringify(JSON.parse(canonicalJson({ v, benchId, source, filter, counts, problems, hash })), null, 1)}\n`);
}

/** Reads an index and checks its hash, so that a bench cannot change without its id saying so. */
export function readIndex(path: string): BenchIndex {
  const index = JSON.parse(readFileSync(path, "utf8")) as BenchIndex;
  const { hash, ...body } = index;
  if (index.v !== 1) throw new Error(`${path}: unsupported bench index version ${String(index.v)}`);
  if (hashJson(body) !== hash) throw new Error(`${path}: hash does not match the content`);
  return index;
}

/** Checks that a checkout still has the file a problem was indexed from, unchanged. */
export function verifyProblemFile(root: string, problem: ProblemEntry, plainSource: string): void {
  if (sha256Hex(plainSource) !== problem.fileHash) {
    throw new Error(`${problem.path} differs from the indexed file (checkout at another revision?) in ${root}`);
  }
}
