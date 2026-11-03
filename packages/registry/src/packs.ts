import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CLAIM_STATUSES } from "@seshat/core";
import { CatalogError, loadCatalog, type Capability, type Catalog } from "./manifest.ts";
import { isPlainObject, validate, type JsonSchema } from "./schema.ts";

/**
 * An installable pack (documentation/packs.md): a directory with `pack.json`, capabilities in
 * `capabilities/<id>/` (manifest and contract, the layout of the repository's own catalog) and skills
 * in markdown files. A pack is untrusted input. Loading it executes nothing and reads nothing outside
 * its directory; it adds tools of level 2 only and can never write a claim's status.
 */

/** Evidence packs produce nothing a claim could cite; computed packs may say `computed` (an edge or a node, Ruling 13). */
export const PACK_TRUST_CLASSES = ["evidence", "computed"] as const;
export type PackTrust = (typeof PACK_TRUST_CLASSES)[number];

/** At most this many skills of a session are loaded in full (Global Constraint 16); the others are listed. */
export const SKILL_FULL_LIMIT = 3;

/** A skill file stays small: it is read by a model. */
export const MAX_SKILL_BYTES = 32 * 1024;
const MAX_FILES = 500;
const MAX_PACK_BYTES = 8 * 1024 * 1024;

export interface PackSkillSpec {
  name: string;
  description: string;
  /** Relative to the pack's directory. */
  file: string;
}

export interface PackRequirements {
  /** The hosts the pack's tools are offered on; absent: every host. */
  hosts?: string[];
  /** Programs that must be on the PATH for the tools to run; checked and reported, never installed. */
  commands?: string[];
  /** Environment variables the tools read. */
  env?: string[];
}

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  trust: PackTrust;
  /** Must be false. The field exists so that the manifest says it, and a pack that says otherwise is refused. */
  writesClaimStatus: false;
  /** The ids of the capabilities the pack adds, each in `capabilities/<id>/`. */
  capabilities: string[];
  /** Capabilities that ask to be in the level-1 declared set; they take effect in the next session, never in a running one. */
  level1?: string[];
  skills: PackSkillSpec[];
  requires?: PackRequirements;
}

export interface PackSkill extends PackSkillSpec {
  pack: string;
  /** The text of the file. */
  text: string;
}

export interface LoadedPack {
  manifest: PackManifest;
  dir: string;
  /** sha256 over the manifest and every file the pack carries. */
  hash: string;
  capabilities: Capability[];
  skills: PackSkill[];
  /** The programs and servers the pack's tools would reach when a run calls them. */
  programs: string[];
}

/** The part of a pack that a run records: enough to reproduce the run with the same packs. */
export interface PackRecord {
  name: string;
  version: string;
  hash: string;
}

export class PackError extends CatalogError {
  constructor(problems: string[]) {
    super(problems);
    this.message = `invalid pack:\n- ${problems.join("\n- ")}`;
  }
}

const NAME = "^[a-z][a-z0-9-]*$";

const PACK_SCHEMA: JsonSchema = {
  type: "object",
  required: ["name", "version", "trust", "writesClaimStatus", "capabilities", "skills"],
  properties: {
    name: { type: "string", pattern: NAME, maxLength: 64 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$" },
    description: { type: "string" },
    trust: { enum: [...PACK_TRUST_CLASSES] },
    writesClaimStatus: { const: false },
    capabilities: { type: "array", items: { type: "string", minLength: 1 } },
    level1: { type: "array", items: { type: "string", minLength: 1 } },
    skills: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "description", "file"],
        properties: {
          name: { type: "string", pattern: NAME, maxLength: 64 },
          description: { type: "string", minLength: 1, maxLength: 300 },
          file: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    requires: {
      type: "object",
      properties: {
        hosts: { type: "array", minItems: 1, items: { type: "string", pattern: NAME } },
        commands: { type: "array", items: { type: "string", minLength: 1 } },
        env: { type: "array", items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** Every file of a directory (not `.git`), as relative paths with their bytes; the problems are reported, not thrown. */
export function readTree(root: string, problems: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (dir === root && entry === ".git") continue;
      const path = join(dir, entry);
      const info = lstatSync(path);
      const rel = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) {
        problems.push(`${rel}: a symbolic link (a pack carries files, never links)`);
      } else if (info.isDirectory()) {
        walk(path);
      } else if (info.isFile()) {
        total += info.size;
        if (files.size >= MAX_FILES) {
          problems.push(`the pack has more than ${MAX_FILES} files`);
          return;
        }
        if (total > MAX_PACK_BYTES) {
          problems.push(`the pack is larger than ${MAX_PACK_BYTES} bytes`);
          return;
        }
        files.set(rel, readFileSync(path));
      } else {
        problems.push(`${rel}: neither a file nor a directory`);
      }
    }
  };
  walk(root);
  return files;
}

/** sha256 over the sorted paths and the sha256 of each file: the pack's identity. */
export function treeHash(files: ReadonlyMap<string, Buffer>): string {
  const h = createHash("sha256");
  for (const rel of [...files.keys()].sort()) {
    h.update(`${rel}\0${createHash("sha256").update(files.get(rel) as Buffer).digest("hex")}\n`);
  }
  return h.digest("hex");
}

/** The statuses a pack's capability may justify: `computed`, as an edge or a node, and nothing a claim holds. */
const PACK_PRODUCES: readonly string[] = ["computed"];

/**
 * Reads and checks the pack in `dir`. Every problem is reported together, in a `PackError`. Nothing in
 * the pack is executed: its servers are started only when a run calls one of its tools.
 */
export function loadPack(dir: string): LoadedPack {
  const root = resolve(dir);
  const problems: string[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new PackError([`${root}: not a directory`]);
  const files = readTree(root, problems);
  const manifestBytes = files.get("pack.json");
  if (manifestBytes === undefined) throw new PackError([...problems, `${root}: no pack.json`]);
  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new PackError([...problems, `pack.json: ${(error as Error).message}`]);
  }
  const shape = validate(PACK_SCHEMA, raw, "pack.json");
  if (shape.length > 0) {
    const unknown = isPlainObject(raw) ? Object.keys(raw).filter((k) => !(k in (PACK_SCHEMA.properties ?? {}))) : [];
    throw new PackError([
      ...problems,
      ...shape,
      ...(unknown.length > 0 ? [`pack.json has fields no pack may have (${unknown.join(", ")}): a pack runs no install script and sets nothing outside its manifest`] : []),
    ]);
  }
  const manifest = raw as PackManifest;
  const at = `pack ${manifest.name}:`;

  // Capabilities: the repository's own loader checks manifests, schemas and contracts; the pack's rules come on top.
  let catalog: Catalog | undefined;
  const capabilitiesDir = join(root, "capabilities");
  const hasDir = [...files.keys()].some((f) => f.startsWith("capabilities/"));
  if (manifest.capabilities.length === 0 && hasDir) problems.push(`${at} capabilities/ exists but pack.json lists no capability`);
  if (manifest.capabilities.length > 0) {
    if (new Set(manifest.capabilities).size !== manifest.capabilities.length) problems.push(`${at} a capability is listed twice`);
    try {
      catalog = loadCatalog(capabilitiesDir);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      problems.push(...error.problems.map((p) => `${at} ${p}`));
    }
  }
  const capabilities: Capability[] = [];
  const programs: string[] = [];
  if (catalog !== undefined) {
    const found = [...catalog.capabilities.keys()].sort();
    for (const id of manifest.capabilities) if (!catalog.capabilities.has(id)) problems.push(`${at} lists ${id}, which capabilities/ does not carry`);
    for (const id of found) if (!manifest.capabilities.includes(id)) problems.push(`${at} capabilities/ carries ${id}, which pack.json does not list`);
    for (const id of manifest.level1 ?? []) if (!manifest.capabilities.includes(id)) problems.push(`${at} level1 names ${id}, which the pack does not add`);
    for (const capability of catalog.capabilities.values()) {
      if (!manifest.capabilities.includes(capability.manifest.id)) continue;
      capabilities.push(capability);
      problems.push(...capabilityRules(manifest, capability));
      for (const impl of capability.manifest.implementations) {
        if (impl.kind !== "mcp") continue;
        programs.push(impl.server.transport === "stdio" ? [impl.server.command, ...(impl.server.args ?? [])].join(" ") : impl.server.url);
      }
    }
  }

  // Skills: human-written files of the pack, at most MAX_SKILL_BYTES each.
  const skills: PackSkill[] = [];
  const skillNames = new Set<string>();
  for (const spec of manifest.skills) {
    if (skillNames.has(spec.name)) problems.push(`${at} skill ${spec.name} is declared twice`);
    skillNames.add(spec.name);
    const target = resolve(root, spec.file);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      problems.push(`${at} skill ${spec.name}: ${JSON.stringify(spec.file)} is outside the pack`);
      continue;
    }
    const bytes = files.get(rel.split(sep).join("/"));
    if (bytes === undefined) {
      problems.push(`${at} skill ${spec.name}: no file ${spec.file}`);
      continue;
    }
    if (!/\.(md|txt)$/.test(spec.file)) problems.push(`${at} skill ${spec.name}: ${spec.file} must be a .md or .txt file`);
    if (bytes.length > MAX_SKILL_BYTES) problems.push(`${at} skill ${spec.name}: ${spec.file} is larger than ${MAX_SKILL_BYTES} bytes`);
    skills.push({ ...spec, pack: manifest.name, text: bytes.toString("utf8") });
  }

  if (problems.length > 0) throw new PackError(problems);
  return { manifest, dir: root, hash: treeHash(files), capabilities, skills, programs };
}

/** What a pack's capability may be: level 2, MCP, `computed` at most, with contract cases of its own. */
function capabilityRules(pack: PackManifest, capability: Capability): string[] {
  const m = capability.manifest;
  const at = `pack ${pack.name}: ${m.id}:`;
  const problems: string[] = [];
  if (m.exposure !== "deferred") {
    problems.push(
      `${at} exposure is ${m.exposure}; a pack's tools are level 2 (deferred). A tool that wants the level-1 declared set is named in pack.json "level1" and takes effect in the next session`,
    );
  }
  for (const status of m.produces ?? []) {
    if (!PACK_PRODUCES.includes(status)) {
      problems.push(
        `${at} produces ${status}: a pack never writes a claim's status (Ruling 13); its output is computed at most${(CLAIM_STATUSES as readonly string[]).includes(status) ? "" : " (and this is not a status)"}`,
      );
    }
  }
  if (pack.trust === "evidence" && (m.produces ?? []).length > 0) problems.push(`${at} the pack's trust class is evidence, so its tools produce no status`);
  if (m.certificate !== undefined) problems.push(`${at} a certificate is how a result becomes proved or refuted, and a pack's tools never are`);
  for (const impl of m.implementations) {
    if (impl.kind !== "mcp") problems.push(`${at} implementation ${impl.id} is ${impl.kind}: a pack carries MCP servers, never code that runs inside the harness`);
  }
  if (capability.contract.length === 0) problems.push(`${at} the pack carries no contract case for it`);
  return problems;
}

/** The pack's capabilities as the registry offers them: only on the hosts the pack names, bound to all their implementations. */
export function offeredOn(pack: LoadedPack, host: string): boolean {
  const hosts = pack.manifest.requires?.hosts;
  return hosts === undefined || hosts.includes(host);
}

/** What a pack asks of the machine that is not there: programs not on the PATH and variables not set. */
export function missingRequirements(pack: LoadedPack, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const missing: string[] = [];
  const paths = (env.PATH ?? "").split(delimiter).filter((p) => p !== "");
  for (const command of pack.manifest.requires?.commands ?? []) {
    const found = command.includes("/") ? existsSync(command) : paths.some((p) => existsSync(join(p, command)));
    if (!found) missing.push(`program ${command}`);
  }
  for (const name of pack.manifest.requires?.env ?? []) if ((env[name] ?? "") === "") missing.push(`variable ${name}`);
  return missing;
}

export function packRecord(pack: Pick<LoadedPack, "manifest" | "hash">): PackRecord {
  return { name: pack.manifest.name, version: pack.manifest.version, hash: pack.hash };
}
