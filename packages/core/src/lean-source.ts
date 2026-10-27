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

/**
 * A line at column 0 still belongs to the previous command when that one cannot end where it
 * stopped: after `:`, `,`, an arrow, a connective or a relation, as in
 * `theorem t :` followed by `answer(sorry) ↔ ...` at column 0.
 */
const CONTINUES = new Set([":", ",", "↔", "→", "←", "∧", "∨", "=", "+", "^", "∣", "≤", "≥", "<", ">", "≠", "∈", "∉", "⊆", "⊂", "∘", "×", "•", "∀", "∃", "↦", "¬"]);

export function splitCommands(source: string): Command[] {
  const starts: number[] = [];
  let depth = 0; // block comment nesting
  let brackets = 0;
  let inString = false;
  let lineStart = true;
  let last = ""; // last character outside comments
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (lineStart) {
      lineStart = false;
      const blank = c === "\n" || c === " " || c === "\t" || c === "\r";
      if (depth === 0 && !inString && brackets <= 0 && !blank && c !== "|" && !CONTINUES.has(last)) {
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
      else if (c === '"') {
        inString = false;
        last = c;
      }
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
    if (c !== " " && c !== "\t" && c !== "\r") last = c;
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
 * How far a scanner can trust its reading of comments. See `opensComment`.
 */
export interface CommentReading {
  trusted: boolean;
}

/**
 * Whether a `--` or a `/-` at `at` opens a comment, in a text whose comments (and strings) read so far
 * are blanked in `chars`. Lean's lexer skips white space and comments after each token, and a token
 * can take the first character of what looks like an opener: `<-` in `<--`, `\/` in `\/-`, `//` in
 * `//-` (and more of them in what is imported). So a comment opens where the lexer is sure to read
 * white space: at the start of the text, after a space or a line break (a tab is an error in Lean), and
 * after a comment, which `chars` shows as blanks. An opener glued to any other character is code.
 *
 * Such an opener ends the trust in the reading of the text. Lean may read it as a comment (after a
 * name, `x--note` is one), and then it reads what follows differently from a scanner that took the
 * opener for code: a comment that the scanner opens later may end past the end of the one Lean reads,
 * and hide code (`x/- a --/run_cmd`: Lean reads `run_cmd`, a scanner that blanks the `--` does not).
 * So `reading.trusted` is false from the first such opener on, and nothing after it is blanked: the
 * text is read as code, which finds more tokens than Lean does and never fewer.
 */
export function opensComment(chars: readonly string[], at: number, reading: CommentReading): boolean {
  if (reading.trusted && (at === 0 || chars[at - 1] === " " || chars[at - 1] === "\n")) return true;
  reading.trusted = false;
  return false;
}

/**
 * Masks comments and string literals with spaces (newlines kept), so that searches for keywords or
 * tokens do not match inside them and offsets stay valid. A comment opens only where Lean is sure to
 * read one (`opensComment`); from the first opener that is not read as a comment, the text is left as
 * it is, strings included. The text that remains is for a caller that writes it, as M11 does, or reads
 * it; the screen of a text that is sent as it is, is `scanRegion`.
 */
export function maskCommentsAndStrings(source: string): string {
  const out = source.split("");
  const reading: CommentReading = { trusted: true };
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
    if (c === "/" && next === "-" && opensComment(out, i, reading)) {
      depth = 1;
      blank(out, i, 2);
      i++;
      continue;
    }
    if (c === "-" && next === "-" && opensComment(out, i, reading)) {
      while (i < source.length && source[i] !== "\n") blank(out, i++, 1);
      i--;
      continue;
    }
    if (c === '"' && reading.trusted) {
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

/** Splits a dotted name, keeping `«...»` parts whole: `Arxiv.«1609.08688»` has two parts. */
export function nameParts(name: string): string[] {
  return name.match(/«[^»]*»|[^.«]+/g) ?? [];
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
      stack.push({ kind: "namespace", parts: nameParts(command.text.trim().slice("namespace".length).trim().split(/\s/)[0] as string) });
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

/**
 * Rewrites a Lean file, line for line, into a plain (non-module) file whose first non-blank lines
 * are its imports: comments and `module` before the imports become blank lines, `public import` and
 * `meta import` become `import`, and `@[expose] public section` becomes `section`.
 *
 * REPL servers such as Kimina take the leading `import` and blank lines as the header, run the rest
 * in an environment that has those imports, and report positions relative to the whole snippet. A
 * file in this form gets the same line numbers in the REPL as on disk.
 */
export function toPlainHeader(source: string): string {
  const lines = source.split("\n");
  const masked = maskCommentsAndStrings(source).split("\n");
  const out = [...lines];
  const importRe = /^(?:public\s+)?(?:meta\s+)?import\s+(.+)$/;
  // The header region: blank, comment, `module` and import lines from the top, up to the last import.
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = (masked[i] ?? "").trim();
    if (importRe.test(line)) last = i;
    else if (line !== "" && line !== "module") break;
  }
  for (let i = 0; i <= last; i++) {
    const imported = importRe.exec((masked[i] ?? "").trim());
    out[i] = imported ? `import ${(imported[1] as string).trim().split(/\s+/).join(" ")}` : "";
  }
  for (let k = last + 1; k < lines.length; k++) {
    if (/^(?:@\[expose\]\s*)?public\s+section$/.test((masked[k] ?? "").trim())) out[k] = "section";
  }
  return out.join("\n");
}

/** The modules a file imports (after `toPlainHeader`, the header lines). */
export function importsOf(source: string): string[] {
  const imports: string[] = [];
  for (const line of toPlainHeader(source).split("\n")) {
    if (line === "") continue;
    if (!line.startsWith("import ")) break;
    imports.push(...line.slice("import ".length).split(" "));
  }
  return imports;
}
