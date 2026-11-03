import { collapseWhitespace, maskCommentsAndStrings, stripLeanComments } from "@seshat/core";

/**
 * A small reader for the Lean statements the router and the translators look at: a signature
 * (binders, then `:` and a proposition) over arithmetic, connectives, quantifiers and applications.
 * It is no Lean parser. A statement it cannot read gives an `Unreadable` reason, and the callers
 * then treat the goal as unknown to the router and outside the translators' fragment.
 */
export type Term =
  | { k: "num"; text: string }
  | { k: "var"; name: string }
  /** An operator (`+`, `≤`, `∣`, `∧`, `¬`...) or a function applied to arguments (`f x`). */
  | { k: "app"; fn: string; args: Term[]; op: boolean }
  | { k: "quant"; q: "∀" | "∃"; vars: Array<{ name: string; type?: string }>; body: Term }
  | { k: "lit"; value: boolean };

export type Binder =
  /** `(x y : ℕ)`, `{x : ℤ}`, or an implicit/explicit variable of a sort. */
  | { kind: "var"; name: string; type: string }
  /** `(h : n < m)`: a hypothesis. */
  | { kind: "hyp"; name: string; prop: Term }
  /** `[Mul M]`. */
  | { kind: "inst"; text: string; cls: string; arg: string };

export interface Statement {
  binders: Binder[];
  conclusion: Term;
}

export class Unreadable extends Error {}

// --- Tokens ------------------------------------------------------------------------------------

type Token = { t: "num" | "id" | "sym"; v: string };

const SYMBOLS = [
  "<->", "->", "<=", ">=", "!=", "/\\", "\\/", ":=", "=>", "↔", "→", "≤", "≥", "≠", "∧", "∨", "¬", "∀", "∃", "∣", "∈", "∉", "⊆", "↑", "↦", "∑", "∏",
  "(", ")", "[", "]", "{", "}", "⟨", "⟩", ",", ":", "+", "-", "*", "/", "%", "^", "<", ">", "=", "·", "∘", "⁻¹", "|", "∣",
];

const ALIASES: Readonly<Record<string, string>> = { "<->": "↔", "->": "→", "<=": "≤", ">=": "≥", "!=": "≠", "/\\": "∧", "\\/": "∨", "=>": "↦" };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    const digits = /^\d+(?:\.\d+)?/u.exec(text.slice(i));
    if (digits !== null) {
      tokens.push({ t: "num", v: digits[0] });
      i += digits[0].length;
      continue;
    }
    // Subscripts and primes belong to identifiers; so do `.` between name parts (`Nat.succ`) and `?`/`!` suffixes.
    const id = /^[\p{L}_][\p{L}\p{N}_'₀-₉]*(?:\.[\p{L}_][\p{L}\p{N}_'₀-₉]*)*/u.exec(text.slice(i));
    if (id !== null && !/^[∀∃∑∏λ¬∧∨↔→≤≥≠∣∈∉⊆↑↦]/u.test(c)) {
      // ℕ ℤ ℝ ℚ ℂ are letters in Unicode (category Lu/Ll for the double-struck forms), so they come here as identifiers.
      tokens.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const symbol = SYMBOLS.find((s) => text.startsWith(s, i));
    if (symbol === undefined) throw new Unreadable(`unknown character ${JSON.stringify(c)}`);
    tokens.push({ t: "sym", v: ALIASES[symbol] ?? symbol });
    i += symbol.length;
  }
  return tokens;
}

// --- Terms -------------------------------------------------------------------------------------

/** Binding power of the infix operators, and whether they associate to the right. */
const INFIX: Readonly<Record<string, { bp: number; right: boolean }>> = {
  "↔": { bp: 20, right: false },
  "→": { bp: 25, right: true },
  "∨": { bp: 30, right: true },
  "∧": { bp: 35, right: true },
  "=": { bp: 50, right: false },
  "≠": { bp: 50, right: false },
  "<": { bp: 50, right: false },
  ">": { bp: 50, right: false },
  "≤": { bp: 50, right: false },
  "≥": { bp: 50, right: false },
  "∣": { bp: 50, right: false },
  "∈": { bp: 50, right: false },
  "∉": { bp: 50, right: false },
  "⊆": { bp: 50, right: false },
  "+": { bp: 65, right: false },
  "-": { bp: 65, right: false },
  "*": { bp: 70, right: false },
  "/": { bp: 70, right: false },
  "%": { bp: 70, right: false },
  "^": { bp: 75, right: true },
};

class Reader {
  readonly tokens: Token[];
  pos = 0;
  /** How deep the expression being read is nested. */
  depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Unreadable("the statement ends too soon");
    return token;
  }

  is(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.t !== "num" && token.v === value;
  }

  eat(value: string): boolean {
    if (!this.is(value)) return false;
    this.pos++;
    return true;
  }

  expect(value: string): void {
    if (!this.eat(value)) throw new Unreadable(`expected ${JSON.stringify(value)}, found ${JSON.stringify(this.peek()?.v ?? "the end")}`);
  }

  done(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/** The tokens that cannot start an argument of an application. */
function startsArgument(token: Token | undefined): boolean {
  if (token === undefined) return false;
  if (token.t === "num" || token.t === "id") return true;
  return token.v === "(" || token.v === "↑";
}

/** The deepest nesting of parentheses, negations and quantifiers the reader accepts; a hostile goal must not overflow the stack. */
export const MAX_DEPTH = 150;
/** The longest statement the reader accepts, in characters (the conjectures of the harness are far shorter). */
export const MAX_STATEMENT = 4000;

function parseExpr(r: Reader, minBp: number): Term {
  if (++r.depth > MAX_DEPTH) throw new Unreadable("the statement is nested too deeply");
  try {
    return parseExprAt(r, minBp);
  } finally {
    r.depth--;
  }
}

function parseExprAt(r: Reader, minBp: number): Term {
  let left = parsePrefix(r);
  for (;;) {
    const token = r.peek();
    if (token === undefined || token.t !== "sym") break;
    const info = INFIX[token.v];
    if (info === undefined || info.bp < minBp) break;
    r.next();
    const right = parseExpr(r, info.right ? info.bp : info.bp + 1);
    left = { k: "app", fn: token.v, args: [left, right], op: true };
  }
  return left;
}

function parseBinderNames(r: Reader): Array<{ name: string; type?: string }> {
  const vars: Array<{ name: string; type?: string }> = [];
  // `∀ x y : ℕ, P`, `∀ x, P`, `∀ (x : ℕ) (y : ℕ), P`, `∀ x ∈ S, P` (the last is outside what is read).
  if (r.is("(")) {
    while (r.eat("(")) {
      const names: string[] = [];
      while (r.peek()?.t === "id") names.push(r.next().v);
      r.expect(":");
      const type = parseTypeText(r, ")");
      r.expect(")");
      for (const name of names) vars.push({ name, type });
    }
    return vars;
  }
  const names: string[] = [];
  while (r.peek()?.t === "id") names.push(r.next().v);
  if (names.length === 0) throw new Unreadable("a quantifier binds no variable");
  if (r.is("∈") || r.is("<") || r.is("≤") || r.is(">") || r.is("≥")) throw new Unreadable("a bounded quantifier (∀ x ∈ s, ..., ∀ x < n, ...)");
  if (r.eat(":")) {
    const type = parseTypeText(r, ",");
    for (const name of names) vars.push({ name, type });
  } else {
    for (const name of names) vars.push({ name });
  }
  return vars;
}

/** The text of a type up to a closing token (not consumed) at bracket depth 0. */
function parseTypeText(r: Reader, stop: string): string {
  const parts: string[] = [];
  let depth = 0;
  for (;;) {
    const token = r.peek();
    if (token === undefined) throw new Unreadable("a type that does not end");
    if (depth === 0 && token.t === "sym" && token.v === stop) break;
    if (token.t === "sym" && (token.v === "(" || token.v === "[" || token.v === "{" || token.v === "⟨")) depth++;
    if (token.t === "sym" && (token.v === ")" || token.v === "]" || token.v === "}" || token.v === "⟩")) depth--;
    parts.push(token.v);
    r.next();
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function parsePrefix(r: Reader): Term {
  const token = r.peek();
  if (token === undefined) throw new Unreadable("the statement ends too soon");
  if (token.t === "sym") {
    if (token.v === "¬") {
      r.next();
      return { k: "app", fn: "¬", args: [parseExpr(r, 40)], op: true };
    }
    if (token.v === "-") {
      r.next();
      return { k: "app", fn: "neg", args: [parseExpr(r, 75)], op: true };
    }
    if (token.v === "∀" || token.v === "∃") {
      r.next();
      const vars = parseBinderNames(r);
      r.expect(",");
      return { k: "quant", q: token.v, vars, body: parseExpr(r, 0) };
    }
    if (token.v === "↑") throw new Unreadable("a cast (↑)");
    if (token.v === "∑" || token.v === "∏") throw new Unreadable("a big operator (∑, ∏)");
    if (token.v === "⟨") throw new Unreadable("an anonymous constructor");
  }
  return parseApplication(r);
}

function parseApplication(r: Reader): Term {
  const head = parseAtom(r);
  if (head.k !== "var") return head;
  const args: Term[] = [];
  while (startsArgument(r.peek())) args.push(parseAtom(r));
  return args.length === 0 ? head : { k: "app", fn: head.name, args, op: false };
}

function parseAtom(r: Reader): Term {
  const token = r.next();
  if (token.t === "num") return { k: "num", text: token.v };
  if (token.t === "id") {
    if (token.v === "True") return { k: "lit", value: true };
    if (token.v === "False") return { k: "lit", value: false };
    if (token.v === "fun" || token.v === "λ") throw new Unreadable("a lambda");
    if (token.v === "if" || token.v === "match" || token.v === "let" || token.v === "by") throw new Unreadable(`'${token.v}'`);
    return { k: "var", name: token.v };
  }
  if (token.v === "(") {
    const inner = parseExpr(r, 0);
    if (r.is(",")) throw new Unreadable("a tuple");
    if (r.is(":")) throw new Unreadable("a type ascription");
    r.expect(")");
    return inner;
  }
  throw new Unreadable(`unexpected ${JSON.stringify(token.v)}`);
}

/** Reads one expression from text; the whole text must be used. */
export function parseTerm(text: string): Term {
  const r = new Reader(tokenize(collapseWhitespace(stripLeanComments(text))));
  const term = parseExpr(r, 0);
  if (!r.done()) throw new Unreadable(`unexpected ${JSON.stringify(r.peek()?.v)}`);
  return term;
}

// --- Statements --------------------------------------------------------------------------------

const OPEN = "([{⟨⦃⟦⁅";
const CLOSE = ")]}⟩⦄⟧⁆";

/** Splits a signature at its first colon outside brackets: the binders' text, the type's text. */
export function splitSignature(statement: string): { binders: string; type: string } {
  const text = collapseWhitespace(stripLeanComments(statement));
  const masked = maskCommentsAndStrings(text);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && c === ":" && masked[i + 1] !== "=") {
      const type = text.slice(i + 1).trim();
      if (type === "") break;
      return { binders: text.slice(0, i).trim(), type };
    }
  }
  throw new Unreadable("not a statement in signature form");
}

function bracketGroups(binders: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of binders) {
    if (OPEN.includes(c)) depth++;
    if (depth > 0) current += c;
    else if (!/\s/u.test(c)) throw new Unreadable(`a bare binder: ${JSON.stringify(c)}`);
    if (CLOSE.includes(c)) {
      depth--;
      if (depth === 0) {
        groups.push(current);
        current = "";
      }
    }
  }
  return groups;
}

/** The sorts the readers know as the type of a variable. */
const BUILTIN_SORTS = new Set(["ℕ", "ℤ", "ℝ", "ℚ", "ℂ", "Nat", "Int", "Real", "Rat", "Complex", "Bool", "Prop"]);

/** The canonical spelling of a number sort, or the text as it is. */
export function canonicalSort(type: string): string {
  switch (type) {
    case "Nat":
      return "ℕ";
    case "Int":
      return "ℤ";
    case "Real":
      return "ℝ";
    case "Rat":
      return "ℚ";
    case "Complex":
      return "ℂ";
    default:
      return type;
  }
}

const TYPE_SORT = /^Type(?:\*| _| [\p{L}\p{N}_]+)?$/u;

/** Reads a statement in signature form. Throws `Unreadable` with the reason when it cannot. */
export function parseStatement(statement: string): Statement {
  if (statement.length > MAX_STATEMENT) throw new Unreadable(`the statement has ${statement.length} characters; the reader takes at most ${MAX_STATEMENT}`);
  const { binders: text, type } = splitSignature(statement);
  const sorts = new Set<string>(BUILTIN_SORTS);
  const binders: Binder[] = [];
  for (const group of bracketGroups(text)) {
    const bracket = group[0] as string;
    const inner = group.slice(1, -1).trim();
    if (bracket === "[") {
      const m = /^(?:[\p{L}_][\p{L}\p{N}_']*\s*:\s*)?([\p{L}_][\p{L}\p{N}_'.]*)\s+(.+)$/u.exec(inner);
      if (m === null) throw new Unreadable(`an instance binder: ${group}`);
      binders.push({ kind: "inst", text: group, cls: m[1] as string, arg: (m[2] as string).trim() });
      continue;
    }
    if (bracket !== "(" && bracket !== "{") throw new Unreadable(`a binder in ${bracket}`);
    const colon = inner.indexOf(":");
    if (colon < 0) throw new Unreadable(`a binder without a type: ${group}`);
    const names = inner.slice(0, colon).trim().split(/\s+/u);
    const ty = inner.slice(colon + 1).trim();
    if (names.some((n) => !/^[\p{L}_][\p{L}\p{N}_'₀-₉]*$/u.test(n))) throw new Unreadable(`binder names: ${group}`);
    if (TYPE_SORT.test(ty)) {
      for (const name of names) {
        sorts.add(name);
        binders.push({ kind: "var", name, type: ty });
      }
      continue;
    }
    if (isSortText(ty, sorts)) {
      for (const name of names) binders.push({ kind: "var", name, type: canonicalSort(ty) });
      continue;
    }
    if (bracket === "{") throw new Unreadable(`an implicit binder that is no variable: ${group}`);
    const prop = parseTerm(ty);
    for (const name of names) binders.push({ kind: "hyp", name, prop });
  }
  return { binders, conclusion: parseTerm(type) };
}

/** A type text: a known sort, `Fin n`, a function type between sorts. */
function isSortText(text: string, sorts: ReadonlySet<string>): boolean {
  const parts = text.split(/\s*→\s*|\s*->\s*/u);
  return parts.every((part) => sorts.has(part) || /^Fin \d+$/u.test(part) || /^Fin [\p{L}_][\p{L}\p{N}_']*$/u.test(part));
}

/** Every variable name used free or bound in a term. */
export function termVariables(term: Term, into = new Set<string>()): Set<string> {
  switch (term.k) {
    case "var":
      into.add(term.name);
      break;
    case "app":
      if (!term.op) into.add(term.fn);
      for (const a of term.args) termVariables(a, into);
      break;
    case "quant":
      termVariables(term.body, into);
      break;
    default:
  }
  return into;
}

/** The term in a canonical text, for tests and messages. */
export function show(term: Term): string {
  switch (term.k) {
    case "num":
      return term.text;
    case "var":
      return term.name;
    case "lit":
      return term.value ? "True" : "False";
    case "quant":
      return `(${term.q} ${term.vars.map((v) => (v.type !== undefined ? `(${v.name} : ${v.type})` : v.name)).join(" ")}, ${show(term.body)})`;
    case "app":
      if (!term.op) return `(${[term.fn, ...term.args.map(show)].join(" ")})`;
      if (term.args.length === 1) return `(${term.fn === "neg" ? "-" : term.fn}${show(term.args[0] as Term)})`;
      return `(${show(term.args[0] as Term)} ${term.fn} ${show(term.args[1] as Term)})`;
  }
}
