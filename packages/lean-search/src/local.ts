import { readFileSync, statSync } from "node:fs";
import { type Declaration, isDeclarationName } from "./names.ts";

/**
 * The local index: a file of declarations (name, type, optional doc string) searched without a model. `search` ranks by BM25 over the
 * words of the name, the type and the doc string (no learned component); `matchPattern` keeps the declarations whose type holds all the
 * symbols and words of a pattern. Strings are capped as they are read, so that a large file stays a bounded index.
 */

/** The largest index file read, in bytes. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_TYPE_CHARS = 2_000;
const MAX_DOC_CHARS = 1_000;

const K1 = 1.2;
const B = 0.75;
/** A name counts for this many occurrences of its words: a query word in the name says more than one in a doc string. */
const NAME_WEIGHT = 3;

/** Words (letters and digits, camelCase split) and mathematical symbols; `.`, `_`, `'` and brackets separate. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  const found = spaced.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}_.'()[\]{},:;⊢]/gu) ?? [];
  return found.map((t) => t.toLowerCase());
}

export interface IndexHit {
  declaration: Declaration;
  score: number;
}

export class LocalIndex {
  readonly size: number;
  readonly #entries: Declaration[];
  readonly #postings = new Map<string, Map<number, number>>();
  readonly #typePostings = new Map<string, number[]>();
  readonly #lengths: number[] = [];
  readonly #average: number;

  constructor(entries: readonly Declaration[]) {
    this.#entries = [...entries];
    this.size = entries.length;
    let total = 0;
    this.#entries.forEach((entry, id) => {
      const nameTokens = tokenize(entry.name);
      const typeTokens = tokenize(entry.type ?? "");
      const tokens = [...Array.from({ length: NAME_WEIGHT }, () => nameTokens).flat(), ...typeTokens, ...tokenize(entry.doc ?? "")];
      this.#lengths.push(tokens.length);
      total += tokens.length;
      for (const token of tokens) {
        let posting = this.#postings.get(token);
        if (posting === undefined) this.#postings.set(token, (posting = new Map()));
        posting.set(id, (posting.get(id) ?? 0) + 1);
      }
      for (const token of new Set(typeTokens)) {
        const ids = this.#typePostings.get(token);
        if (ids === undefined) this.#typePostings.set(token, [id]);
        else ids.push(id);
      }
    });
    this.#average = this.size === 0 ? 1 : Math.max(1, total / this.size);
  }

  /** The declarations that read best against the query, best first (BM25). */
  search(query: string, limit: number): Declaration[] {
    const words = [...new Set(tokenize(query))];
    const scores = new Map<number, number>();
    for (const word of words) {
      const posting = this.#postings.get(word);
      if (posting === undefined) continue;
      const idf = Math.log(1 + (this.size - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, frequency] of posting) {
        const length = this.#lengths[id] as number;
        const part = (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / this.#average));
        scores.set(id, (scores.get(id) ?? 0) + part);
      }
    }
    return this.#top(scores, limit);
  }

  /** The declarations whose type has every word and symbol of the pattern (`_` and `?x` stand for anything), the shortest type first. */
  matchPattern(pattern: string, limit: number): Declaration[] {
    const words = [...new Set(tokenize(pattern.replace(/\?[\p{L}\p{N}_]*/gu, " ").replace(/\b_\b/g, " ")))];
    if (words.length === 0) return [];
    let ids: number[] | undefined;
    for (const word of words) {
      const posting = this.#typePostings.get(word);
      if (posting === undefined) return [];
      ids = ids === undefined ? posting : ids.filter((id) => posting.includes(id));
      if (ids.length === 0) return [];
    }
    const scores = new Map<number, number>();
    for (const id of ids ?? []) scores.set(id, 1 / (1 + (this.#entries[id]?.type?.length ?? 0)));
    return this.#top(scores, limit);
  }

  #top(scores: Map<number, number>, limit: number): Declaration[] {
    return [...scores]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([id]) => this.#entries[id] as Declaration);
  }
}

/** One line of the file or one element of its array, as a declaration; undefined when it is not one (bad name, no name). */
function declarationOf(value: unknown): Declaration | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { name, type, doc } = value as Record<string, unknown>;
  if (!isDeclarationName(name)) return undefined;
  return {
    name,
    ...(typeof type === "string" && type !== "" ? { type: type.slice(0, MAX_TYPE_CHARS) } : {}),
    ...(typeof doc === "string" && doc !== "" ? { doc: doc.slice(0, MAX_DOC_CHARS) } : {}),
  };
}

/** The declarations of an index file: a JSON array of `{name, type?, doc?}`, or one such object a line (JSONL). Lines that are not one are skipped. */
export function parseIndex(text: string): Declaration[] {
  const trimmed = text.trimStart();
  const values: unknown[] = [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) values.push(...parsed);
  } else {
    for (const line of trimmed.split("\n")) {
      if (line.trim() === "") continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        // A line that is not JSON is skipped.
      }
    }
  }
  return values.flatMap((v) => declarationOf(v) ?? []);
}

export function loadIndex(path: string): LocalIndex {
  const size = statSync(path).size;
  if (size > MAX_INDEX_BYTES) throw new Error(`the index ${path} is larger than ${MAX_INDEX_BYTES} bytes`);
  return new LocalIndex(parseIndex(readFileSync(path, "utf8")));
}
