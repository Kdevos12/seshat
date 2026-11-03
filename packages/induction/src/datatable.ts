import { hashJson, type Json } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import type { SageRun } from "@seshat/models";
import { type ProgramLimits, runValues } from "./sandbox.ts";
import type { NumericColumn } from "./dalmatian.ts";

/**
 * A data table (plan §2, `datatable` nodes): one row for each of a list of small objects (the numbers from 0,
 * the graphs on up to 6 vertices, the groups of a small order), one column for each invariant, and the code
 * that produced every column. The code is JavaScript run in the sandbox (`runValues`), or Sage code run through
 * the capability `compute.sage`. A table is data: what is computed from it (an identification, a bound, a
 * recurrence) is a conjecture, and the table changes no claim's status.
 */

/** The node kind of a recorded table. */
export const DATATABLE_KIND = "datatable";

export interface ColumnSpec {
  /** A short name: letters, digits and `_`. */
  name: string;
  /** JavaScript: one function expression of an object, whose value is JSON (a number, a boolean, a string...). */
  program?: string;
  /** Sage: an expression in `o`, the Sage object of the row (the table's `sageObject` applied to its id), whose value is JSON-printable. */
  sage?: string;
  description?: string;
  /** The invariant as a term in Lean, when it has one: used to state a conjecture about the column. */
  lean?: string;
}

export interface TableColumn extends Omit<ColumnSpec, "program" | "sage"> {
  /** How the column was made. */
  producedBy: "sandbox" | "sage" | "given";
  /** The code that produced it (JavaScript or Sage), as it was run. */
  code?: string;
  /** For a column that could not be computed on some rows: how many rows have no value. */
  missing: number;
}

export interface DataTable {
  /** The hash of the objects and the columns' code: the same table has the same id. */
  id: string;
  /** What the objects are: `integers`, `graphs`, `magmas`, `groups`. */
  family: string;
  objectIds: string[];
  /** The objects as the programs received them. */
  objects: Json[];
  columns: TableColumn[];
  /** `rows[i][c]`: the value of column c at object i, or null. */
  rows: Array<Array<Json | null>>;
  /** What went wrong, in words: a program that did not compile, a column that timed out. */
  notes: string[];
}

export interface BuildTableOptions {
  family: string;
  objects: readonly Json[];
  objectIds: readonly string[];
  columns: readonly ColumnSpec[];
  /** Runs Sage code for the columns that have `sage`; without it such a column is left empty, with a note. */
  sage?: SageRun;
  /** Sage: an expression that turns an id into the Sage object, with `i` bound to the id (a graph6 string: `Graph(i)`). */
  sageObject?: string;
  limits?: Partial<ProgramLimits>;
  signal?: AbortSignal;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Builds a table: every column's program is run on every object, in the sandbox or in Sage. */
export async function buildTable(options: BuildTableOptions): Promise<DataTable> {
  if (options.objects.length !== options.objectIds.length) throw new RangeError("the table needs one id for each object");
  const names = new Set<string>();
  for (const c of options.columns) {
    if (!NAME.test(c.name)) throw new RangeError(`the column name ${JSON.stringify(c.name)} is not a short name of letters, digits and _`);
    if (names.has(c.name)) throw new RangeError(`the column ${c.name} is given twice`);
    names.add(c.name);
    if ((c.program === undefined) === (c.sage === undefined)) throw new RangeError(`the column ${c.name} needs a program or Sage code, one of the two`);
  }
  const columns: TableColumn[] = [];
  const data: Array<Array<Json | undefined>> = [];
  const notes: string[] = [];
  for (const spec of options.columns) {
    const { program, sage, ...rest } = spec;
    let column: Array<Json | undefined>;
    let producedBy: TableColumn["producedBy"];
    let code: string;
    if (program !== undefined) {
      const run = await runValues(program, options.objects, options.limits, options.signal);
      column = run.values;
      producedBy = "sandbox";
      code = program;
      if (run.stopped !== undefined) notes.push(`column ${spec.name}: the run stopped: ${run.stopped}`);
      else {
        const first = run.notes.find((n) => n !== undefined);
        if (first !== undefined) notes.push(`column ${spec.name}: no value on ${run.notes.filter((n) => n !== undefined).length} object(s), the first because: ${first}`);
      }
    } else {
      producedBy = "sage";
      code = sage as string;
      column = options.objects.map(() => undefined);
      if (options.sage === undefined) notes.push(`column ${spec.name}: no SageMath was available`);
      else if (options.sageObject === undefined) notes.push(`column ${spec.name}: the table has no sageObject to build Sage objects with`);
      else {
        try {
          const ids = JSON.stringify(options.objectIds);
          const out = await options.sage(`import json\njson.dumps([(lambda o: (${code}))(${options.sageObject}) for i in ${ids}])`, options.signal !== undefined ? { signal: options.signal } : {});
          // Sage prints the JSON text as a Python string, in single quotes.
          const text = out.trim().replace(/^'([\s\S]*)'$/, "$1");
          const parsed = JSON.parse(text) as unknown;
          if (!Array.isArray(parsed) || parsed.length !== options.objects.length) throw new SyntaxError(`expected ${options.objects.length} values, got ${Array.isArray(parsed) ? parsed.length : "none"}`);
          column = parsed as Json[];
        } catch (error) {
          if (options.signal?.aborted === true) throw error;
          notes.push(`column ${spec.name}: Sage failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    columns.push({ ...rest, producedBy, code, missing: column.filter((v) => v === undefined || v === null).length });
    data.push(column);
  }
  const rows = options.objects.map((_, i) => data.map((column) => column[i] ?? null));
  const id = hashJson({ family: options.family, ids: options.objectIds, columns: columns.map((c) => [c.name, c.producedBy, c.code ?? null]) } as unknown as Json);
  return { id: id.slice(0, 16), family: options.family, objectIds: [...options.objectIds], objects: [...options.objects], columns, rows, notes };
}

/** The numeric columns of a table (every value a finite number or null), for the conjecturing of `dalmatian`. */
export function numericColumns(table: DataTable): NumericColumn[] {
  const out: NumericColumn[] = [];
  table.columns.forEach((column, c) => {
    const values = table.rows.map((row) => row[c] ?? null);
    const numeric = values.every((v) => v === null || (typeof v === "number" && Number.isFinite(v))) && values.some((v) => v !== null);
    if (numeric) out.push({ name: column.name, values: values as Array<number | null> });
  });
  return out;
}

/** The values of one column. */
export function columnValues(table: DataTable, name: string): Array<Json | null> {
  const c = table.columns.findIndex((column) => column.name === name);
  if (c < 0) throw new RangeError(`the table has no column ${JSON.stringify(name)}`);
  return table.rows.map((row) => row[c] ?? null);
}

// --- Dependencies between invariants -----------------------------------------------------------

/** What holds between two numeric columns on every row where both have a value. */
export type DependencyKind =
  /** a = b on every row. */
  | "equal"
  /** a <= b on every row, and not equal. */
  | "at_most"
  /** Rows with the same a have the same b (b is a function of a), and not equal. */
  | "determines"
  /** b never decreases when a increases (a monotone relation), not a function and not an order. */
  | "monotone";

export interface Dependency {
  kind: DependencyKind;
  from: string;
  to: string;
  /** The rows both columns have a value on. */
  rows: number;
  /** For `determines`, the distinct values of a: a function of one value says nothing. */
  distinct?: number;
}

/**
 * The dependencies between the numeric invariants of a table: equal columns, one at most the other, one a
 * function of another, a monotone relation. They are facts about the table, a map of which invariants are
 * redundant and which bound which; the bounds and the functional laws are conjectures for the rest of the line.
 * A column that is constant, or has fewer than `minDistinct` values, is left out of `determines` and `monotone`:
 * every column is a function of a constant.
 */
export function invariantDependencies(table: DataTable, options: { minDistinct?: number } = {}): Dependency[] {
  const minDistinct = options.minDistinct ?? 3;
  const columns = numericColumns(table);
  const out: Dependency[] = [];
  for (const a of columns) {
    for (const b of columns) {
      if (a.name === b.name) continue;
      const pairs: Array<[number, number]> = [];
      a.values.forEach((x, i) => {
        const y = b.values[i];
        if (x !== null && y !== null && y !== undefined) pairs.push([x, y]);
      });
      if (pairs.length < 2) continue;
      const equal = pairs.every(([x, y]) => x === y);
      if (equal) {
        if (a.name < b.name) out.push({ kind: "equal", from: a.name, to: b.name, rows: pairs.length });
        continue;
      }
      if (pairs.every(([x, y]) => x <= y)) out.push({ kind: "at_most", from: a.name, to: b.name, rows: pairs.length });
      const byA = new Map<number, Set<number>>();
      for (const [x, y] of pairs) byA.set(x, (byA.get(x) ?? new Set()).add(y));
      if (byA.size < minDistinct) continue;
      if ([...byA.values()].every((ys) => ys.size === 1)) {
        out.push({ kind: "determines", from: a.name, to: b.name, rows: pairs.length, distinct: byA.size });
        continue;
      }
      // Monotone: the largest b below an a never exceeds the smallest b above it.
      const keys = [...byA.keys()].sort((p, q) => p - q);
      let monotone = true;
      let previousMax = -Infinity;
      for (const k of keys) {
        const ys = [...(byA.get(k) as Set<number>)];
        if (Math.min(...ys) < previousMax) {
          monotone = false;
          break;
        }
        previousMax = Math.max(...ys);
      }
      if (monotone) out.push({ kind: "monotone", from: a.name, to: b.name, rows: pairs.length, distinct: byA.size });
    }
  }
  return out;
}

// --- Records -----------------------------------------------------------------------------------

/** Tables with more values than this keep their rows in a blob and the node holds its hash. */
const INLINE_VALUES = 2000;

export interface DataTableRecord {
  tableId: string;
  family: string;
  objects: number;
  columns: TableColumn[];
  /** The objects' ids, inline for a small table. */
  objectIds?: string[];
  /** The rows, inline for a small table. */
  rows?: Array<Array<Json | null>>;
  /** For a large table: the hash of the blob that holds `{objectIds, objects, rows}`. */
  blob?: string;
  notes: string[];
  /** Whose table: the line that made it. */
  producedBy: string;
}

/** Records the table as a `datatable` node of the claim. Not recorded again when the claim already has this table. */
export function recordTable(memory: MemoryStore, claimId: string, table: DataTable, producedBy: string): { nodeId: string; created: boolean } {
  const known = memory.nodes(DATATABLE_KIND, { claimId }).find((n) => (n.data as { tableId?: string }).tableId === table.id);
  if (known !== undefined) return { nodeId: known.nodeId, created: false };
  const values = table.rows.length * Math.max(1, table.columns.length);
  const inline = values <= INLINE_VALUES;
  const blob = inline ? undefined : memory.blobs.putJson({ objectIds: table.objectIds, objects: table.objects, rows: table.rows } as unknown as Json);
  const data: DataTableRecord = {
    tableId: table.id,
    family: table.family,
    objects: table.objects.length,
    columns: table.columns,
    ...(inline ? { objectIds: table.objectIds, rows: table.rows } : { blob: blob as string }),
    notes: table.notes,
    producedBy,
  };
  const node = memory.recordNode({ kind: DATATABLE_KIND, claimId, data: data as unknown as Json });
  return { nodeId: node.nodeId, created: true };
}

/** The tables recorded for a claim, read back from the memory (and the blob store for a large one). */
export function readTables(memory: MemoryStore, claimId: string): Array<{ nodeId: string; table: DataTable }> {
  const out: Array<{ nodeId: string; table: DataTable }> = [];
  for (const node of memory.nodes(DATATABLE_KIND, { claimId })) {
    const d = node.data as unknown as DataTableRecord;
    let objectIds = d.objectIds;
    let rows = d.rows;
    let objects: Json[] = [];
    if (d.blob !== undefined) {
      const stored = memory.blobs.getJson(d.blob) as { objectIds: string[]; objects: Json[]; rows: Array<Array<Json | null>> } | undefined;
      if (stored === undefined) continue;
      objectIds = stored.objectIds;
      rows = stored.rows;
      objects = stored.objects;
    }
    if (objectIds === undefined || rows === undefined) continue;
    out.push({ nodeId: node.nodeId, table: { id: d.tableId, family: d.family, objectIds, objects, columns: d.columns, rows, notes: d.notes } });
  }
  return out;
}
