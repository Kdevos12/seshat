import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CLAIM_STATUSES } from "@seshat/core";
import { ASK_MAX, bankOf, type BankCard, cardProblems, type HeuristicCard, type Overlap, overlaps } from "@seshat/heuristics";
import { CatalogError, loadCatalog, type Capability, type Catalog, type McpServerSpec } from "./manifest.ts";
import { isPlainObject, validate, type JsonSchema } from "./schema.ts";

/**
 * An installable pack (documentation/packs.md): a directory with `pack.json`, capabilities in
 * `capabilities/<id>/` (manifest and contract, the layout of the repository's own catalog) and skills
 * in markdown files, heuristic cards in `heuristics` (documentation/heuristics.md). A pack is untrusted input. Loading it executes nothing and reads nothing outside
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
  /**
   * Heuristic cards the pack adds to the bank (documentation/heuristics.md): methods of reasoning written by
   * the pack's author, never a tool and never a fact. Each id starts with the pack's name.
   */
  heuristics?: HeuristicCard[];
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
  /** The pack's heuristic cards, checked: valid, no id of the bank's built-in cards. */
  heuristics: HeuristicCard[];
  /** The pack's cards that say what a built-in card or another of its own cards says: reported, not refused. */
  overlaps: Overlap[];
  /** The programs and servers the pack's tools would reach when a run calls them. */
  programs: string[];
  /** The owner accepted, at install, that the pack's `level1` request is honoured (`harness add --level1`). */
  level1Granted?: boolean;
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
    heuristics: { type: "array", items: { type: "object" } },
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
      if (entry === ".git") continue;
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

/** The size limits, checked on a source directory by looking, before anything is copied; `.git` is not counted. */
export function countTree(root: string, problems: string[]): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const info = lstatSync(join(dir, entry));
      if (info.isDirectory()) {
        if (!walk(join(dir, entry))) return false;
        continue;
      }
      files += 1;
      bytes += info.size;
      if (files > MAX_FILES || bytes > MAX_PACK_BYTES) {
        problems.push(`${root}: more than ${MAX_FILES} files or ${MAX_PACK_BYTES} bytes: a pack is small, and nothing was copied`);
        return false;
      }
    }
    return true;
  };
  walk(root);
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
  const described = manifest.description === undefined ? undefined : screenPackText(manifest.description, 300);
  if (described !== undefined) problems.push(`pack ${manifest.name}: description: ${described}`);
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
        programs.push(describeServer(impl.server));
        problems.push(...envProblems(manifest, capability.manifest.id, impl.id, impl.server));
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
    const bad = screenPackText(spec.description, 300);
    if (bad !== undefined) problems.push(`${at} skill ${spec.name}: its description: ${bad}`);
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(bytes.toString("utf8"))) problems.push(`${at} skill ${spec.name}: ${spec.file} holds control characters`);
    skills.push({ ...spec, pack: manifest.name, text: bytes.toString("utf8") });
  }

  const cards = heuristicRules(manifest, problems);

  if (problems.length > 0) throw new PackError(problems);
  return { manifest, dir: root, hash: treeHash(files), capabilities, skills, heuristics: cards.heuristics, overlaps: cards.overlaps, programs };
}

/** The prefix of a pack's card ids, as of its tools: `pack_`, its name with `_` for `-`, then a dot. No built-in card starts so. */
export const cardPrefixOf = (pack: string): string => `pack_${pack.replace(/-/g, "_")}.`;

/**
 * What a pack's cards may be: valid cards of the format (documentation/heuristics.md), ids that start with the pack's
 * name and are not taken in the bank, and an ask that passes the screen for a pack's text. Overlaps with the built-in
 * cards are returned, for the install to show: two cards that say the same thing are measured apart, and the person
 * who installs chooses.
 */
function heuristicRules(manifest: PackManifest, problems: string[]): { heuristics: HeuristicCard[]; overlaps: Overlap[] } {
  const list = manifest.heuristics ?? [];
  const at = `pack ${manifest.name}:`;
  const prefix = cardPrefixOf(manifest.name);
  const heuristics: HeuristicCard[] = [];
  let ok = true;
  // The first part of a card id is at most 32 characters (CARD_ID), and a pack's starts with pack_ and its name.
  const maxName = 32 - "pack_".length;
  if (list.length > 0 && manifest.name.length > maxName) {
    problems.push(`${at} a pack whose name is longer than ${maxName} characters cannot carry cards: its card ids start with ${prefix}, and the first part of a card id is at most 32 characters`);
    return { heuristics, overlaps: [] };
  }
  for (const [i, value] of list.entries()) {
    const id = isPlainObject(value) && typeof value.id === "string" ? value.id : `heuristics[${i}]`;
    const found = cardProblems(value);
    if (found.length > 0) {
      ok = false;
      problems.push(...found.map((p) => `${at} card ${id}: ${p}`));
      continue;
    }
    const card = value as HeuristicCard;
    if (!card.id.startsWith(prefix)) {
      ok = false;
      problems.push(`${at} card ${card.id}: a pack's card ids start with ${prefix} (its name, as its tools do), so that no two packs and no built-in card, present or later, share one`);
    }
    // The briefing fences a pack's card between [begin text of pack:NAME] and [end text of pack:NAME]: a bracket in the
    // question could pose as that fence.
    if (/[[\]]/.test(card.ask)) {
      ok = false;
      problems.push(`${at} card ${card.id}: its ask holds a bracket ([ or ]), which could pose as the fence the briefing quotes it in`);
    }
    const screened = screenPackText(card.ask, ASK_MAX);
    if (screened !== undefined) {
      ok = false;
      problems.push(`${at} card ${card.id}: its ask: ${screened}`);
    }
    heuristics.push(card);
  }
  if (!ok || heuristics.length === 0) return { heuristics, overlaps: [] };
  let bank: BankCard[];
  try {
    bank = bankOf([{ name: manifest.name, heuristics }]);
  } catch (error) {
    problems.push(`${at} ${(error as Error).message}`);
    return { heuristics, overlaps: [] };
  }
  const own = new Set(heuristics.map((c) => c.id));
  return { heuristics, overlaps: overlaps(bank).filter((o) => own.has(o.a) || own.has(o.b)) };
}

/** A server as the install confirmation shows it: what it runs or reaches, with the names of the headers and variables it sets. */
function describeServer(server: McpServerSpec): string {
  if (server.transport === "stdio") {
    const env = Object.keys(server.env ?? {});
    return [server.command, ...(server.args ?? [])].join(" ") + (env.length > 0 ? ` [env: ${env.join(", ")}]` : "");
  }
  const headers = Object.keys(server.headers ?? {});
  return server.url + (headers.length > 0 ? ` [headers: ${headers.join(", ")}]` : "");
}

/** The harness's environment is not a pack's: it may read `${env:NAME}` only for the names its `requires.env` gives, which the install shows. */
export function envProblems(pack: PackManifest, id: string, implId: string, server: unknown): string[] {
  const allowed = new Set(pack.requires?.env ?? []);
  const names = new Set([...JSON.stringify(server).matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] as string));
  return [...names]
    .filter((n) => !allowed.has(n))
    .map((n) => `pack ${pack.name}: ${id}/${implId} reads \${env:${n}}, which pack.json requires.env does not name: a pack gets only the variables it declares`);
}

const INSTRUCTION = /\b(?:ignore|disregard|override|forget|pretend)\b|\bprevious instructions?\b|\bsystem prompt\b|\byou are now\b|\bdo not (?:tell|mention)\b/i;

/**
 * The screen for text a pack's author wrote and a model will read (descriptions, `when`, schema descriptions, skill
 * descriptions): one line, no control characters, no link, no markup that could pose as a heading or a tag, and no
 * instruction aimed at the model (Global Constraint 16). Returns the reason, or undefined.
 */
export function screenPackText(text: string, max: number): string | undefined {
  if (text.length > max) return `it is longer than ${max} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return "it holds control characters";
  if (/https?:|www\./i.test(text)) return "it holds a link";
  if (/`|<|>|^\s*#|\n\s*#/.test(text)) return "it holds markup (a fence, a tag or a heading)";
  if (INSTRUCTION.test(text)) return "it reads as an instruction to the model";
  return undefined;
}

function schemaTexts(schema: unknown, path: string, out: Array<[string, string]>): void {
  if (Array.isArray(schema)) schema.forEach((s, i) => schemaTexts(s, `${path}[${i}]`, out));
  else if (isPlainObject(schema)) {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "description" && typeof v === "string") out.push([`${path}.description`, v]);
      else if (k === "properties" && isPlainObject(v)) for (const [name, sub] of Object.entries(v)) schemaTexts(sub, `${path}.${name}`, out);
      else if (k === "items" || k === "anyOf" || k === "additionalProperties") schemaTexts(v, `${path}.${k}`, out);
    }
  }
}

/** Every free text of a capability that reaches a model: its definition (the prompt prefix at level 1) and the tool index. */
function screenCapability(pack: PackManifest, m: Capability["manifest"]): string[] {
  const texts: Array<[string, string, number]> = [
    ["title", m.title, 80],
    ["description", m.description, 1500],
    ...m.when.map((w, i): [string, string, number] => [`when[${i}]`, w, 300]),
    ...m.whenNot.map((w, i): [string, string, number] => [`whenNot[${i}]`, w, 300]),
  ];
  const nested: Array<[string, string]> = [];
  schemaTexts(m.input, "input", nested);
  schemaTexts(m.output, "output", nested);
  for (const [where, text] of nested) texts.push([where, text, 300]);
  return texts.flatMap(([where, text, max]) => {
    const reason = screenPackText(text, max);
    return reason === undefined ? [] : [`pack ${pack.name}: ${m.id}: ${where}: ${reason}`];
  });
}

/** What a pack's capability may be: level 2, MCP, `computed` at most, with contract cases of its own. */
function capabilityRules(pack: PackManifest, capability: Capability): string[] {
  const m = capability.manifest;
  const at = `pack ${pack.name}: ${m.id}:`;
  const problems: string[] = [];
  const prefix = `pack_${pack.name.replace(/-/g, "_")}.`;
  if (!m.id.startsWith(prefix)) {
    problems.push(`${at} a pack's tool ids start with ${prefix} (its name), so that the tool a model calls, ${prefix.replace(".", "_")}NAME, never takes the name of a tool of the harness or of another pack`);
  }
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
  problems.push(...screenCapability(pack, m));
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

/** Whether the pack's files are still the ones whose hash it was loaded with. */
export function packIntact(pack: Pick<LoadedPack, "dir" | "hash">): boolean {
  if (!existsSync(pack.dir)) return false;
  const problems: string[] = [];
  const files = readTree(pack.dir, problems);
  return problems.length === 0 && treeHash(files) === pack.hash;
}
