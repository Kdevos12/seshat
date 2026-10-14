import { randomBytes } from "node:crypto";
import { sha256Hex } from "./canonical-json.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Time-sortable unique id (ULID layout: 48-bit milliseconds, then 80 random bits), with a short
 * type prefix such as `run`, `att` or `tr` so that ids are readable in logs.
 */
export function newId(prefix: string, now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!/^[a-z][a-z0-9]{0,7}$/.test(prefix)) throw new Error(`newId: bad prefix ${JSON.stringify(prefix)}`);
  if (random.length !== 10) throw new Error("newId: need 10 random bytes");
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  let bits = 0;
  let acc = 0;
  for (const byte of random) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >> bits) & 31];
    }
  }
  return `${prefix}_${time}${rand}`;
}

/**
 * Removes Lean comments (`-- ...` and nested `/- ... -/`, doc comments included) while leaving
 * string literals intact.
 */
export function stripLeanComments(source: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (depth > 0) {
      if (c === "/" && next === "-") {
        depth++;
        i += 2;
      } else if (c === "-" && next === "/") {
        depth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "/" && next === "-") {
      depth = 1;
      i += 2;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      i++;
      out += source.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Version 0 of the statement id: a hash of the statement text without comments and with
 * whitespace collapsed. Given the `header` the statement is read under (its imports, `open`s and
 * definitions), the header, normalized the same way, is hashed with it: the same text under another
 * header is another statement, so statements that differ never share an id. A header with nothing
 * in it, empty or only comments and spaces, is no header, and a statement with no header has the
 * hash of its text alone. It only catches textual duplicates; P0b replaces it with a hash of the
 * elaborated, normalized Lean expression (prefix `st1_`). Different versions never compare equal.
 */
export function statementIdV0(statement: string, header?: string): string {
  const text = collapseWhitespace(stripLeanComments(statement));
  const context = header === undefined ? "" : collapseWhitespace(stripLeanComments(header));
  return `st0_${sha256Hex(context === "" ? text : `${context}\u0000${text}`).slice(0, 32)}`;
}
