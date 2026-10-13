/**
 * A light scanner for Lean 4 source files. It does not parse Lean; it finds where top-level commands
 * start (a line that begins at column 0 outside comments, strings and brackets), which is enough to
 * cut a file into commands and to locate a declaration. Mathlib-style files, including the
 * formal-conjectures corpus, keep every top-level command at column 0 and indent everything else.
 */

export interface Command {
  /** Offset of the first character of the command. */
  start: number;
  /** Offset just past the command, trailing blank lines included. */
  end: number;
  text: string;
  kind: "comment" | "docstring" | "code";
}

const OPENERS = new Set(["(", "[", "{", "⟨", "⦃", "⟦", "⁅"]);
const CLOSERS = new Set([")", "]", "}", "⟩", "⦄", "⟧", "⁆"]);

export function splitCommands(source: string): Command[] {
  const starts: number[] = [];
  let depth = 0; // block comment nesting
  let brackets = 0;
  let inString = false;
  let lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (lineStart) {
      lineStart = false;
      if (depth === 0 && !inString && brackets <= 0 && c !== "\n" && c !== " " && c !== "\t" && c !== "\r") {
        starts.push(i);
        brackets = 0;
      }
    }
    if (c === "\n") {
      lineStart = true;
      continue;
    }
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth > 0) {
      if (c === "/" && next === "-") {
        depth++;
        i++;
      } else if (c === "-" && next === "/") {
        depth--;
        i++;
      }
      continue;
    }
    if (c === "/" && next === "-") {
      depth = 1;
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (OPENERS.has(c)) brackets++;
    else if (CLOSERS.has(c)) brackets--;
  }
  // An attribute or an `open ... in` on its own lines (`@[category ...]` then `theorem ...` at
  // column 0) belongs to the declaration that follows it, comments in between included.
  const commands: Command[] = [];
  let groupStart: number | undefined;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k] as number;
    const end = k + 1 < starts.length ? (starts[k + 1] as number) : source.length;
    const text = source.slice(start, end);
    const kind = kindOf(text);
    if (kind === "code" && isPrefixOnly(text)) {
      groupStart ??= start;
      continue;
    }
    if (groupStart !== undefined && kind === "comment") continue;
    const from = groupStart ?? start;
    groupStart = undefined;
    commands.push({ start: from, end, text: source.slice(from, end), kind: from === start ? kind : "code" });
  }
  if (groupStart !== undefined) {
    commands.push({ start: groupStart, end: source.length, text: source.slice(groupStart), kind: "code" });
  }
  return commands;
}

function kindOf(text: string): Command["kind"] {
  if (text.startsWith("/--")) return "docstring";
  return text.startsWith("/-") || text.startsWith("--") ? "comment" : "code";
}

/** True for text made only of attributes, `open ... in` and `set_option ... in`. */
function isPrefixOnly(text: string): boolean {
  let rest = maskCommentsAndStrings(text);
  let seen = false;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest === "") return seen;
    const scoped = /^(?:open\s[^\n]*?\sin|set_option\s+\S+\s+\S+\s+in)(?=\s|$)/.exec(rest);
    if (scoped) {
      rest = rest.slice(scoped[0].length);
      seen = true;
      continue;
    }
    if (!rest.startsWith("@[")) return false;
    let level = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "[") level++;
      else if (rest[i] === "]" && --level === 0) break;
    }
    if (level !== 0) return false;
    rest = rest.slice(i + 1);
    seen = true;
  }
}

/**
 * Masks comments and string literals with spaces (newlines kept), so that searches for keywords or
 * tokens do not match inside them and offsets stay valid.
 */
export function maskCommentsAndStrings(source: string): string {
  const out = source.split("");
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (depth > 0) {
      if (c === "/" && next === "-") {
        depth++;
        blank(out, i, 2);
        i++;
      } else if (c === "-" && next === "/") {
        depth--;
        blank(out, i, 2);
        i++;
      } else {
        blank(out, i, 1);
      }
      continue;
    }
    if (c === "/" && next === "-") {
      depth = 1;
      blank(out, i, 2);
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") blank(out, i++, 1);
      i--;
      continue;
    }
    if (c === '"') {
      blank(out, i, 1);
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") blank(out, i++, 1);
        blank(out, i++, 1);
      }
      blank(out, i, 1);
    }
  }
  return out.join("");
}

function blank(chars: string[], at: number, count: number): void {
  for (let k = at; k < at + count && k < chars.length; k++) if (chars[k] !== "\n") chars[k] = " ";
}

const MODIFIERS = new Set(["private", "protected", "noncomputable", "nonrec", "partial", "unsafe", "public"]);
const IDENT = /^(?:«[^»]*»|[^\s()[\]{}⟨⟩:,@«»]+)(?:\.(?:«[^»]*»|[^\s()[\]{}⟨⟩:,@«».]+))*/u;

export interface DeclarationHead {
  keyword: string;
  name: string;
  /** Offset (in the command text) of the keyword. */
  keywordOffset: number;
  /** Offset (in the command text) just after the name. */
  nameEnd: number;
}

/** Reads `@[attrs] modifiers keyword name` at the start of a code command. */
export function readDeclarationHead(text: string): DeclarationHead | undefined {
  const masked = maskCommentsAndStrings(text);
  let i = 0;
  const skipSpace = () => {
    while (i < masked.length && /\s/.test(masked[i] as string)) i++;
  };
  skipSpace();
  while (masked.startsWith("@[", i)) {
    let level = 0;
    for (; i < masked.length; i++) {
      if (masked[i] === "[") level++;
      else if (masked[i] === "]" && --level === 0) {
        i++;
        break;
      }
    }
    skipSpace();
  }
  for (;;) {
    const word = /^[a-z_]+/.exec(masked.slice(i))?.[0];
    if (word === undefined || !MODIFIERS.has(word)) break;
    i += word.length;
    skipSpace();
  }
  const keyword = /^[a-z_]+/.exec(masked.slice(i))?.[0];
  if (keyword === undefined) return undefined;
  const keywordOffset = i;
  i += keyword.length;
  if (!/\s/.test(masked[i] ?? "")) return undefined;
  skipSpace();
  const name = IDENT.exec(text.slice(i))?.[0];
  if (name === undefined) return { keyword, name: "", keywordOffset, nameEnd: i };
  return { keyword, name, keywordOffset, nameEnd: i + name.length };
}

interface Scope {
  kind: "namespace" | "section";
  parts: string[];
}

/** The namespace in force at the start of each command, from `namespace`, `section` and `end`. */
export function namespacesAt(commands: readonly Command[]): string[][] {
  const stack: Scope[] = [];
  const result: string[][] = [];
  for (const command of commands) {
    result.push(stack.filter((s) => s.kind === "namespace").flatMap((s) => s.parts));
    if (command.kind !== "code") continue;
    const line = maskCommentsAndStrings(command.text).trim();
    const ns = /^namespace\s+(\S+)/.exec(line);
    if (ns) {
      stack.push({ kind: "namespace", parts: (ns[1] as string).split(".") });
      continue;
    }
    if (/^(?:@\[[^\]]*\]\s*)?(?:(?:noncomputable|public|private)\s+)*section\b/.test(line)) {
      stack.push({ kind: "section", parts: [] });
      continue;
    }
    if (/^end\b/.test(line)) stack.pop();
  }
  return result;
}
