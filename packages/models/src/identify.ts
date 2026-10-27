import type { Edge, MemoryNode, MemoryStore } from "@seshat/memory";
import type { Json } from "@seshat/core";
import { knownSequences, type KnownSequence } from "./known-sequences.ts";

/** A term as it may be given: an integer, or its decimal text. */
export type SequenceTerm = number | bigint | string;

/** The terms as exact integers; anything that is not an integer is refused. */
export function toTerms(values: readonly SequenceTerm[]): bigint[] {
  return values.map((value, i) => {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new TypeError(`term ${i} is ${value}, not a safe integer: pass a bigint or its text`);
      return BigInt(value);
    }
    if (!/^\s*-?\d+\s*$/.test(value)) throw new TypeError(`term ${i} is ${JSON.stringify(value)}, not an integer`);
    return BigInt(value.trim());
  });
}

export interface SequenceMatch {
  /** `A000045`. */
  id: string;
  name: string;
  /** Where the match came from. */
  source: "local" | "oeis";
  /** The index of the sequence's first term. */
  offset: number;
  /** The index in the sequence of the query's first term; null when the query falls beyond the terms a service shows. */
  start: number | null;
  /** The terms that follow the query in the sequence (at most 5), a prediction to check. */
  next: bigint[];
  /** True when the query starts at the sequence's first term. */
  prefix: boolean;
}

export type Strength = "strong" | "weak" | "none";

export interface Identification {
  query: bigint[];
  matches: SequenceMatch[];
  /**
   * `strong` when the query is long and varied enough that a match is unlikely to be chance (six or more
   * terms with four different values, or ten terms with three), `weak` for a shorter or flatter query,
   * `none` when nothing matches or the query is too short to try.
   */
  strength: Strength;
  note?: string;
}

export interface IdentifyOptions {
  /** The fewest terms a query may have. Default 4. */
  minTerms?: number;
  /** The most matches returned. Default 8. */
  maxMatches?: number;
  /** The sequences to look in. Default: the table shipped with the package. */
  table?: readonly KnownSequence[];
}

/** How much a match of these terms says: see `Identification.strength`. */
export function strengthOf(query: readonly bigint[]): Strength {
  const distinct = new Set(query).size;
  return (query.length >= 6 && distinct >= 4) || (query.length >= 10 && distinct >= 3) ? "strong" : "weak";
}

/**
 * The known sequences that contain the terms, as consecutive terms starting anywhere: a query of the
 * numbers n >= 1 for which a statement holds may start at the middle of a sequence, and a sequence
 * may be indexed from 0 or from 1. A sequence whose start matches comes first. A match is a
 * candidate, and says nothing of the terms that were not asked.
 */
export function identifySequence(values: readonly SequenceTerm[], options: IdentifyOptions = {}): Identification {
  const query = toTerms(values);
  const minTerms = options.minTerms ?? 4;
  const maxMatches = options.maxMatches ?? 8;
  if (!Number.isInteger(minTerms) || minTerms < 1) throw new RangeError(`minTerms is a positive integer, not ${minTerms}`);
  if (!Number.isInteger(maxMatches) || maxMatches < 1) throw new RangeError(`maxMatches is a positive integer, not ${maxMatches}`);
  if (query.length < minTerms) return { query, matches: [], strength: "none", note: `${query.length} terms is too few to identify a sequence: at least ${minTerms}` };
  const matches: SequenceMatch[] = [];
  for (const sequence of options.table ?? knownSequences()) {
    const at = find(sequence.terms, query);
    if (at < 0) continue;
    matches.push({
      id: sequence.id,
      name: sequence.name,
      source: "local",
      offset: sequence.offset,
      start: sequence.offset + at,
      next: sequence.terms.slice(at + query.length, at + query.length + 5),
      prefix: at === 0,
    });
  }
  // Stable: among equals, the order of the table, which puts the basic sequences first.
  matches.sort((a, b) => Number(!a.prefix) - Number(!b.prefix));
  const kept = matches.slice(0, maxMatches);
  if (kept.length === 0) return { query, matches: [], strength: "none", note: "no sequence of the table has these terms" };
  return { query, matches: kept, strength: strengthOf(query) };
}

function find(haystack: readonly bigint[], needle: readonly bigint[]): number {
  outer: for (let at = 0; at + needle.length <= haystack.length; at++) {
    for (let k = 0; k < needle.length; k++) if (haystack[at + k] !== needle[k]) continue outer;
    return at;
  }
  return -1;
}

/** One way to read a table as a sequence, and what it matched. */
export interface TableReading {
  reading: string;
  terms: bigint[];
  identification: Identification;
}

/**
 * Reads a table (rows of numbers, of any lengths) as sequences the way the OEIS does, and looks each
 * up: by rows, by columns, by antidiagonals (a rectangular table, in both directions), and its row
 * sums, first column, last column and main diagonal. Only the readings that match are returned.
 */
export function identifyTable(rows: ReadonlyArray<readonly SequenceTerm[]>, options: IdentifyOptions = {}): TableReading[] {
  const table = rows.map((row) => toTerms(row));
  const readings = new Map<string, bigint[]>();
  readings.set("by rows", table.flat());
  const width = Math.max(0, ...table.map((r) => r.length));
  readings.set("by columns", Array.from({ length: width }, (_, j) => table.flatMap((r) => (j < r.length ? [r[j] as bigint] : []))).flat());
  readings.set("row sums", table.map((r) => r.reduce((s, v) => s + v, 0n)));
  readings.set("first column", table.flatMap((r) => (r.length > 0 ? [r[0] as bigint] : [])));
  readings.set("last column", table.flatMap((r) => (r.length > 0 ? [r[r.length - 1] as bigint] : [])));
  readings.set("main diagonal", table.flatMap((r, i) => (i < r.length ? [r[i] as bigint] : [])));
  if (table.length > 1 && table.every((r) => r.length === width)) {
    const size = Math.min(table.length, width);
    const down: bigint[] = [];
    const up: bigint[] = [];
    for (let d = 0; d < size; d++) {
      for (let i = 0; i <= d; i++) {
        down.push((table[i] as bigint[])[d - i] as bigint);
        up.push((table[d - i] as bigint[])[i] as bigint);
      }
    }
    readings.set("antidiagonals, from the first row", down);
    readings.set("antidiagonals, from the first column", up);
  }
  const found: TableReading[] = [];
  for (const [reading, terms] of readings) {
    const identification = identifySequence(terms, options);
    if (identification.matches.length > 0) found.push({ reading, terms, identification });
  }
  return found;
}

// --- Recording ---------------------------------------------------------------------------------

/** The data of a node of kind `identification`. */
export type IdentificationData = {
  /** What was identified, in words: `the numbers n < 40 where the statement holds`. */
  subject: string;
  /** The terms asked, as text. */
  query: string[];
  /** For a table, how it was read. */
  reading?: string;
  strength: Strength;
  matches: Array<{ id: string; name: string; source: string; offset: number; start: number | null; next: string[]; prefix: boolean }>;
  note?: string;
};

/**
 * Records an identification as a node about the claim, with a `cites` edge from the claim. It is a
 * lookup: the match names a sequence the terms agree with, and proves nothing about the claim.
 */
export function recordIdentification(
  memory: MemoryStore,
  input: { claimId: string; subject: string; identification: Identification; reading?: string },
): { node: MemoryNode; edge: Edge } {
  const { identification } = input;
  const data: IdentificationData = {
    subject: input.subject,
    query: identification.query.map(String),
    ...(input.reading !== undefined ? { reading: input.reading } : {}),
    strength: identification.strength,
    matches: identification.matches.map((m) => ({ id: m.id, name: m.name, source: m.source, offset: m.offset, start: m.start, next: m.next.map(String), prefix: m.prefix })),
    ...(identification.note !== undefined ? { note: identification.note } : {}),
  };
  const node = memory.recordNode({ kind: "identification", claimId: input.claimId, data: data as unknown as Json });
  const best = identification.matches[0];
  const edge = memory.addEdge({
    kind: "cites",
    from: input.claimId,
    to: node.nodeId,
    status: "computed",
    note: `${input.subject}: ${best !== undefined ? `${best.id} (${best.name}), ${identification.strength} match` : "no match"}`,
  });
  return { node, edge };
}
