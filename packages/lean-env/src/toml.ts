import type { Json } from "@seshat/core";

/** A TOML file the subset below cannot read, with the line it stopped at. */
export class TomlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

/**
 * Reads the subset of TOML that environment files use: comments, `key = value` with bare or quoted
 * keys, `[table]` and `[[array of tables]]` headers (dotted names too), and the values string
 * (basic with escapes, or literal), integer, boolean, array (over several lines, trailing comma
 * allowed) and inline table. Multi-line strings, floats and dates are refused, not misread. The
 * repository has no TOML dependency because this is all the environment files need
 * (documentation/lean-env.md).
 */
export function parseToml(text: string): { [key: string]: Json } {
  return new Reader(text).document();
}

type Table = { [key: string]: Json };

class Reader {
  private readonly source: string;
  private pos = 0;
  private line = 1;

  constructor(source: string) {
    this.source = source.replace(/\r\n/g, "\n");
  }

  document(): Table {
    const root: Table = {};
    let current: Table = root;
    // Tables defined by a header, so that a second `[x]` is refused.
    const defined = new Set<string>();
    for (;;) {
      this.skipBlank();
      if (this.eof()) return root;
      if (this.peek() === "[") {
        const array = this.source[this.pos + 1] === "[";
        this.pos += array ? 2 : 1;
        const path = this.keyPath();
        this.skipSpaces();
        if (!this.take(array ? "]]" : "]")) throw this.error(`expected ${array ? "]]" : "]"} to end the table header`);
        this.endOfLine();
        current = this.open(root, path, array, defined);
      } else {
        const path = this.keyPath();
        this.skipSpaces();
        if (!this.take("=")) throw this.error("expected = after the key");
        this.skipSpaces();
        const value = this.value();
        this.endOfLine();
        this.assign(current, path, value);
      }
    }
  }

  private open(root: Table, path: string[], array: boolean, defined: Set<string>): Table {
    let table = root;
    path.forEach((part, i) => {
      const last = i === path.length - 1;
      const existing = Object.hasOwn(table, part) ? table[part] : undefined;
      if (last && array) {
        if (existing === undefined) {
          const list: Json[] = [];
          table[part] = list;
          const added: Table = {};
          list.push(added);
          table = added;
        } else if (Array.isArray(existing)) {
          const added: Table = {};
          existing.push(added);
          table = added;
        } else {
          throw this.error(`${path.join(".")} is not an array of tables`);
        }
      } else if (existing === undefined) {
        const made: Table = {};
        table[part] = made;
        table = made;
      } else if (Array.isArray(existing)) {
        if (last) throw this.error(`${path.join(".")} is an array of tables, not a table`);
        const tail = existing[existing.length - 1];
        if (tail === null || typeof tail !== "object" || Array.isArray(tail)) throw this.error(`${path.slice(0, i + 1).join(".")} is not a table`);
        table = tail;
      } else if (existing !== null && typeof existing === "object") {
        table = existing;
      } else {
        throw this.error(`${path.slice(0, i + 1).join(".")} is not a table`);
      }
      if (last && !array) {
        const key = path.join(".");
        if (defined.has(key)) throw this.error(`the table [${key}] is defined twice`);
        defined.add(key);
      }
    });
    return table;
  }

  private assign(table: Table, path: string[], value: Json): void {
    let target = table;
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        if (Object.hasOwn(target, part)) throw this.error(`the key ${path.join(".")} is set twice`);
        target[part] = value;
        return;
      }
      const existing = Object.hasOwn(target, part) ? target[part] : undefined;
      if (existing === undefined) {
        const made: Table = {};
        target[part] = made;
        target = made;
      } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
        target = existing;
      } else {
        throw this.error(`${path.slice(0, i + 1).join(".")} is not a table`);
      }
    });
  }

  private keyPath(): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '"') path.push(this.basicString());
      else if (c === "'") path.push(this.literalString());
      else {
        const bare = /^[A-Za-z0-9_-]+/.exec(this.source.slice(this.pos, this.pos + 200));
        if (bare === null) throw this.error("expected a key");
        path.push(bare[0]);
        this.pos += bare[0].length;
      }
      this.skipSpaces();
      if (this.peek() !== ".") return path;
      this.pos += 1;
    }
  }

  private value(): Json {
    const c = this.peek();
    if (c === '"') {
      if (this.source.startsWith('"""', this.pos)) throw this.error("multi-line strings are not supported");
      return this.basicString();
    }
    if (c === "'") {
      if (this.source.startsWith("'''", this.pos)) throw this.error("multi-line strings are not supported");
      return this.literalString();
    }
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    const word = /^[^\s,\]}#]+/.exec(this.source.slice(this.pos, this.pos + 200));
    if (word === null) throw this.error("expected a value");
    const text = word[0];
    this.pos += text.length;
    if (text === "true") return true;
    if (text === "false") return false;
    if (/^[+-]?(0|[1-9][0-9_]*)$/.test(text)) return Number(text.replace(/_/g, ""));
    throw this.error(`${JSON.stringify(text)} is not a string, integer, boolean, array or inline table (floats and dates are not supported)`);
  }

  private array(): Json {
    this.pos += 1;
    const items: Json[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) throw this.error("the array is not closed");
      if (this.peek() === "]") {
        this.pos += 1;
        return items;
      }
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") this.pos += 1;
      else if (this.peek() !== "]") throw this.error("expected , or ] in the array");
    }
  }

  private inlineTable(): Json {
    this.pos += 1;
    const table: Table = {};
    this.skipSpaces();
    if (this.peek() === "}") {
      this.pos += 1;
      return table;
    }
    for (;;) {
      const path = this.keyPath();
      this.skipSpaces();
      if (!this.take("=")) throw this.error("expected = after the key");
      this.skipSpaces();
      this.assign(table, path, this.value());
      this.skipSpaces();
      if (this.take(",")) {
        this.skipSpaces();
        continue;
      }
      if (this.take("}")) return table;
      throw this.error("expected , or } in the inline table");
    }
  }

  private basicString(): string {
    this.pos += 1;
    let out = "";
    for (;;) {
      const c = this.source[this.pos];
      if (c === undefined || c === "\n") throw this.error("the string is not closed");
      this.pos += 1;
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.source[this.pos];
      this.pos += 1;
      const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (e !== undefined && Object.hasOwn(simple, e)) out += simple[e];
      else if (e === "u" || e === "U") {
        const digits = e === "u" ? 4 : 8;
        const hex = this.source.slice(this.pos, this.pos + digits);
        if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) throw this.error("bad unicode escape");
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        this.pos += digits;
      } else throw this.error(`unknown escape \\${e ?? ""}`);
    }
  }

  private literalString(): string {
    const end = this.source.indexOf("'", this.pos + 1);
    const lineEnd = this.source.indexOf("\n", this.pos);
    if (end === -1 || (lineEnd !== -1 && end > lineEnd)) throw this.error("the string is not closed");
    const text = this.source.slice(this.pos + 1, end);
    this.pos = end + 1;
    return text;
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos += 1;
  }

  /** Spaces, newlines and comments. */
  private skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") this.pos += 1;
      else if (c === "\n") {
        this.pos += 1;
        this.line += 1;
      } else if (c === "#") {
        while (!this.eof() && this.peek() !== "\n") this.pos += 1;
      } else return;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    if (this.peek() === "#") while (!this.eof() && this.peek() !== "\n") this.pos += 1;
    if (this.eof()) return;
    if (this.peek() !== "\n") throw this.error("expected the end of the line");
  }

  private take(text: string): boolean {
    if (!this.source.startsWith(text, this.pos)) return false;
    this.pos += text.length;
    return true;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private eof(): boolean {
    return this.pos >= this.source.length;
  }

  private error(message: string): TomlError {
    return new TomlError(message, this.line);
  }
}
