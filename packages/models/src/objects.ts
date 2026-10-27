/**
 * The objects of the batteries: small finite structures of the discrete domain. Each is plain JSON,
 * so that it can be recorded in a node, handed to a sandboxed program, and rendered in Lean.
 */

/** A set of `size` elements 0..size-1 with a binary operation. */
export interface Magma {
  readonly size: number;
  /** Row-major: `table[a * size + b]` is the product of a and b. */
  readonly table: readonly number[];
}

export interface MagmaObject extends Magma {
  kind: "magma";
  /** Names the object inside its battery: `<size>:<table>`. */
  id: string;
  /** A name for a structure that has one (`C6`, `D4`), in the groups. */
  name?: string;
  /** Set for a group: the identity, and the inverse of each element. */
  identity?: number;
  inverse?: number[];
}

/** A simple graph on the vertices 0..n-1. */
export interface GraphObject {
  kind: "graph";
  /** The graph6 string of the graph, which is also its name. */
  id: string;
  n: number;
  /** Each edge as `[u, v]` with `u < v`, in increasing order. */
  edges: Array<[number, number]>;
  graph6: string;
}

export interface IntegerObject {
  kind: "integer";
  /** The value as text. */
  id: string;
  value: number;
}

export type BatteryObject = MagmaObject | GraphObject | IntegerObject;

/** The id of a magma: its size and its table. */
export function magmaId(size: number, table: readonly number[]): string {
  return `${size}:${table.join(size > 10 ? "," : "")}`;
}

export function magmaObject(size: number, table: readonly number[], extra: Partial<Pick<MagmaObject, "name" | "identity" | "inverse">> = {}): MagmaObject {
  if (table.length !== size * size) throw new Error(`a magma of size ${size} has ${size * size} table entries, got ${table.length}`);
  for (const value of table) {
    if (!Number.isInteger(value) || value < 0 || value >= size) throw new Error(`the table of a magma of size ${size} has the entry ${value}`);
  }
  return { kind: "magma", id: magmaId(size, table), size, table: [...table], ...extra };
}
