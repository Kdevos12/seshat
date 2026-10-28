import { relative } from "node:path";
import {
  buildEnvironment,
  type CommandRunner,
  DEFAULT_ENV_ROOT,
  EnvSpecError,
  envProjectDir,
  type Fetcher,
  githubFetcher,
  listEnvironments,
  loadEnvSpec,
  lookupEnvironment,
  readLock,
  resolveEnvironment,
  spawnRunner,
  writeEnvironment,
} from "@seshat/lean-env";

/** What `harness lean-env` needs from its surroundings; the tests give fakes. */
export interface LeanEnvIo {
  /** The directory with the environment files. Default: `lean/env/` of this repository. */
  root?: string;
  /** Reads the files of packages. Default: GitHub's raw files. */
  fetch?: Fetcher;
  /** Runs `lake`. Default: starts the program. */
  run?: CommandRunner;
  /** The `lake` program. Default: `LAKE`, then `lake`. */
  lake?: string;
  signal?: AbortSignal;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const LEAN_ENV_USAGE = `usage:
  harness lean-env resolve NAME [--find] [--env-dir DIR]
  harness lean-env build NAME [--env-dir DIR]
  harness lean-env show [NAME] [--env-dir DIR]

resolve: reads each package's lean-toolchain and lake-manifest.json at its rev, refuses the environment unless
every package agrees on the toolchain and on every shared dependency, and writes lakefile.toml, lean-toolchain
and the lock (with the environment hash) in DIR/NAME. --find tries the tag of the toolchain for a package that
has no rev. build: lake update, lake exe cache get, lake build per package, timed. show: where an environment
stands. DIR defaults to lean/env (documentation/lean-env.md). Exit codes: 0 done, 1 refused or failed, 2 a mistake in the command.`;

/** `harness lean-env ACTION [NAME]`; returns the exit code. */
export async function leanEnvCommand(action: string | undefined, name: string | undefined, options: { find?: boolean }, io: LeanEnvIo): Promise<number> {
  const root = io.root ?? DEFAULT_ENV_ROOT;
  try {
    switch (action) {
      case "resolve":
        return await resolveCommand(requireName(name, action), options.find === true, root, io);
      case "build":
        return await buildCommand(requireName(name, action), root, io);
      case "show":
        return showCommand(name, root, io);
      default:
        io.err(`${action === undefined ? "lean-env needs an action" : `unknown lean-env action ${JSON.stringify(action)}`}\n\n${LEAN_ENV_USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof EnvSpecError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

function requireName(name: string | undefined, action: string): string {
  if (name === undefined) throw new EnvSpecError(`lean-env ${action} needs the name of an environment (harness lean-env show lists them)`);
  return name;
}

async function resolveCommand(name: string, find: boolean, root: string, io: LeanEnvIo): Promise<number> {
  const spec = loadEnvSpec(name, root);
  io.out(`resolving ${name} (${spec.toolchain}): ${[spec.base, ...spec.packages].map((p) => `${p.name}@${p.rev ?? p.path ?? "?"}`).join(", ")}`);
  const resolution = await resolveEnvironment(spec, { fetch: io.fetch ?? githubFetcher(), find });
  for (const note of resolution.notes) io.out(`note: ${note}`);
  if (resolution.lock === undefined) {
    io.err(`refused: the environment ${name} is not consistent, and nothing was written:`);
    for (const problem of resolution.problems) io.err(`  ${problem}`);
    return 1;
  }
  const written = writeEnvironment(spec, resolution.lock, envProjectDir(root, name));
  const shared = resolution.lock.dependencies.filter((d) => d.usedBy.length >= 2).length;
  io.out(`ok: environment ${name}, hash ${resolution.lock.hash}`);
  io.out(`  ${resolution.lock.packages.length} package(s), ${resolution.lock.dependencies.length} dependencies (${shared} shared, pinned in the lakefile)`);
  io.out(`  wrote ${written.files.map((f) => relative(process.cwd(), f) || f).join(", ")}${written.changed ? "" : " (the same as before)"}`);
  io.out(`next: harness lean-env build ${name}`);
  return 0;
}

async function buildCommand(name: string, root: string, io: LeanEnvIo): Promise<number> {
  const report = await buildEnvironment(name, {
    root,
    run: io.run ?? spawnRunner,
    lake: io.lake ?? process.env.LAKE ?? "lake",
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    log: io.err,
  });
  for (const entry of report.perPackage) {
    io.out(`${(entry.ms / 1000).toFixed(1).padStart(8)} s  ${entry.package ?? "(update and cache)"}`);
  }
  if (!report.ok) {
    io.err(`build of ${name} failed: ${report.failure ?? ""}`);
    return 1;
  }
  io.out(`ok: environment ${name} built, hash ${report.hash}`);
  io.out(`  point the Lean server and the harness at ${envProjectDir(root, name)} (LEAN_SERVER_PROJECT_DIR; the harness finds it by itself)`);
  return 0;
}

function showCommand(name: string | undefined, root: string, io: LeanEnvIo): number {
  const names = name !== undefined ? [name] : listEnvironments(root);
  if (names.length === 0) io.out(`no environment files in ${root}`);
  for (const each of names) {
    const pin = lookupEnvironment(each, { root });
    io.out(`${each}: ${pin.status}${pin.status === "resolved" ? `, hash ${pin.hash}, ${pin.built === true ? "built" : "not built"}` : ""}`);
    if (name === undefined) continue;
    io.out(`  project ${pin.dir}`);
    if (pin.detail !== undefined) io.out(`  ${pin.detail}`);
    const lock = pin.status === "resolved" ? readLock(pin.dir as string) : undefined;
    for (const pkg of lock?.packages ?? []) io.out(`  ${pkg.role === "base" ? "base " : "extra"} ${pkg.name} ${pkg.rev ?? pkg.path ?? ""} [${pkg.leanLibs.join(", ")}]`);
    for (const dep of lock?.dependencies ?? []) io.out(`  dep   ${dep.name} ${dep.rev.slice(0, 10)} (${dep.usedBy.join(", ")})`);
  }
  return names.length === 1 && lookupEnvironment(names[0] as string, { root }).status === "unknown" ? 2 : 0;
}
