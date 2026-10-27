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

/*
 * What Lean's lexer takes for a name (`isIdFirst` and `isIdRest` of `Init/Meta/Defs.lean`): a name
 * begins with an ASCII letter, `_`, or a Greek or letter-like character (not λ, Π and Σ), and goes
 * on with these and digits, `'`, `!`, `?` and subscripts. The tables hold what every version of Lean
 * takes for a name, and not the accented Latin letters that Lean 4.27 added: where a version and
 * this table disagree, a keyword after such a letter is refused, and not trusted as part of a name.
 */
export const LETTER_LIKE = "\\u{391}-\\u{39f}\\u{3a1}\\u{3a2}\\u{3a4}-\\u{3a9}\\u{3b1}-\\u{3ba}\\u{3bc}-\\u{3fb}\\u{1f00}-\\u{1ffe}\\u{2100}-\\u{214f}\\u{1d49c}-\\u{1d59f}";
export const NAME_START = `A-Za-z_${LETTER_LIKE}`;
export const NAME_PART = `${NAME_START}0-9'!?\\u{2080}-\\u{2089}\\u{2090}-\\u{209c}\\u{1d62}-\\u{1d6a}`;
export const NAME_START_CHARACTER = new RegExp(`^[${NAME_START}]$`, "u");
export const NAME_PART_CHARACTER = new RegExp(`^[${NAME_PART}]$`, "u");

/**
 * Where Lean's lexer starts a token for sure: at the start of the text, after white space (a space or
 * a line break; a tab is an error in Lean), and after `(`, `,` and `)`, none of which begins a longer
 * token that goes on with letters. After any other character a run of letters may be the tail of a
 * symbol token: Lean takes the longest token of its table when a token starts with a character that
 * no name has, and whatever follows is a new token (`#check` in core Lean, `[MOD`, `[ZMOD` and `⟫_`
 * with Mathlib). The table depends on what is imported, so no symbol is trusted to end a token.
 */
export const TOKEN_START = "(?<=^|[ \\n(,)])";

/** The most parts a dotted name has, and the most characters a part has, for a name to be taken for one. */
const MAX_NAME_PARTS = 16;
const MAX_NAME_PART_LENGTH = 256;
/** A run of name characters longer than this is not looked at further: its `'` is not trusted. */
const MAX_RUN = 1024;

function isSurrogatePair(chars: readonly string[], low: number): boolean {
  return low > 0 && /[\udc00-\udfff]/.test(chars[low] as string) && /[\ud800-\udbff]/.test(chars[low - 1] as string);
}

/** The character (a code point) that ends right before `end`, and where it starts. */
function characterBefore(chars: readonly string[], end: number): { start: number; text: string } {
  const start = isSurrogatePair(chars, end - 1) ? end - 2 : end - 1;
  return { start, text: chars.slice(start, end).join("") };
}

/**
 * Whether the `'` at `at` ends a name that the lexer starts at a token start (`TOKEN_START`): `x'`,
 * `h1'`, `Nat.succ'`, `(h'`. Any other `'` may start a character literal, which takes the next two
 * characters whatever they are (`tokenFnAux`, `charLitFnAux`): after `[`, `⟨` or a digit, and after a
 * symbol token that ends like a name (`⟫_'`), Lean reads a literal where a name would have ended.
 * `chars` is the text with the comments read so far blanked.
 */
export function continuesName(chars: readonly string[], at: number): boolean {
  let end = at;
  for (let part = 0; part < MAX_NAME_PARTS; part++) {
    let start = end;
    let count = 0;
    while (start > 0) {
      const before = characterBefore(chars, start);
      if (!NAME_PART_CHARACTER.test(before.text)) break;
      start = before.start;
      if (++count > MAX_RUN) return false;
    }
    // `!` and `?` before a name are tokens of their own, as the dots are.
    let first = start;
    while (first < end && (chars[first] === "!" || chars[first] === "?")) first++;
    const stripped = first - start;
    if (first === end) return false;
    const initial = chars.slice(first, first + (isSurrogatePair(chars, first + 1) ? 2 : 1)).join("");
    if (!NAME_START_CHARACTER.test(initial)) return false;
    if (count - stripped > MAX_NAME_PART_LENGTH) return false;
    // A dot between two names joins them into one.
    if (first === start && start > 1 && chars[start - 1] === "." && NAME_PART_CHARACTER.test(characterBefore(chars, start - 1).text)) {
      end = start - 1;
      continue;
    }
    let boundary = start;
    while (boundary > 0 && "!?.".includes(chars[boundary - 1] as string)) boundary--;
    return boundary === 0 || " \n(,)".includes(chars[boundary - 1] as string);
  }
  return false;
}

/**
 * The offset of the first `'` in a text that may start a character literal (`continuesName`), or -1.
 * A literal takes the two characters after the quote, a space or a letter among them, so that from
 * there on the places where the text seems to start a token (after a space, `(`, `,` or `)`) may be
 * inside the literal, and a run of letters after them (`' xsorry`: `' x` is the literal, `sorry` a
 * token of its own) is not a name that begins where it seems to. `chars` of the text, comments blanked.
 */
export function firstCharacterLiteral(text: string): number {
  let at = text.indexOf("'");
  if (at < 0) return -1;
  const chars = text.split("");
  for (; at >= 0; at = text.indexOf("'", at + 1)) if (!continuesName(chars, at)) return at;
  return -1;
}

/**
 * How far a scanner can trust its reading of comments. See `opensComment`. A `strict` reading is for
 * text that a model wrote, and trusts a comment in fewer places than the reading of a repository file.
 */
export interface CommentReading {
  trusted: boolean;
  strict: boolean;
}

/**
 * Whether a `--` or a `/-` at `at` opens a comment, in a text whose comments (and strings) read so far
 * are blanked in `chars`. Lean's lexer skips white space and comments after each token, and a token
 * can take the first character of what looks like an opener: `<-` in `<--`, `\/` in `\/-`, `//` in
 * `//-` (and more of them in what is imported). So a comment opens where the lexer is sure to read
 * white space: at the start of the text, after a space or a line break (a tab is an error in Lean), and
 * after a comment, which `chars` shows as blanks. An opener glued to any other character is code.
 *
 * A strict reading asks one thing more of `/-`: that the character after it is a space, a line break
 * or the end of the text. Lean's `whitespace` takes that character as part of the opener, so that
 * `/-/` opens a comment, and `/-/-/` is a complete one, which a scanner that nests would not close;
 * unless it is `-` or `!`, which make `/--` and `/-!` tokens of their own, whose white space and body
 * Lean reads on other terms (a `--` after `/--` is a line comment, and the body starts after it).
 *
 * An opener that is not sure ends the trust in the reading of the text. Lean may read it as a
 * comment (after a name, `x--note` is one), and then it reads what follows differently from a scanner
 * that took the opener for code: a comment that the scanner opens later may end past the end of the
 * one Lean reads, and hide code (`x/- a --/run_cmd`: Lean reads `run_cmd`, a scanner that blanks the
 * `--` does not). So `reading.trusted` is false from the first such opener on, and nothing after it is
 * blanked: the text is read as code, which finds more tokens than Lean does and never fewer.
 */
export function opensComment(chars: readonly string[], at: number, reading: CommentReading): boolean {
  const after = chars[at + 2];
  const gap = chars[at] !== "/" || !reading.strict || after === undefined || after === " " || after === "\n";
  if (reading.trusted && gap && (at === 0 || chars[at - 1] === " " || chars[at - 1] === "\n")) return true;
  reading.trusted = false;
  return false;
}

export interface BlankingOptions {
  /** The reading for text that a model wrote: see `opensComment` and `continuesName`. */
  strict?: boolean;
  /** Blank string literals too, where the reading is trusted. */
  strings?: boolean;
}

export interface BlankedText {
  /** The text with its comments (and strings, when asked) blanked, newlines kept. */
  masked: string;
  /** A block comment opened and the text ended before it closed. */
  unclosed: boolean;
}

/**
 * Blanks the comments of a text with spaces (newlines kept), so that searches for keywords or tokens
 * do not match inside them and offsets stay valid. A comment opens only where Lean is sure to read
 * one (`opensComment`); from the first opener that is not sure, the text is left as it is, string
 * literals included. A strict reading also turns the trust off at a `'` that may start a character
 * literal (`continuesName`), since a literal takes the next two characters, a `--` among them.
 */
export function blankComments(source: string, options: BlankingOptions = {}): BlankedText {
  const out = source.split("");
  const reading: CommentReading = { trusted: true, strict: options.strict === true };
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
    if (c === "'" && reading.strict && reading.trusted && !continuesName(out, i)) reading.trusted = false;
    if (c === '"' && options.strings === true && reading.trusted) {
      blank(out, i, 1);
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") blank(out, i++, 1);
        blank(out, i++, 1);
      }
      blank(out, i, 1);
    }
  }
  return { masked: out.join(""), unclosed: depth > 0 };
}

/**
 * Masks comments and string literals with spaces (newlines kept), so that searches for keywords or
 * tokens do not match inside them and offsets stay valid (`blankComments`). The reading of a
 * repository file is the default one: a comment opens where Lean is sure to read one. A text that a
 * model wrote is read with `{ strict: true }`, which trusts a comment in fewer places. The text that
 * remains is for a caller that reads it, or writes it as M11 does; a caller that writes it must
 * refuse a `--` or `/-` that remains in it, which Lean may read as a comment that reaches into what is
 * written after it. The screen of a text that is sent as it is is `scanRegion`.
 */
export function maskCommentsAndStrings(source: string, options: { strict?: boolean } = {}): string {
  return blankComments(source, { strict: options.strict === true, strings: true }).masked;
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
