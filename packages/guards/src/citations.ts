import { type Json, splitCommands, readDeclarationHead } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import { clip, DECLARATION_KEYWORDS, hasHole, leanComments } from "./text.ts";

/**
 * `[cite: ID]`: how a worker cites an id of its packet or of the graph, or a source. Several ids
 * may stand in one marker, separated by commas or semicolons.
 */
const MARKER = /\[cite:\s*([^\]\n]*)\]/gi;

/** External identifiers, which are references wherever they stand. */
const EXTERNAL: ReadonlyArray<RegExp> = [
  /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?/gi,
  /\bdoi:\s*10\.\d{4,9}\/[^\s,;)\]]+/gi,
  /\bOEIS\s*A\d{6}\b/g,
  /\bMR\s?\d{5,8}\b/g,
];

/**
 * Wordings that present a statement as an established result of the literature. In a passage with
 * no marker that resolves, such an appeal is a citation without a source.
 */
const APPEALS: readonly RegExp[] = [
  /\b(?:well|widely)[- ]known\b/i,
  /\bknown (?:result|theorem|lemma|fact|bound|inequality|identity)\b/i,
  /\b(?:standard|classical|textbook) (?:result|theorem|lemma|fact)\b/i,
  /\bfolklore\b/i,
  /\bit is known that\b/i,
  /\bby (?:a|the) (?:theorem|result|lemma) of [A-Z]\w+/,
  /\b(?:theorem|lemma|proposition|corollary)\s+\d+(?:\.\d+)*\s+(?:of|in|from)\b/i,
  /\b[A-Z][a-z]+(?:[- ][A-Z][a-z]+)*(?: et al\.?)?\s*[[(]\s*\d{4}\s*[\])]/,
];

/** What a reference is: a `[cite: ...]` marker, an external identifier, or an appeal with no id. */
export type ReferenceKind = "marker" | "external" | "appeal";

export interface Reference {
  /** The id a marker or an external identifier gives; for an appeal, a fixed description. */
  text: string;
  kind: ReferenceKind;
}

const APPEAL_TEXT = "an appeal to a known result, with no source";

/** Whether a passage presents something as known, with an appeal or a marker. */
export function presentsAsKnown(passage: string): boolean {
  return APPEALS.some((pattern) => pattern.test(passage)) || new RegExp(MARKER.source, "i").test(passage);
}

/** The references of one passage (a comment, a paragraph of notes). */
export function referencesIn(passage: string): Reference[] {
  const found: Reference[] = [];
  for (const marker of passage.matchAll(MARKER)) {
    const items = (marker[1] ?? "")
      .split(/[,;]/)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length === 0) found.push({ text: "", kind: "marker" });
    for (const item of items) found.push({ text: item, kind: "marker" });
  }
  for (const pattern of EXTERNAL) {
    for (const match of passage.matchAll(pattern)) found.push({ text: match[0].replace(/\s+/g, " "), kind: "external" });
  }
  if (!found.some((r) => r.kind === "marker" || r.kind === "external") && APPEALS.some((pattern) => pattern.test(passage))) {
    found.push({ text: APPEAL_TEXT, kind: "appeal" });
  }
  return found;
}

/** What references are resolved against. */
export interface CitationEnv {
  /** The graph: claims, edges and nodes, and the `source` nodes among them. */
  memory: MemoryStore;
  /** The short ids the session's packet shows the prover (`C17`, `L4`). */
  packetIds?: Iterable<string>;
  /**
   * Whether a name is a declaration the project knows, such as a Mathlib lemma. The Lean meta tool
   * will answer this; without it, a name resolves only through a `source` node.
   */
  declarationExists?: (name: string) => boolean | Promise<boolean>;
}

/** The ids of the graph look like `clm_...`, `edg_...` and `nod_...`. */
const GRAPH_ID = /^(clm|edg|nod)_[0-9A-Z]{26}$/;

/** A reference with its prefix and spacing out and its case folded, to compare with a source's names. */
export function normalizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/^(?:src|source):\s*/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** The names a `source` node answers to: its id, reference, name, declaration, title, url and identifiers, and its aliases. */
export function sourceKeys(data: Json): string[] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const keys: string[] = [];
  for (const field of ["id", "ref", "name", "declaration", "title", "url", "arxiv", "doi", "oeis"]) {
    const value = data[field];
    if (typeof value === "string" && value.trim() !== "") keys.push(value);
  }
  for (const field of ["names", "aliases", "refs"]) {
    const value = data[field];
    if (Array.isArray(value)) keys.push(...value.filter((v): v is string => typeof v === "string" && v.trim() !== ""));
  }
  return keys;
}

/** How a reference resolved: against the packet, a claim, an edge, a node, a `source` node, or a known declaration. */
export type ResolvedVia = "packet" | "claim" | "edge" | "node" | "source" | "declaration";

/**
 * What a reference names, or undefined when it names nothing known. An id of the packet or of the
 * graph resolves to itself; any other reference resolves only to a `source` node that answers to it,
 * or to a declaration `declarationExists` knows. `src:` in front of a reference restricts it to sources.
 */
export async function resolveReference(ref: string, env: CitationEnv): Promise<ResolvedVia | undefined> {
  const text = ref.trim();
  if (text === "") return undefined;
  const onlySource = /^(?:src|source):/i.test(text);
  if (!onlySource) {
    if (env.packetIds !== undefined && [...env.packetIds].includes(text)) return "packet";
    const graph = GRAPH_ID.exec(text)?.[1];
    if (graph === "clm" && env.memory.claim(text) !== undefined) return "claim";
    if (graph === "edg" && env.memory.edge(text) !== undefined) return "edge";
    if (graph === "nod" && env.memory.node(text) !== undefined) return "node";
  }
  const wanted = normalizeRef(text);
  for (const node of env.memory.nodes("source")) {
    if (sourceKeys(node.data).some((key) => normalizeRef(key) === wanted)) return "source";
  }
  const name = text.replace(/^(?:src|source):\s*/i, "");
  if (env.declarationExists !== undefined && /^[\p{L}_][\p{L}\p{N}_'.]*$/u.test(name) && (await env.declarationExists(name))) return "declaration";
  return undefined;
}

/**
 * The references of these passages that do not resolve, as a worker should be told them: a marker's
 * id, an external identifier, or the description of an appeal to a known result with no source. A
 * passage that gives a marker or an identifier is judged by them alone.
 */
export async function unresolvedReferences(passages: readonly string[], env: CitationEnv): Promise<string[]> {
  const bad: string[] = [];
  for (const passage of passages) {
    for (const reference of referencesIn(passage)) {
      if (reference.kind === "appeal") {
        bad.push(reference.text);
      } else if ((await resolveReference(reference.text, env)) === undefined) {
        bad.push(reference.kind === "marker" ? `[cite: ${clip(reference.text, 60)}]` : clip(reference.text, 60));
      }
    }
  }
  return [...new Set(bad)];
}

/**
 * The declarations and tactic blocks of a Lean source that are left as `sorry` and presented as
 * known: a comment just above them or inside them appeals to a known result or cites a source (plan
 * §9). A `sorry` is an open goal, not a result, so this blocks even when the citation resolves. Gives
 * the name of each declaration, or `the proof` for a block that is not one.
 */
export function knownSorries(source: string): string[] {
  const found: string[] = [];
  let above: string[] = [];
  for (const command of splitCommands(source)) {
    if (command.kind !== "code") {
      above.push(...leanComments(command.text).map((c) => c.text));
      continue;
    }
    if (hasHole(command.text)) {
      const passages = [...above, ...leanComments(command.text).map((c) => c.text)];
      if (passages.some(presentsAsKnown)) {
        const head = readDeclarationHead(command.text);
        found.push(head !== undefined && head.name !== "" && DECLARATION_KEYWORDS.has(head.keyword) ? head.name : "the proof");
      }
    }
    above = [];
  }
  return [...new Set(found)];
}
