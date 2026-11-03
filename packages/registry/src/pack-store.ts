import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Journal, readEvents, verifyChain, type EventDataMap } from "@seshat/core";
import { countTree, loadPack, PackError, packIntact, type LoadedPack, type PackRecord } from "./packs.ts";

/**
 * The pack directory (documentation/packs.md): `installed/<name>/` holds the files of each installed pack,
 * and `journal/` holds a journal whose `pack.installed` and `pack.removed` events say which packs are
 * installed. The directory listing is never the truth: a pack is installed when the journal says so and
 * the files match the hash it recorded.
 */
export const PACK_ACTOR = "orchestrator";

export class PackStoreError extends Error {}

export interface InstalledPack extends PackRecord {
  level1Accepted?: boolean | undefined;
  trust: EventDataMap["pack.installed"]["trust"];
  capabilities: string[];
  skills: string[];
  programs: string[];
  source: string;
  dir: string;
  /** The files on disk are the ones that were installed. */
  intact: boolean;
}

const journalDir = (packsDir: string): string => join(resolve(packsDir), "journal");
const installedDir = (packsDir: string, name: string): string => join(resolve(packsDir), "installed", name);

/** The installed packs, in name order: a fold of the pack events of the journal. */
export function installedPacks(packsDir: string): InstalledPack[] {
  const file = join(journalDir(packsDir), "journal.jsonl");
  if (!existsSync(file)) return [];
  const current = new Map<string, EventDataMap["pack.installed"]>();
  const events = readEvents(file);
  const chain = verifyChain(events);
  if (!chain.ok) {
    throw new PackStoreError(`the pack journal ${file} is corrupt at seq ${chain.seq}: ${chain.reason}; it was edited, so no pack on it can be trusted`);
  }
  for (const event of events) {
    if (event.type === "pack.installed") current.set(event.data.name, event.data);
    else if (event.type === "pack.removed") current.delete(event.data.name);
  }
  return [...current.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((d) => {
      const dir = installedDir(packsDir, d.name);
      return { ...d, dir, intact: intact(dir, d.hash) };
    });
}

const intact = (dir: string, hash: string): boolean => packIntact({ dir, hash });

/**
 * The installed packs, loaded again from their files and checked against the hash the journal recorded:
 * a pack changed on disk after its install is refused, so a run never uses files nobody installed.
 */
export function loadInstalledPacks(packsDir: string): LoadedPack[] {
  const loaded: LoadedPack[] = [];
  for (const record of installedPacks(packsDir)) {
    if (!record.intact) {
      throw new PackError([`pack ${record.name}: its files are not the ones installed (hash ${record.hash.slice(0, 12)}); run harness remove ${record.name}, then harness add it again`]);
    }
    const pack = loadPack(record.dir);
    if (pack.hash !== record.hash) throw new PackError([`pack ${record.name}: its content hash is not the recorded one`]);
    loaded.push(record.level1Accepted === true ? { ...pack, level1Granted: true } : pack);
  }
  return loaded;
}

export interface InstallOptions {
  /**
   * Accepts that the pack's tools start the programs and reach the servers it lists, when a run calls
   * them. Installing never starts any of them; without this the install is refused, and says which.
   */
  allowPrograms?: boolean;
  /** Capability ids that are taken: the repository's own catalog. */
  reserved?: ReadonlySet<string>;
  /** Honours the pack's own `level1` request from the next session; without it the request is only recorded. */
  level1?: boolean;
  /** Install over a pack of the same name (an upgrade): the journal records the removal and the install. */
  replace?: boolean;
  /** Where git clones go wrong in a test, or from. Default: the `git` program. */
  clone?: (url: string, into: string) => void;
}

const GIT_URL = /^(?:https?|ssh|git|file):\/\/|^git@[^:/\s]+:/;

/** Whether the source is a git url: a scheme we clone, `git@host:path`, or a name ending in `.git` that is no directory here. */
export function isGitUrl(source: string): boolean {
  return GIT_URL.test(source) || (source.endsWith(".git") && !existsSync(source));
}

/** The url without the user and password in it; a url that carries a password is refused, because the journal keeps `source` for good. */
export function redactUrl(source: string): string {
  if (!/^[a-z]+:\/\//i.test(source)) return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new PackStoreError(`${source.replace(/\/\/[^@/]*@/, "//***@")}: not a valid url`);
  }
  if (url.password !== "") throw new PackStoreError("the git url carries a password: put credentials in git's credential helper, not in the url, which the journal would keep");
  url.username = "";
  return url.toString();
}

function gitClone(url: string, into: string): void {
  try {
    // Cloning runs no code of the repository: no hook, no template, no submodule, no LFS filter, no fsmonitor, and only the
    // protocols a pack is fetched over; the user's and the system's git configuration is not read.
    execFileSync(
      "git",
      [
        "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
        "-c", "protocol.git.allow=always", "-c", "protocol.file.allow=always",
        "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false",
        "-c", "submodule.recurse=false", "-c", "clone.recurseSubmodules=false",
        "clone", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--template=", "--", url, into,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        timeout: 120_000,
      },
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8").trim();
    throw new PackStoreError(`cannot clone ${redactUrl(url)}: ${stderr || (error as Error).message}`.replace(/\/\/[^@/\s]*@/g, "//"));
  }
}

/**
 * `harness add`: copies (or clones) the source into a staging directory, validates it there, and only
 * then moves it into `installed/` and journals `pack.installed`. Nothing of the pack is executed.
 */
export function installPack(packsDir: string, source: string, options: InstallOptions = {}): { pack: LoadedPack; replaced?: PackRecord } {
  const root = resolve(packsDir);
  mkdirSync(join(root, "staging"), { recursive: true });
  const stage = mkdtempSync(join(root, "staging", "pack-"));
  try {
    if (isGitUrl(source)) {
      redactUrl(source); // refuses a url with a password before anything is fetched
      (options.clone ?? gitClone)(source, stage);
      rmSync(join(stage, ".git"), { recursive: true, force: true });
    } else {
      const from = resolve(source);
      if (!existsSync(from) || !statSync(from).isDirectory()) throw new PackStoreError(`${source}: not a directory or a git url`);
      const found: string[] = [];
      countTree(from, found);
      if (found.length > 0) throw new PackError(found);
      cpSync(from, stage, { recursive: true, filter: (path) => !/(^|[\\/])\.git$/.test(path) });
    }
    const pack = loadPack(stage);
    const { name } = pack.manifest;

    const installed = installedPacks(root);
    const same = installed.find((p) => p.name === name);
    if (same !== undefined && options.replace !== true) {
      throw new PackStoreError(`pack ${name} ${same.version} is installed; harness remove ${name} first, or add it again with --replace`);
    }
    const others = installed.filter((p) => p.name !== name);
    const problems: string[] = [];
    for (const capability of pack.capabilities) {
      const id = capability.manifest.id;
      if (options.reserved?.has(id) === true) problems.push(`${id} is a capability of the harness: a pack cannot replace it`);
      const owner = others.find((p) => p.capabilities.includes(id));
      if (owner !== undefined) problems.push(`${id} is already added by the pack ${owner.name}`);
    }
    for (const skill of pack.skills) {
      const owner = others.find((p) => p.skills.includes(skill.name));
      if (owner !== undefined) problems.push(`skill ${skill.name} is already added by the pack ${owner.name}`);
    }
    if (problems.length > 0) throw new PackError(problems.map((p) => `pack ${name}: ${p}`));
    if (pack.programs.length > 0 && options.allowPrograms !== true) {
      const env = pack.manifest.requires?.env ?? [];
      throw new PackStoreError(
        `pack ${name} has tools that would run ${pack.programs.map((p) => JSON.stringify(p)).join(", ")} when a run calls them. ` +
          (env.length > 0 ? `They may read these variables of your environment: ${env.join(", ")}. ` : "They read no variable of your environment. ") +
          "Installing runs none of it; read the manifests and add the pack again with --allow-programs to accept it",
      );
    }

    const dest = installedDir(root, name);
    if (same === undefined && existsSync(dest)) {
      throw new PackStoreError(`${dest} exists but the journal has no install of ${name} (a leftover): move or delete that directory, then add the pack again`);
    }
    mkdirSync(join(root, "installed"), { recursive: true });
    const journal = Journal.open(journalDir(root), "packs");
    try {
      if (same !== undefined) {
        journal.emit("pack.removed", { name, version: same.version, hash: same.hash }, PACK_ACTOR);
        rmSync(dest, { recursive: true, force: true });
      }
      renameSync(stage, dest);
      try {
        journal.emit(
          "pack.installed",
          {
            name,
            version: pack.manifest.version,
            hash: pack.hash,
            trust: pack.manifest.trust,
            capabilities: pack.capabilities.map((c) => c.manifest.id).sort(),
            skills: pack.skills.map((s) => s.name),
            programs: pack.programs,
            source: isGitUrl(source) ? redactUrl(source) : resolve(source),
            acceptedPrograms: pack.programs.length > 0,
            level1Accepted: options.level1 === true && (pack.manifest.level1 ?? []).length > 0,
            env: pack.manifest.requires?.env ?? [],
          },
          PACK_ACTOR,
        );
      } catch (error) {
        rmSync(dest, { recursive: true, force: true });
        throw error;
      }
    } finally {
      journal.close();
    }
    return { pack: { ...pack, dir: dest }, ...(same !== undefined ? { replaced: { name, version: same.version, hash: same.hash } } : {}) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** `harness remove`: journals `pack.removed`, then deletes the pack's files. */
export function removePack(packsDir: string, name: string): PackRecord {
  const root = resolve(packsDir);
  const found = installedPacks(root).find((p) => p.name === name);
  if (found === undefined) throw new PackStoreError(`no pack ${name} is installed`);
  const journal = Journal.open(journalDir(root), "packs");
  try {
    journal.emit("pack.removed", { name, version: found.version, hash: found.hash }, PACK_ACTOR);
  } finally {
    journal.close();
  }
  rmSync(found.dir, { recursive: true, force: true });
  return { name, version: found.version, hash: found.hash };
}
