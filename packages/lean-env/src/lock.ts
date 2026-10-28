import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, type Json } from "@seshat/core";
import { DEFAULT_ENV_ROOT, EnvSpecError, envProjectDir, loadEnvSpec, specHash } from "./spec.ts";

/** The lock `resolve` writes in the environment's project directory. */
export const LOCK_FILE = "lean-env.lock.json";
/** What `build` writes there when it succeeds. */
export const BUILD_FILE = "lean-env.build.json";

export const LOCK_FORMAT = 1;

/** A package of a resolved environment. */
export interface LockPackage {
  name: string;
  role: "base" | "extra";
  git?: string;
  /** The tag or commit the manifests were read at. */
  rev?: string;
  /** A local package, as the environment file wrote it, and the hash of its files. */
  path?: string;
  contentHash?: string;
  leanLibs: string[];
  /** Its `lean-toolchain`. */
  toolchain: string;
  /** The hash of the `lake-manifest.json` that was read, or null when a local package has none. */
  manifestHash: string | null;
}

/** A package that the packages depend on, as their manifests agree on it. */
export interface LockDependency {
  name: string;
  url: string;
  rev: string;
  /** The packages whose manifests list it. */
  usedBy: string[];
}

/** A resolved environment: the packages, what they depend on, and the hash that names all of it. */
export interface EnvLock {
  format: number;
  name: string;
  /** The environment hash (`environmentHash`). */
  hash: string;
  /** The hash of the environment file it was resolved from: a lock is stale when the file changes. */
  specHash: string;
  toolchain: string;
  packages: LockPackage[];
  dependencies: LockDependency[];
}

/** `https://github.com/x/y.git/` and `https://GitHub.com/x/y` name the same repository. */
export function normalizeGitUrl(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^(https:\/\/)([^/]+)/i, (_m, scheme: string, host: string) => `${scheme}${host.toLowerCase()}`);
}

/**
 * The environment hash: a hash of the toolchain, of each package (its name, repository, rev and
 * libraries, or the hash of a local package's files) and of every dependency the manifests agree on
 * (name, repository, commit). Two environments with the same hash have the same Lean, the same
 * packages and the same Mathlib, whatever their names are, where they were resolved and when. It
 * does not contain the environment's description, nor what was read from the network beyond this.
 */
export function environmentHash(parts: { toolchain: string; packages: readonly LockPackage[]; dependencies: readonly LockDependency[] }): string {
  const base = parts.packages.find((p) => p.role === "base")?.name ?? null;
  const packages: Json[] = parts.packages
    .map((p): Json => ({
      name: p.name,
      git: p.git !== undefined ? normalizeGitUrl(p.git) : null,
      rev: p.rev ?? null,
      content: p.contentHash ?? null,
      leanLibs: [...p.leanLibs].sort(),
    }))
    .sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));
  const dependencies: Json[] = parts.dependencies
    .map((d): Json => ({ name: d.name, url: normalizeGitUrl(d.url), rev: d.rev }))
    .sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));
  return hashJson({ format: LOCK_FORMAT, toolchain: parts.toolchain, base, packages, dependencies });
}

/** The lock of an environment's project directory; undefined when there is none, an error when it is damaged. */
export function readLock(dir: string): EnvLock | undefined {
  const file = join(dir, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EnvSpecError(`${file} is not JSON (${(error as Error).message}): resolve the environment again`);
  }
  const lock = value as Partial<EnvLock> | null;
  if (
    lock === null || typeof lock !== "object" || lock.format !== LOCK_FORMAT || typeof lock.name !== "string" || typeof lock.hash !== "string" ||
    typeof lock.specHash !== "string" || typeof lock.toolchain !== "string" || !Array.isArray(lock.packages) || !Array.isArray(lock.dependencies)
  ) {
    throw new EnvSpecError(`${file} is not an environment lock of format ${LOCK_FORMAT}: resolve the environment again`);
  }
  const complete = lock as EnvLock;
  if (environmentHash(complete) !== complete.hash) {
    throw new EnvSpecError(`${file}: its hash is not the hash of its contents (it was edited): resolve the environment again`);
  }
  return complete;
}

/** What `build` recorded for a project directory. */
export interface BuildStamp {
  hash: string;
  finishedAt: string;
  steps: Array<{ name: string; ms: number }>;
}

export function readBuildStamp(dir: string): BuildStamp | undefined {
  const file = join(dir, BUILD_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const stamp = JSON.parse(readFileSync(file, "utf8")) as BuildStamp;
    return typeof stamp.hash === "string" ? stamp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where an environment stands on this machine, as a registry pins a run to it. The registry has the
 * same shape (`LeanEnvPin` of `@seshat/registry`), so that it does not depend on this package.
 */
export interface LeanEnvPin {
  name: string;
  /** The environment hash; null unless `status` is `resolved`. */
  hash: string | null;
  /** The environment's project directory. */
  dir?: string;
  status?: "resolved" | "unresolved" | "stale" | "unknown";
  /** Why the environment is not resolved, and what to do. */
  detail?: string;
  /** Whether `harness lean-env build` finished for this hash. */
  built?: boolean;
}

export interface LookupOptions {
  /** The directory with `<name>.toml`. Default: `lean/env/` of this repository. */
  root?: string;
  /** The project directory to read the lock from. Default: `<root>/<name>/`. */
  projectDir?: string;
}

/**
 * Where an environment stands on this machine, for a registry to pin a run to. It never throws:
 *
 * - `resolved`: the project directory holds a lock of this environment, and the environment file is
 *   the one the lock was made from. The pin has the hash.
 * - `unresolved`: there is no lock (`harness lean-env resolve NAME` writes it). No hash.
 * - `stale`: there is a lock, and it is not this environment's, was edited, or the environment file
 *   changed since. No hash, and `detail` says what to do.
 * - `unknown`: there is no environment file of that name, or it is wrong.
 */
export function lookupEnvironment(name: string, options: LookupOptions = {}): LeanEnvPin {
  const root = options.root ?? DEFAULT_ENV_ROOT;
  const dir = options.projectDir ?? envProjectDir(root, name);
  let spec;
  try {
    spec = loadEnvSpec(name, root);
  } catch (error) {
    if (error instanceof EnvSpecError) return { name, hash: null, dir, status: "unknown", detail: error.message, built: false };
    throw error;
  }
  let lock: EnvLock | undefined;
  try {
    lock = readLock(dir);
  } catch (error) {
    if (error instanceof EnvSpecError) return { name, hash: null, dir, status: "stale", detail: error.message, built: false };
    throw error;
  }
  if (lock === undefined) {
    return { name, hash: null, dir, status: "unresolved", detail: `${join(dir, LOCK_FILE)} does not exist: run harness lean-env resolve ${name}`, built: false };
  }
  if (lock.name !== name) {
    return { name, hash: null, dir, status: "stale", detail: `${dir} holds the environment ${lock.name}, not ${name}`, built: false };
  }
  if (lock.specHash !== specHash(spec)) {
    return { name, hash: null, dir, status: "stale", detail: `${spec.file} changed since it was resolved: run harness lean-env resolve ${name}`, built: false };
  }
  return { name, hash: lock.hash, dir, status: "resolved", built: readBuildStamp(dir)?.hash === lock.hash };
}

/**
 * The environment hash of an environment on this machine, for anything that needs "the same Lean
 * environment" (the memory that outlives a run, a stored proof's replay): undefined when the
 * environment is not resolved, never a guess from the file alone. Two undefined are not the same
 * environment (`sameLeanEnvironment`).
 */
export function leanEnvironmentHash(name: string, options: LookupOptions = {}): string | undefined {
  return lookupEnvironment(name, options).hash ?? undefined;
}

/** What a run records of its environment, in `run.started`'s config. */
export type LeanEnvRecord = {
  name: string;
  /** Null when the environment was not resolved. */
  hash: string | null;
};

/** The record of a pin. */
export function leanEnvRecord(pin: Pick<LeanEnvPin, "name" | "hash">): LeanEnvRecord {
  return { name: pin.name, hash: pin.hash };
}

/**
 * Whether two records name the same Lean environment: both have a hash and it is the same. An
 * environment whose hash is unknown is not the same as any other, itself included.
 */
export function sameLeanEnvironment(a: Partial<LeanEnvRecord> | undefined | null, b: Partial<LeanEnvRecord> | undefined | null): boolean {
  return typeof a?.hash === "string" && typeof b?.hash === "string" && a.hash === b.hash;
}

/** The environment a run recorded in the config of its `run.started`; undefined for a run that recorded none. */
export function leanEnvOfConfig(config: unknown): LeanEnvRecord | undefined {
  const value = (config as { leanEnv?: unknown } | null | undefined)?.leanEnv;
  if (value === null || typeof value !== "object") return undefined;
  const { name, hash } = value as { name?: unknown; hash?: unknown };
  return typeof name === "string" ? { name, hash: typeof hash === "string" ? hash : null } : undefined;
}
