import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: object keys sorted, no whitespace. Two equal values always give the same
 * string, so hashes over it are stable across runs and machines.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: unsupported object at ${path}`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/**
 * Applies a JSON merge patch (RFC 7386) and returns the result, changing neither argument: an object
 * patch sets its keys, recursively, and removes those it sets to null; any other patch replaces the
 * target.
 */
export function mergePatch(target: Json | undefined, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const isObject = target !== null && typeof target === "object" && !Array.isArray(target);
  const merged = new Map<string, Json>(isObject ? Object.entries(target) : []);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) merged.delete(key);
    else merged.set(key, mergePatch(merged.get(key), value));
  }
  // fromEntries defines keys as data properties, so a key such as "__proto__" stays a plain key.
  return Object.fromEntries(merged);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
