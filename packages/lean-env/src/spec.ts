import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashJson, type Json } from "@seshat/core";
import { parseToml, TomlError } from "./toml.ts";

/** `lean/env/` of this repository: `<name>.toml` is an environment, `<name>/` its project. */
export const DEFAULT_ENV_ROOT = fileURLToPath(new URL("../../../lean/env", import.meta.url));

/** A problem with an environment file, or an environment that is not there: the message is for the person who writes it. */
export class EnvSpecError extends Error {}

/** One package of an environment: a git repository at a tag or commit, or a local directory. */
export interface EnvPackage {
  /** The package's name in Lake (`require <name>`), also its name in the manifests that list it. */
  name: string;
  git?: string;
  /** A tag or a commit. A package without one is resolved only with `--find`. */
  rev?: string;
  /** A local package, relative to the directory of the environment file: the harness's own Lean libraries. */
  path?: string;
  /** The `lean_lib`s to build and import. */
  leanLibs: string[];
}

/** An environment, as `lean/env/<name>.toml` states it (documentation/lean-env.md). */
export interface EnvSpec {
  name: string;
  description?: string;
  /** As `lean-toolchain` writes it: `leanprover/lean4:v4.27.0`. */
  toolchain: string;
  /** The project the bench is: the first package, whose tag the bench is pinned to. */
  base: EnvPackage;
  /** The extra packages, in the order the file lists them. */
  packages: EnvPackage[];
  /** Where the file is, and the directory it is in: local packages are relative to it. */
  file: string;
  dir: string;
}

const NAME = /^[a-z][a-z0-9_-]*$/;
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const REV = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;
const LIB = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** `4.27.0`, `v4.27.0` and `leanprover/lean4:v4.27.0` are the same toolchain: the last form. */
export function normalizeToolchain(text: string): string {
  const trimmed = text.trim();
  const bare = /^v?(\d+\.\d+\.\d+(?:-rc\d+)?)$/.exec(trimmed);
  return bare !== null ? `leanprover/lean4:v${bare[1]}` : trimmed;
}

/** The tag `--find` tries for a package without a rev: `v4.27.0` for `leanprover/lean4:v4.27.0`. */
export function toolchainTag(toolchain: string): string | undefined {
  return /:(v\d+\.\d+\.\d+(?:-rc\d+)?)$/.exec(normalizeToolchain(toolchain))?.[1];
}

/** The path of the file of an environment. */
export function envFile(root: string, name: string): string {
  return join(root, `${name}.toml`);
}

/** The directory of an environment's project: what `resolve` writes and `build` builds. */
export function envProjectDir(root: string, name: string): string {
  return join(root, name);
}

/** The environments that have a file in `root`, by name. */
export function listEnvironments(root: string = DEFAULT_ENV_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".toml") && NAME.test(entry.slice(0, -5)))
    .map((entry) => entry.slice(0, -5))
    .sort();
}

/** Reads and checks `<root>/<name>.toml`. */
export function loadEnvSpec(name: string, root: string = DEFAULT_ENV_ROOT): EnvSpec {
  if (!NAME.test(name)) throw new EnvSpecError(`${JSON.stringify(name)} is not an environment name (lowercase letters, digits, - and _)`);
  const file = envFile(root, name);
  if (!existsSync(file)) {
    const known = listEnvironments(root);
    throw new EnvSpecError(`no environment ${name}: ${file} does not exist${known.length > 0 ? ` (the environments are ${known.join(", ")})` : ""}`);
  }
  let table: { [key: string]: Json };
  try {
    table = parseToml(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof TomlError) throw new EnvSpecError(`${file}: ${error.message}`);
    throw error;
  }
  return parseEnvSpec(table, { name, file });
}

const TOP_KEYS = new Set(["name", "description", "toolchain", "base", "package"]);
const PACKAGE_KEYS = new Set(["name", "git", "rev", "path", "lean_libs"]);

/** Checks a parsed environment file; every problem is reported together. */
export function parseEnvSpec(table: { [key: string]: Json }, origin: { name: string; file: string }): EnvSpec {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  for (const key of Object.keys(table)) if (!TOP_KEYS.has(key)) fail(`unknown key ${key}`);
  if (table.name !== undefined && table.name !== origin.name) fail(`name is ${JSON.stringify(table.name)} but the file is ${origin.name}.toml`);
  if (table.description !== undefined && typeof table.description !== "string") fail("description must be a string");
  const toolchain = typeof table.toolchain === "string" ? normalizeToolchain(table.toolchain) : undefined;
  if (toolchain === undefined || !/^[\w./-]+:[\w.-]+$/.test(toolchain)) fail('toolchain must be a string such as "leanprover/lean4:v4.27.0"');

  const readPackage = (value: Json | undefined, where: string, isBase: boolean): EnvPackage | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${where} must be a table`);
      return undefined;
    }
    const before = problems.length;
    for (const key of Object.keys(value)) if (!PACKAGE_KEYS.has(key)) fail(`${where}: unknown key ${key}`);
    const { name, git, rev, path, lean_libs: libs } = value as { [key: string]: Json };
    if (typeof name !== "string" || !PACKAGE_NAME.test(name)) fail(`${where}: name must be the package's name in Lake, such as "Duper"`);
    if ((git === undefined) === (path === undefined)) fail(`${where}: give git (with rev) or path, one of them`);
    if (git !== undefined && (typeof git !== "string" || !/^https:\/\/\S+$/.test(git))) fail(`${where}: git must be an https URL`);
    if (rev !== undefined && (typeof rev !== "string" || !REV.test(rev))) fail(`${where}: rev must be a tag or a commit`);
    if (path !== undefined && (typeof path !== "string" || path === "")) fail(`${where}: path must be a directory, relative to the file`);
    if (path !== undefined && rev !== undefined) fail(`${where}: a local package has no rev`);
    if (isBase && path !== undefined) fail(`${where}: the base project is a git repository, at the bench's tag`);
    if (isBase && git !== undefined && rev === undefined) fail(`${where}: the base project's rev is the bench's tag, and is required`);
    if (!Array.isArray(libs) || libs.length === 0 || libs.some((l) => typeof l !== "string" || !LIB.test(l))) {
      fail(`${where}: lean_libs must be a list of the lean_lib names to build and import`);
    }
    if (problems.length > before) return undefined;
    return {
      name: name as string,
      ...(git !== undefined ? { git: (git as string).replace(/\/+$/, "") } : {}),
      ...(rev !== undefined ? { rev: rev as string } : {}),
      ...(path !== undefined ? { path: path as string } : {}),
      leanLibs: libs as string[],
    };
  };

  const base = readPackage(table.base, "[base]", true);
  const extras: EnvPackage[] = [];
  if (table.package !== undefined) {
    if (!Array.isArray(table.package)) fail("[[package]] must be an array of tables");
    else {
      table.package.forEach((entry, i) => {
        const found = readPackage(entry, `[[package]] #${i + 1}`, false);
        if (found !== undefined) extras.push(found);
      });
    }
  }
  const names = [base, ...extras].flatMap((p) => (p === undefined ? [] : [p.name]));
  for (const name of new Set(names)) {
    if (names.filter((n) => n.toLowerCase() === name.toLowerCase()).length > 1) fail(`the package ${name} is listed twice`);
  }
  if (problems.length > 0 || base === undefined || toolchain === undefined) {
    throw new EnvSpecError(`${origin.file}: ${[...new Set(problems)].join("; ")}`);
  }
  return {
    name: origin.name,
    ...(typeof table.description === "string" ? { description: table.description } : {}),
    toolchain,
    base,
    packages: extras,
    file: origin.file,
    dir: dirname(resolve(origin.file)),
  };
}

/** Every package of the environment, the base project first. */
export function allPackages(spec: EnvSpec): EnvPackage[] {
  return [spec.base, ...spec.packages];
}

/**
 * Hashes what the file says (not its description or where it is), so that a lock tells whether the
 * file changed after it was resolved.
 */
export function specHash(spec: EnvSpec): string {
  const pack = (p: EnvPackage): Json => ({
    name: p.name,
    git: p.git ?? null,
    rev: p.rev ?? null,
    path: p.path ?? null,
    leanLibs: p.leanLibs,
  });
  return hashJson({ toolchain: spec.toolchain, base: pack(spec.base), packages: spec.packages.map(pack) });
}
