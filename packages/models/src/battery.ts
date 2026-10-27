import { type Json, sha256Hex } from "@seshat/core";
import { smallGroups } from "./groups.ts";
import { graphsUpToIso, isConnected } from "./graphs.ts";
import { allMagmas, MAX_ENUMERATED_SIZE, sampleMagmas } from "./magma.ts";
import type { BatteryObject, GraphObject, IntegerObject, MagmaObject } from "./objects.ts";

export type BatteryFamily = "magmas" | "groups" | "graphs" | "integers";

/** The most objects a battery holds: a fingerprint has one verdict for each, and goes into the journal. */
export const MAX_BATTERY_OBJECTS = 20_000;

/**
 * A fixed list of small objects of one domain, with the code that made it. Two batteries with the
 * same `id` and `digest` hold the same objects in the same order, so the fingerprints computed on
 * them can be compared position by position.
 */
export interface Battery<T extends BatteryObject = BatteryObject> {
  /** Names what it holds and how it was made, such as `magmas:3+4x120@1`. */
  readonly id: string;
  readonly family: BatteryFamily;
  /** The hash of the objects' ids in order. */
  readonly digest: string;
  readonly objects: readonly T[];
  /** The generator and its parameters: enough to make the battery again. */
  readonly generator: { readonly name: string; readonly params: { readonly [key: string]: Json } };
}

export function makeBattery<T extends BatteryObject>(input: {
  id: string;
  family: BatteryFamily;
  objects: readonly T[];
  generator: Battery["generator"];
}): Battery<T> {
  if (input.objects.length === 0) throw new RangeError(`the battery ${input.id} has no object`);
  if (input.objects.length > MAX_BATTERY_OBJECTS) {
    throw new RangeError(`the battery ${input.id} has ${input.objects.length} objects; a battery holds at most ${MAX_BATTERY_OBJECTS}`);
  }
  return { ...input, digest: sha256Hex(input.objects.map((o) => o.id).join("\n")) };
}

export interface MagmaBatteryOptions {
  /** Every magma up to isomorphism with at most this many elements, from 0 to 3. Default 3. */
  exhaustive?: number;
  /** The size of the sampled magmas. Default 4. */
  sampleSize?: number;
  /** How many magmas to sample at that size; 0 for none. Default 120. */
  samples?: number;
  /** The seed of the sampling. Default 1. */
  seed?: number;
}

/**
 * The finite magmas: all of those with up to `exhaustive` elements, one for each isomorphism class
 * (1, 10 and 3 330 magmas of size 1, 2 and 3), then `samples` magmas of size `sampleSize`, drawn with
 * `seed` (size 4 has 178 981 952 classes, too many to list).
 */
export function magmaBattery(options: MagmaBatteryOptions = {}): Battery<MagmaObject> {
  const exhaustive = options.exhaustive ?? MAX_ENUMERATED_SIZE;
  const sampleSize = options.sampleSize ?? 4;
  const samples = options.samples ?? 120;
  const seed = options.seed ?? 1;
  if (!Number.isInteger(exhaustive) || exhaustive < 0 || exhaustive > MAX_ENUMERATED_SIZE) {
    throw new RangeError(`magmaBattery lists the magmas of size 0 to ${MAX_ENUMERATED_SIZE}, not ${exhaustive}`);
  }
  if (samples > 0 && sampleSize <= exhaustive) throw new RangeError(`the sampled size ${sampleSize} must be above the listed sizes (up to ${exhaustive})`);
  const objects: MagmaObject[] = [];
  for (let size = 1; size <= exhaustive; size++) objects.push(...allMagmas(size));
  if (samples > 0) objects.push(...sampleMagmas(sampleSize, samples, seed));
  const id = `magmas:${exhaustive}${samples > 0 ? `+${sampleSize}x${samples}@${seed}` : ""}`;
  return makeBattery({
    id,
    family: "magmas",
    objects,
    generator: { name: "magmas", params: { exhaustive, sampleSize, samples, seed } },
  });
}

/** The small groups that the code builds (`smallGroups`), as Cayley tables, with up to `maxOrder` elements. */
export function groupBattery(maxOrder = 12): Battery<MagmaObject> {
  if (!Number.isInteger(maxOrder) || maxOrder < 1 || maxOrder > 120) throw new RangeError(`groupBattery takes an order from 1 to 120, not ${maxOrder}`);
  return makeBattery({
    id: `groups:${maxOrder}`,
    family: "groups",
    objects: smallGroups(maxOrder),
    generator: { name: "groups", params: { maxOrder } },
  });
}

/** The graphs on 1 to `maxVertices` vertices (at most 8), one for each isomorphism class; only the connected ones if asked. */
export function graphBattery(maxVertices = 6, options: { connected?: boolean } = {}): Battery<GraphObject> {
  const connected = options.connected ?? false;
  const objects: GraphObject[] = [];
  for (let n = 1; n <= maxVertices; n++) objects.push(...graphsUpToIso(n).filter((g) => !connected || isConnected(g)));
  return makeBattery({
    id: `graphs:${connected ? "connected:" : ""}${maxVertices}`,
    family: "graphs",
    objects,
    generator: { name: "graphs", params: { maxVertices, connected } },
  });
}

/** The integers from `min` to `max`. */
export function integerBattery(max: number, options: { min?: number } = {}): Battery<IntegerObject> {
  const min = options.min ?? 0;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError(`integerBattery takes min <= max, got ${min} and ${max}`);
  const objects: IntegerObject[] = [];
  for (let value = min; value <= max; value++) objects.push({ kind: "integer", id: String(value), value });
  return makeBattery({
    id: `integers:${min}..${max}`,
    family: "integers",
    objects,
    generator: { name: "integers", params: { min, max } },
  });
}
