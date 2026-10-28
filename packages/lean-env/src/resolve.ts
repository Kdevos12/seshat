import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { sha256Hex } from "@seshat/core";
import { renderLakefile } from "./lakefile.ts";
import {
  BUILD_FILE,
  type EnvLock,
  environmentHash,
  LOCK_FILE,
  LOCK_FORMAT,
  type LockDependency,
  type LockPackage,
  normalizeGitUrl,
  readLock,
} from "./lock.ts";
import { allPackages, type EnvPackage, type EnvSpec, normalizeToolchain, specHash, toolchainTag } from "./spec.ts";

/** The two files of a package that the resolver reads. */
export type PackageFile = "lean-toolchain" | "lake-manifest.json";

/**
 * Reads one file of a package at a rev. Resolves to undefined when the file (or the rev) does not
 * exist, and throws when it could not be asked (the network). The resolver reads nothing else of a
 * package: this is the only thing it asks of the network.
 */
export type Fetcher = (source: { name: string; git: string; rev: string }, file: PackageFile) => Promise<string | undefined>;

/** The files of GitHub repositories, from raw.githubusercontent.com. */
export function githubFetcher(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Fetcher {
  const get = options.fetch ?? fetch;
  return async ({ git, rev }, file) => {
    const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(git);
    if (match === null) throw new Error(`${git} is not a GitHub repository: only those can be read (give the resolver another fetcher for other hosts)`);
    const url = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${rev}/${file}`;
    const response = await get(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return await response.text();
  };
}

export interface ResolveOptions {
  fetch: Fetcher;
  /** A package without a rev is tried at the tag `v<toolchain>`. */
  find?: boolean;
}

export interface Resolution {
  /** Set when every package agrees: the lock to write. */
  lock?: EnvLock;
  /** Why the environment is refused, one line each. Empty when `lock` is set. */
  problems: string[];
  /** What was done that the person may want to know: a rev found, a missing manifest. */
  notes: string[];
}

interface Read {
  pkg: EnvPackage;
  role: "base" | "extra";
  /** The rev the files were read at. */
  rev: string | undefined;
  toolchain: string;
  manifest: { name: string | undefined; packages: ManifestEntry[] } | undefined;
  manifestHash: string | null;
  contentHash?: string;
}

interface ManifestEntry {
  name: string;
  type: string;
  url: string | undefined;
  rev: string | undefined;
  inputRev: string | undefined;
}

/**
 * Resolves an environment: reads each package's `lean-toolchain` and `lake-manifest.json` at its
 * rev, and refuses the environment unless
 *
 * 1. every package uses the toolchain the environment declares,
 * 2. every dependency that two or more manifests list is the same repository at the same commit, and
 * 3. a package of the environment that another one also depends on is at the revision the other
 *    wants (a tag can be compared with a commit only through the other manifest's `inputRev`; a
 *    package that cannot be compared must be given by commit).
 *
 * A local package (`path`) is the harness's own Lean library: only its toolchain is checked, and
 * what it requires follows the environment's pins (Lake keeps the root's).
 * Every problem is reported, not only the first. Nothing is written (`writeEnvironment`).
 */
export async function resolveEnvironment(spec: EnvSpec, options: ResolveOptions): Promise<Resolution> {
  const problems: string[] = [];
  const notes: string[] = [];
  const reads: Read[] = [];
  const tag = toolchainTag(spec.toolchain);

  for (const [index, pkg] of allPackages(spec).entries()) {
    const role = index === 0 ? "base" : "extra";
    const read = pkg.path !== undefined ? readLocal(spec, pkg, role, problems, notes) : await readRemote(pkg, role, tag, options, problems, notes);
    if (read !== undefined) reads.push(read);
  }

  // 1. The toolchain.
  const declared = normalizeToolchain(spec.toolchain);
  const used = [...new Set(reads.map((r) => r.toolchain))];
  if (used.length > 1) {
    problems.push(`the packages disagree on the toolchain: ${reads.map((r) => `${r.pkg.name} uses ${r.toolchain}`).join(", ")}`);
  } else {
    for (const r of reads) {
      if (r.toolchain !== declared) problems.push(`${r.pkg.name} uses the toolchain ${r.toolchain}, the environment declares ${declared}`);
    }
  }

  // The package's own name, when its manifest says it.
  for (const r of reads) {
    if (r.manifest?.name !== undefined && r.pkg.path === undefined && r.manifest.name !== r.pkg.name) {
      problems.push(`${r.pkg.name}: its lake-manifest.json names the package ${r.manifest.name}; use that name in the environment file`);
    }
  }

  // 2. The dependencies the manifests list.
  const ownNames = new Set(reads.map((r) => r.pkg.name));
  const found = new Map<string, Array<{ from: string; entry: ManifestEntry }>>();
  for (const r of reads) {
    for (const entry of r.manifest?.packages ?? []) {
      if (entry.type !== "git") {
        problems.push(`${r.pkg.name}'s manifest lists ${entry.name} as a ${entry.type} dependency, which cannot be reproduced from a manifest`);
        continue;
      }
      const list = found.get(entry.name) ?? [];
      list.push({ from: r.pkg.name, entry });
      found.set(entry.name, list);
    }
  }
  const dependencies: LockDependency[] = [];
  for (const [name, list] of [...found].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ownNames.has(name)) {
      checkOwnPackage(reads.find((r) => r.pkg.name === name) as Read, list, problems);
      continue;
    }
    const first = list[0] as { from: string; entry: ManifestEntry };
    const urls = new Set(list.map((l) => normalizeGitUrl(l.entry.url ?? "")));
    const revs = new Set(list.map((l) => l.entry.rev));
    if (urls.size > 1 || revs.size > 1) {
      const wants = list.map((l) => `${l.from} wants ${shortRev(l.entry.rev)}${urls.size > 1 ? ` of ${l.entry.url}` : ""}`).join(", ");
      problems.push(`the shared dependency ${name} is not the same everywhere: ${wants}`);
      continue;
    }
    if (first.entry.url === undefined || first.entry.rev === undefined) {
      problems.push(`${first.from}'s manifest lists ${name} without a url or a rev`);
      continue;
    }
    dependencies.push({ name, url: first.entry.url, rev: first.entry.rev, usedBy: list.map((l) => l.from).sort() });
  }

  if (problems.length > 0) return { problems, notes };

  const packages: LockPackage[] = reads.map((r) => ({
    name: r.pkg.name,
    role: r.role,
    ...(r.pkg.git !== undefined ? { git: r.pkg.git } : {}),
    ...(r.rev !== undefined ? { rev: r.rev } : {}),
    ...(r.pkg.path !== undefined ? { path: r.pkg.path } : {}),
    ...(r.contentHash !== undefined ? { contentHash: r.contentHash } : {}),
    leanLibs: r.pkg.leanLibs,
    toolchain: r.toolchain,
    manifestHash: r.manifestHash,
  }));
  const lock: EnvLock = {
    format: LOCK_FORMAT,
    name: spec.name,
    hash: environmentHash({ toolchain: declared, packages, dependencies }),
    specHash: specHash(spec),
    toolchain: declared,
    packages,
    dependencies,
  };
  return { lock, problems, notes };
}

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

function shortRev(rev: string | undefined): string {
  return rev === undefined ? "no rev" : FULL_COMMIT.test(rev) ? rev.slice(0, 10) : rev;
}

/** A package of the environment that another package's manifest also lists must be at the revision it wants. */
function checkOwnPackage(owner: Read, wanted: Array<{ from: string; entry: ManifestEntry }>, problems: string[]): void {
  for (const { from, entry } of wanted) {
    if (from === owner.pkg.name) continue;
    const mine = owner.rev;
    if (entry.url !== undefined && owner.pkg.git !== undefined && normalizeGitUrl(entry.url) !== normalizeGitUrl(owner.pkg.git)) {
      problems.push(`${from} depends on ${owner.pkg.name} from ${entry.url}, the environment takes it from ${owner.pkg.git}`);
      continue;
    }
    if (mine === undefined) continue;
    const wants = `${shortRev(entry.rev)}${entry.inputRev !== undefined ? ` (${entry.inputRev})` : ""}`;
    const full = FULL_COMMIT.test(mine);
    if (mine === entry.rev || mine === entry.inputRev || (full && entry.rev?.startsWith(mine.toLowerCase()) === true)) continue;
    if (full) {
      problems.push(`${from} wants ${owner.pkg.name} at ${wants}, the environment has ${shortRev(mine)}`);
    } else {
      problems.push(
        `${from} wants ${owner.pkg.name} at ${wants} and the environment has ${mine}, a tag: ` +
          `they cannot be compared without a network call, so give ${owner.pkg.name} by commit in the environment file`,
      );
    }
  }
}

async function readRemote(
  pkg: EnvPackage,
  role: "base" | "extra",
  tag: string | undefined,
  options: ResolveOptions,
  problems: string[],
  notes: string[],
): Promise<Read | undefined> {
  const git = pkg.git as string;
  let rev = pkg.rev;
  if (rev === undefined) {
    if (options.find !== true || tag === undefined) {
      problems.push(`${pkg.name} has no rev: give one in the environment file, or use --find to try the tag ${tag ?? "of the toolchain"}`);
      return undefined;
    }
    rev = tag;
    notes.push(`${pkg.name}: no rev in the file, tried the tag ${tag}; put rev = "${tag}" in the file to keep it`);
  }
  const source = { name: pkg.name, git, rev };
  let toolchain: string | undefined;
  let manifestText: string | undefined;
  try {
    toolchain = await options.fetch(source, "lean-toolchain");
    manifestText = await options.fetch(source, "lake-manifest.json");
  } catch (error) {
    problems.push(`${pkg.name}: could not read ${git} at ${rev}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (toolchain === undefined) {
    problems.push(`${pkg.name}: ${git} has no lean-toolchain at ${rev}${pkg.rev === undefined ? "" : " (does the rev exist?)"}`);
    return undefined;
  }
  if (manifestText === undefined) {
    problems.push(`${pkg.name}: ${git} has no lake-manifest.json at ${rev}, so its dependencies cannot be compared with the others'`);
    return undefined;
  }
  const manifest = parseManifest(manifestText, `${pkg.name}'s lake-manifest.json`, problems);
  if (manifest === undefined) return undefined;
  return { pkg, role, rev, toolchain: normalizeToolchain(toolchain), manifest, manifestHash: sha256Hex(manifestText) };
}

function readLocal(spec: EnvSpec, pkg: EnvPackage, role: "base" | "extra", problems: string[], notes: string[]): Read | undefined {
  const dir = resolve(spec.dir, pkg.path as string);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    problems.push(`${pkg.name}: the local package ${dir} does not exist`);
    return undefined;
  }
  const toolchainFile = join(dir, "lean-toolchain");
  if (!existsSync(toolchainFile)) {
    problems.push(`${pkg.name}: ${dir} has no lean-toolchain`);
    return undefined;
  }
  const manifestFile = join(dir, "lake-manifest.json");
  let manifest: Read["manifest"];
  let manifestHash: string | null = null;
  if (existsSync(manifestFile)) {
    const text = readFileSync(manifestFile, "utf8");
    manifest = parseManifest(text, `${pkg.name}'s lake-manifest.json`, problems);
    if (manifest === undefined) return undefined;
    manifestHash = sha256Hex(text);
    // A local package follows the environment's pins: its own dependencies are not compared.
    manifest = undefined;
  } else {
    notes.push(`${pkg.name}: a local package without a lake-manifest.json; what it requires follows the environment's pins`);
  }
  return {
    pkg,
    role,
    rev: undefined,
    toolchain: normalizeToolchain(readFileSync(toolchainFile, "utf8")),
    manifest,
    manifestHash,
    contentHash: hashDirectory(dir),
  };
}

function parseManifest(text: string, origin: string, problems: string[]): Read["manifest"] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    problems.push(`${origin} is not JSON: ${(error as Error).message}`);
    return undefined;
  }
  const manifest = value as { name?: unknown; packages?: unknown } | null;
  if (manifest === null || typeof manifest !== "object" || !Array.isArray(manifest.packages)) {
    problems.push(`${origin} has no list of packages`);
    return undefined;
  }
  const packages: ManifestEntry[] = [];
  for (const raw of manifest.packages as Array<Record<string, unknown>>) {
    if (typeof raw?.name !== "string") {
      problems.push(`${origin} lists a package without a name`);
      return undefined;
    }
    packages.push({
      name: raw.name,
      type: typeof raw.type === "string" ? raw.type : "git",
      url: typeof raw.url === "string" ? raw.url : undefined,
      rev: typeof raw.rev === "string" ? raw.rev : undefined,
      inputRev: typeof raw.inputRev === "string" ? raw.inputRev : undefined,
    });
  }
  return { name: typeof manifest.name === "string" ? manifest.name : undefined, packages };
}

const SKIPPED = new Set([".lake", ".git", "node_modules", "build"]);

/** A hash of the files of a local package (not its build): their paths and contents. */
export function hashDirectory(dir: string): string {
  const entries: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (SKIPPED.has(name)) continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== "lake-manifest.json") entries.push(`${relative(dir, path).split("\\").join("/")}\0${sha256Hex(readFileSync(path, "utf8"))}`);
    }
  };
  walk(dir);
  return sha256Hex(entries.join("\n"));
}

/**
 * Writes the project of a resolved environment into `dir`: `lakefile.toml`, `lean-toolchain` and the
 * lock. A lock with another hash than the one before it removes what the old one built or resolved
 * (`lake-manifest.json` and the build stamp), so that Lake resolves again.
 */
export function writeEnvironment(spec: EnvSpec, lock: EnvLock, dir: string): { dir: string; files: string[]; changed: boolean } {
  mkdirSync(dir, { recursive: true });
  let before: string | undefined;
  try {
    before = readLock(dir)?.hash;
  } catch {
    before = undefined;
  }
  const changed = before !== lock.hash;
  const files: Array<[string, string]> = [
    ["lakefile.toml", renderLakefile(spec, lock, dir)],
    ["lean-toolchain", `${lock.toolchain}\n`],
    [LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`],
  ];
  for (const [name, text] of files) {
    const target = join(dir, name);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, target);
  }
  if (changed) {
    for (const stale of ["lake-manifest.json", BUILD_FILE]) rmSync(join(dir, stale), { force: true });
  }
  return { dir, files: files.map(([name]) => join(dir, name)), changed };
}
