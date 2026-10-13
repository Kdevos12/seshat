import type { Json } from "@math-harness/core";

const SEGMENT = /^(?:\*|[0-9]+|[A-Za-z_$][A-Za-z0-9_$-]*)$/;

/** Problems with a path's syntax, empty when it is usable. */
export function checkPath(path: string): string[] {
  if (path === "") return [];
  return path.split(".").flatMap((segment) => (SEGMENT.test(segment) ? [] : [`bad path segment ${JSON.stringify(segment)} in ${JSON.stringify(path)}`]));
}

/**
 * The value at a dotted path, such as `results.0.status`; `""` is the value itself. A number
 * indexes an array, and `*` maps the rest of the path over every item of an array (or value of an
 * object) and gives the list of what was found. Undefined when nothing is there.
 */
export function getPath(value: Json | undefined, path: string): Json | undefined {
  return walk(value, path === "" ? [] : path.split("."));
}

function walk(value: Json | undefined, segments: readonly string[]): Json | undefined {
  if (value === undefined) return undefined;
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (head === "*") {
    const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value) : undefined;
    if (items === undefined) return undefined;
    return items.map((item) => walk(item, rest)).filter((item): item is Json => item !== undefined);
  }
  if (Array.isArray(value)) {
    if (!/^[0-9]+$/.test(head)) return undefined;
    return walk(value[Number(head)], rest);
  }
  if (value !== null && typeof value === "object") {
    return Object.hasOwn(value, head) ? walk(value[head], rest) : undefined;
  }
  return undefined;
}
