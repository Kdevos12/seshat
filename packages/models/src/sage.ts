import type { Registry } from "@seshat/registry";
import { type Battery, makeBattery } from "./battery.ts";
import { GROUPS_OF_ORDER, groupObject } from "./groups.ts";
import { fromGraph6 } from "./graphs.ts";
import type { GraphObject, MagmaObject } from "./objects.ts";

/**
 * Runs SageMath code in one session and gives back the text of its last expression, as Sage prints
 * it. `sageThroughRegistry` makes one from the capability `compute.sage`; a test gives a stand-in.
 */
export type SageRun = (code: string, options?: { timeoutSec?: number; signal?: AbortSignal }) => Promise<string>;

/** A `SageRun` over the registry's `compute.sage`, in a session of its own (`scope`): every call is a tool run. */
export function sageThroughRegistry(registry: Registry, options: { scope: string; actor?: string; attemptId?: string }): SageRun {
  return async (code, run = {}) => {
    const { output } = await registry.invoke(
      "compute.sage",
      { code, ...(run.timeoutSec !== undefined ? { timeout: run.timeoutSec } : {}) },
      {
        scope: options.scope,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
        ...(run.signal !== undefined ? { signal: run.signal } : {}),
      },
    );
    const result = (output as { result?: string | null }).result;
    if (typeof result !== "string") throw new Error("SageMath returned no value for the code");
    return result;
  };
}

/** The strings of a Python list of string literals, such as `['A?', 'A_']`. */
export function parsePythonStrings(text: string): string[] {
  const source = text.trim();
  if (!source.startsWith("[") || !source.endsWith("]")) throw new SyntaxError(`not a list of strings (the output may have been cut): ${source.slice(0, 60)}`);
  const out: string[] = [];
  let i = 1;
  while (i < source.length - 1) {
    const c = source.charAt(i);
    if (c === "," || /\s/.test(c)) {
      i++;
      continue;
    }
    if (c !== "'" && c !== '"') throw new SyntaxError(`expected a string literal at ${i}, found ${c}`);
    let value = "";
    i++;
    for (; ; i++) {
      if (i >= source.length) throw new SyntaxError("a string literal is not closed");
      const d = source.charAt(i);
      if (d === c) break;
      if (d === "\\") {
        i++;
        const e = source.charAt(i);
        value += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else {
        value += d;
      }
    }
    i++;
    out.push(value);
  }
  return out;
}

/** The graphs per call: a long answer may be cut by the server's limit on the text it returns. */
const GRAPHS_PER_CALL = 1000;

export interface SageGraphSpec {
  vertices: number;
  /** Flags of `geng`, such as `-c` (connected) or `-t` (triangle-free). */
  flags?: string;
  /** The edge range of `geng` (`mine:maxe`): fewer graphs are enumerated. `max` null: no upper bound. */
  edges?: { min: number; max: number | null };
}

/**
 * The graphs that nauty's `geng` makes, through SageMath's `graphs.nauty_geng`, as a battery. Not run
 * against a real SageMath in the tests.
 *
 * Without `maxObjects` the list is read in slices of 1000, each slice a new enumeration from the start
 * (the cost grows with the list: a caller that does not know the size should give `maxObjects`).
 * With `maxObjects` the generator is stopped after `maxObjects + 1` graphs (`itertools.islice`) and
 * read in one call: "too many" is known after one partial enumeration, and the answer is at most
 * `maxObjects + 1` graph6 strings (about 200 kB for 20 001 graphs on 10 vertices; if the server cuts it
 * the answer does not parse and the call fails). `timeoutSec` is given to every call.
 */
export async function sageGraphBattery(run: SageRun, spec: SageGraphSpec, signal?: AbortSignal, options: { maxObjects?: number; timeoutSec?: number } = {}): Promise<Battery<GraphObject>> {
  if (!Number.isInteger(spec.vertices) || spec.vertices < 1 || spec.vertices > 20) throw new RangeError(`geng takes 1 to 20 vertices, not ${spec.vertices}`);
  const flags = spec.flags?.trim() ?? "";
  if (!/^[-\w :]*$/.test(flags)) throw new RangeError(`the geng flags ${JSON.stringify(flags)} have characters that are not flags`);
  const range = spec.edges === undefined ? "" : `${spec.edges.min}:${spec.edges.max ?? ""}`;
  if (spec.edges !== undefined && (!Number.isInteger(spec.edges.min) || spec.edges.min < 0 || (spec.edges.max !== null && !Number.isInteger(spec.edges.max)))) throw new RangeError("the edge range of geng is two integers");
  const arguments_ = `${spec.vertices}${flags === "" ? "" : ` ${flags}`}${range === "" ? "" : ` ${range}`}`;
  const call = (code: string) => run(code, { ...(signal !== undefined ? { signal } : {}), ...(options.timeoutSec !== undefined ? { timeoutSec: options.timeoutSec } : {}) });
  const objects: GraphObject[] = [];
  if (options.maxObjects !== undefined) {
    const text = await call(`from itertools import islice\n[g.graph6_string() for g in islice(graphs.nauty_geng("${arguments_}"), ${options.maxObjects + 1})]`);
    const strings = parsePythonStrings(text);
    if (strings.length > options.maxObjects) throw new RangeError(`geng ${arguments_} gives more than ${options.maxObjects} graphs`);
    objects.push(...strings.map(fromGraph6));
  } else {
    for (let from = 0; ; from += GRAPHS_PER_CALL) {
      const text = await call(`[g.graph6_string() for g in graphs.nauty_geng("${arguments_}")][${from}:${from + GRAPHS_PER_CALL}]`);
      const slice = parsePythonStrings(text).map(fromGraph6);
      objects.push(...slice);
      if (slice.length < GRAPHS_PER_CALL) break;
    }
  }
  return makeBattery({
    id: `graphs:geng:${arguments_}`,
    family: "graphs",
    objects,
    generator: { name: "sage-geng", params: { vertices: spec.vertices, flags, ...(spec.edges !== undefined ? { edges: [spec.edges.min, spec.edges.max] } : {}) } },
  });
}

/**
 * The groups of the SmallGroups library of the given orders (up to 32), through SageMath's
 * `SmallPermutationGroup(n, k)`, as Cayley tables. Each table is checked to be a group. Not run
 * against a real SageMath in the tests.
 */
export async function sageGroupBattery(run: SageRun, orders: readonly number[], signal?: AbortSignal): Promise<Battery<MagmaObject>> {
  const objects: MagmaObject[] = [];
  for (const order of orders) {
    const count = GROUPS_OF_ORDER[order - 1];
    if (!Number.isInteger(order) || count === undefined) throw new RangeError(`the library is read for orders 1 to ${GROUPS_OF_ORDER.length}, not ${order}`);
    for (let k = 1; k <= count; k++) {
      const text = await run(
        `grp = SmallPermutationGroup(${order}, ${k})\nels = list(grp)\n[[els.index(ea * eb) for eb in els] for ea in els]`,
        signal !== undefined ? { signal } : {},
      );
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows) || rows.length !== order || !rows.every((row) => Array.isArray(row) && row.length === order)) {
        throw new SyntaxError(`SmallPermutationGroup(${order}, ${k}): expected a ${order} x ${order} table, got ${text.slice(0, 60)}`);
      }
      objects.push(groupObject(`SmallGroup(${order},${k})`, order, (rows as number[][]).flat()));
    }
  }
  return makeBattery({
    id: `groups:sage:${orders.join(",")}`,
    family: "groups",
    objects,
    generator: { name: "sage-small-groups", params: { orders: [...orders] } },
  });
}
