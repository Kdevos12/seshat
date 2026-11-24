/**
 * The pure helpers of the settings panel (UX9): a key in words, and the typed fields of a JSON setting whose type is a flat object.
 * No Preact here, so the tests import it as it is.
 */

/** A key in words (UX9): `thinkingLevel` is "Thinking level", `capUsd` "Cap USD". The key itself stays beside it, small. */
export function labelOf(key: string): string {
  const parts = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").map((w) => w.toLowerCase());
  const words = parts.map((w) => (w === "usd" ? "USD" : w === "llm" ? "LLM" : w === "lsp" ? "LSP" : w === "sec" ? "(seconds)" : w));
  const first = words[0] ?? key;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/** One field of a JSON setting whose type is a flat object, such as `{ maxWaitMinutes?: number > 0 }`. */
export interface SubField {
  name: string;
  optional: boolean;
  kind: "integer" | "number" | "boolean" | "choice" | "text";
  choices?: string[];
  type: string;
}

/**
 * The fields of a flat object type, or undefined when the type nests (`{ limit: { ... } }`, `Record<...>`) or names a field without its type
 * (`{ share?, floor? }`): such a setting keeps its JSON box.
 */
export function flatFields(type: string): SubField[] | undefined {
  const m = /^\{\s*(.*?)\s*\}$/.exec(type.trim());
  // A brace nests; a generic such as `Record<kind, number>` names no flat field. A bound (`>= 1`, `> 0`) is fine.
  if (m === null || /[{}]|\w\s*</.test(m[1] ?? "")) return undefined;
  const out: SubField[] = [];
  for (const part of (m[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "")) {
    const f = /^(\w+)(\?)?:\s*(.+)$/.exec(part);
    if (f === null) return undefined;
    const [, name, optional, t] = f as unknown as [string, string, string | undefined, string];
    const kind = /^integer\b/.test(t) ? "integer" : /^number\b/.test(t) ? "number" : /^boolean$/.test(t) ? "boolean" : /^\w+(\s*\|\s*\w+)+$/.test(t) ? "choice" : "text";
    out.push({ name, optional: optional === "?", kind, ...(kind === "choice" ? { choices: t.split("|").map((x) => x.trim()) } : {}), type: t });
  }
  return out.length > 0 ? out : undefined;
}

/** The JSON text a set of sub-fields makes: the filled ones only, typed; empty when none is filled. */
export function subJson(fields: readonly SubField[], values: Readonly<Record<string, string>>): string {
  const object: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (values[f.name] ?? "").trim();
    if (v === "") continue;
    object[f.name] = f.kind === "integer" || f.kind === "number" ? (Number.isFinite(Number(v)) ? Number(v) : v) : f.kind === "boolean" ? v === "true" : v;
  }
  return Object.keys(object).length === 0 ? "" : JSON.stringify(object);
}

/** The sub-field values a JSON text holds, or undefined when it is not a flat object (the JSON box then stays the only editor). */
export function subValues(text: string): Record<string, string> | undefined {
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  } catch {
    return undefined;
  }
}

/** The kind of a line option's field: its default's type (`json` for a `null`, a list or an object default). */
export type LineOptionKind = "boolean" | "number" | "text" | "json";

/** The options a `lineOptions` JSON text sets, line by line, each value as the text its field shows; undefined when the text is not an object of objects. */
export function lineOptionValues(text: string): Record<string, Record<string, string>> | undefined {
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [line, options] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
      out[line] = Object.fromEntries(Object.entries(options as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The `lineOptions` JSON text with one option of one line set to what its field holds, or removed when the field is empty: a line left with no
 * option is dropped, and no option at all is the empty text. A number or JSON field that does not parse is kept as its text, which the server refuses.
 */
export function setLineOption(text: string, line: string, name: string, kind: LineOptionKind, value: string): string {
  let typed: Record<string, Record<string, unknown>> = {};
  if (lineOptionValues(text) !== undefined && text.trim() !== "") typed = JSON.parse(text) as Record<string, Record<string, unknown>>;
  const v = value.trim();
  const read = (): unknown => {
    if (kind === "boolean") return v === "true";
    if (kind === "number") return Number.isFinite(Number(v)) ? Number(v) : v;
    if (kind === "text") return v;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  };
  const here = { ...(typed[line] ?? {}) };
  if (v === "") delete here[name];
  else here[name] = read();
  if (Object.keys(here).length === 0) delete typed[line];
  else typed[line] = here;
  return Object.keys(typed).length === 0 ? "" : JSON.stringify(typed);
}
