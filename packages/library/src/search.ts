import { maskCommentsAndStrings, readDeclarationHead, splitCommands } from "@seshat/core";
import type { LeanEnvPin } from "@seshat/registry";
import { Bm25Index } from "./bm25.ts";
import { combine, HashedVectors, type Scores, toScores } from "./hybrid.ts";
import type { LibraryLemma } from "./records.ts";
import { glossOf, lemmaText } from "./lemmas.ts";

/**
 * Where a search result comes from, in the order they are ranked (plan change LC2): the declarations of
 * the problem's own file, the harness library, the extra packages of the Lean environment, Mathlib.
 */
export const SOURCES = ["local", "library", "extra", "mathlib"] as const;
export type Source = (typeof SOURCES)[number];

/** A declaration of the Lean environment, as the `lean.meta` export gives it (documentation/library.md, "The export"). */
export interface ExportedDeclaration {
  /** The full name. */
  name: string;
  /** Its type or statement, as Lean prints it. */
  signature: string;
  gloss?: string;
  /** The package it comes from; absent or `Mathlib` for Mathlib. */
  package?: string;
  /** The module to import for it, when the export knows. */
  module?: string;
}

/** Exports the declarations of the environment (once per environment hash; the line caches the answer). */
export type DeclarationExport = (env: LeanEnvPin | undefined) => Promise<readonly ExportedDeclaration[]>;

/** One thing a search can return. */
export interface Entry {
  id: string;
  name: string;
  source: Source;
  /** What the briefing shows as its source: `this file`, `library`, `PFR`, `Mathlib`. */
  label: string;
  signature: string;
  gloss: string;
  /** For a library lemma: the ready `aux_...` text with its proof. */
  text?: string;
  /** The module to import, when known and not already in the problem's header. */
  module?: string;
  /** For a library lemma, the standing of its claim. */
  claimStatus?: string;
}

export function libraryEntry(lemma: LibraryLemma): Entry {
  return {
    id: lemma.name,
    name: lemma.name,
    source: "library",
    label: "library",
    signature: lemma.statement,
    gloss: glossOf(lemma.gloss) ?? "",
    text: lemmaText(lemma),
    claimStatus: lemma.claimStatus,
  };
}

export function declarationEntry(d: ExportedDeclaration): Entry {
  const extra = d.package !== undefined && d.package !== "Mathlib";
  return {
    id: `${extra ? d.package : "Mathlib"}:${d.name}`,
    name: d.name,
    source: extra ? "extra" : "mathlib",
    label: extra ? (d.package as string) : "Mathlib",
    signature: d.signature,
    gloss: glossOf(d.gloss) ?? "",
    ...(d.module !== undefined ? { module: d.module } : {}),
  };
}

/** The declarations of a problem's file before its target: the names the prover can already use. */
export function localEntries(prefix: string): Entry[] {
  const commands = splitCommands(prefix);
  const out: Entry[] = [];
  commands.forEach((command, k) => {
    if (command.kind !== "code") return;
    const head = readDeclarationHead(command.text);
    if (head === undefined || head.name === "" || !["theorem", "lemma", "def", "abbrev", "structure", "class", "inductive"].includes(head.keyword)) return;
    const masked = maskCommentsAndStrings(command.text);
    let depth = 0;
    let end = masked.length;
    for (let i = head.nameEnd; i < masked.length; i++) {
      const c = masked[i] as string;
      if ("([{⟨⦃".includes(c)) depth++;
      else if (")]}⟩⦄".includes(c)) depth--;
      else if (depth === 0 && c === ":" && masked[i + 1] === "=") {
        end = i;
        break;
      }
    }
    const previous = commands[k - 1];
    const gloss = previous?.kind === "docstring" ? previous.text.replace(/^\/--|-\/\s*$/g, "").replace(/\s+/g, " ").trim() : "";
    out.push({
      id: `local:${head.name}`,
      name: head.name,
      source: "local",
      label: "this file",
      signature: command.text.slice(head.nameEnd, end).replace(/\s+/g, " ").trim().slice(0, 300),
      gloss: glossOf(gloss) ?? "",
    });
  });
  return out;
}

/** How a tier is ranked: BM25 alone, or the convex combination of BM25 and the hashed vectors (PC5 item 2). */
export interface Ranking {
  mode: "bm25" | "hybrid";
  /** For `hybrid`: the weight of BM25; the vector channel has the rest. */
  bm25Weight: number;
}

export const DEFAULT_RANKING: Ranking = { mode: "bm25", bm25Weight: 0.7 };

const documentOf = (e: Entry) => ({ id: e.id, fields: { name: e.name, signature: e.signature, gloss: e.gloss } });

/** The entries of one source, with the indexes that rank them. */
export class Tier {
  readonly entries: readonly Entry[];
  readonly #bm25: Bm25Index;
  #vectors: HashedVectors | undefined;
  readonly #byId: Map<string, Entry>;

  constructor(entries: readonly Entry[]) {
    this.entries = entries;
    this.#byId = new Map(entries.map((e) => [e.id, e]));
    this.#bm25 = new Bm25Index(entries.map(documentOf));
  }

  /** The entries that match the query, best first. */
  search(query: string, ranking: Ranking = DEFAULT_RANKING, limit = 10): Array<{ entry: Entry; score: number }> {
    let scores: Scores = toScores(this.#bm25.search(query));
    if (ranking.mode === "hybrid") {
      this.#vectors ??= new HashedVectors(this.entries.map(documentOf));
      scores = combine([
        { scores, weight: ranking.bm25Weight },
        { scores: toScores(this.#vectors.search(query)), weight: 1 - ranking.bm25Weight },
      ]);
    }
    return [...scores]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([id, score]) => ({ entry: this.#byId.get(id) as Entry, score }));
  }
}

/** How many results each source may give. The ranking is by source first (local, library, extra, Mathlib), then by score. */
export type Caps = Record<Source, number>;

export const DEFAULT_CAPS: Readonly<Caps> = { local: 3, library: 5, extra: 3, mathlib: 5 };

export interface Hit {
  entry: Entry;
  score: number;
}

/** Searches the tiers in the order of LC2 and returns at most `caps` from each, the earlier source first. */
export function searchTiers(tiers: Readonly<Partial<Record<Source, Tier>>>, query: string, caps: Readonly<Caps> = DEFAULT_CAPS, ranking: Ranking = DEFAULT_RANKING): Hit[] {
  return SOURCES.flatMap((source) => tiers[source]?.search(query, ranking, caps[source]) ?? []);
}
