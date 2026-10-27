import type { Magma } from "./objects.ts";

/** A term over variables and one binary operation: `x`, `x * y`, `(x * y) * z`. */
export type Term = { kind: "var"; name: string } | { kind: "op"; left: Term; right: Term };

/**
 * An equational law of magmas, `left = right`, for all values of its variables. `variables` are the
 * ones that occur, in order of first appearance, the left side first.
 */
export interface Law {
  left: Term;
  right: Term;
  variables: string[];
  /** The type the binders of `∀` name (`M` in `∀ x y : M, ...`), when they name one. */
  type?: string;
}

export class LawSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LawSyntaxError";
  }
}

/** The most variables a law may have: the evaluation tries every assignment, `size ** variables` of them. */
export const MAX_LAW_VARIABLES = 8;

/**
 * The most occurrences of variables on one side of a law. The evaluation computes every one of them
 * for every assignment, and the term is walked recursively: the laws that are studied have a few on
 * a side, and a side of a million would be a term a million deep.
 */
export const MAX_LAW_OCCURRENCES = 64;

/** The deepest nesting of parentheses in a law: the parser recurses once for each level. */
export const MAX_LAW_NESTING = 32;

type Token = { kind: "ident" | "forall" | "sym"; text: string; at: number };

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_'!?]/u;
const OPERATORS = new Set(["*", "◇"]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === "∀") {
      tokens.push({ kind: "forall", text: c, at: i++ });
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text.charAt(j))) j++;
      const word = text.slice(i, j);
      tokens.push({ kind: word === "forall" ? "forall" : "ident", text: word, at: i });
      i = j;
    } else if ("(),:=".includes(c) || OPERATORS.has(c)) {
      tokens.push({ kind: "sym", text: c, at: i++ });
    } else if (/\d/.test(c)) {
      throw new LawSyntaxError(`a number (${c}) is not a term of a magma law: only variables and the operation`);
    } else {
      throw new LawSyntaxError(`'${c}' is not part of a magma law: a law has variables, '*' (or '◇'), parentheses and '='`);
    }
  }
  return tokens;
}

/**
 * Reads a law such as `x * y = y * x`, `∀ x y z : M, (x * y) * z = x * (y * z)` or
 * `∀ (x y : M) (z : M), x * y = z`. `*` and `◇` are the operation and associate to the left, as in
 * Lean. A law with no `∀` has all its variables universally quantified unless `implicit` is false.
 */
export function parseLaw(text: string, options: { implicit?: boolean } = {}): Law {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const here = () => (peek() === undefined ? "the end of the law" : `'${peek()?.text}'`);
  const expect = (symbol: string) => {
    const t = tokens[pos];
    if (t?.kind !== "sym" || t.text !== symbol) throw new LawSyntaxError(`expected '${symbol}', found ${here()}`);
    pos++;
  };
  const ident = (what: string) => {
    const t = tokens[pos];
    if (t?.kind !== "ident") throw new LawSyntaxError(`expected ${what}, found ${here()}`);
    pos++;
    return t.text;
  };
  const isSym = (symbol: string) => peek()?.kind === "sym" && peek()?.text === symbol;

  const bound = new Set<string>();
  let type: string | undefined;
  const setType = (name: string) => {
    if (type !== undefined && type !== name) throw new LawSyntaxError(`the variables have two types, ${type} and ${name}: a magma law has one`);
    type = name;
  };
  while (peek()?.kind === "forall") {
    pos++;
    if (isSym("(")) {
      while (isSym("(")) {
        pos++;
        const names: string[] = [];
        while (peek()?.kind === "ident") names.push(ident("a variable"));
        if (names.length === 0) throw new LawSyntaxError(`expected a variable after '(', found ${here()}`);
        expect(":");
        setType(ident("a type"));
        expect(")");
        for (const name of names) bound.add(name);
      }
    } else {
      const names: string[] = [];
      while (peek()?.kind === "ident") names.push(ident("a variable"));
      if (names.length === 0) throw new LawSyntaxError(`expected a variable after '∀', found ${here()}`);
      if (isSym(":")) {
        pos++;
        setType(ident("a type"));
      }
      for (const name of names) bound.add(name);
    }
    expect(",");
  }

  // The size limits are checked as the term is read, so that a text of a million variables or of
  // a hundred thousand parentheses is refused before a term that deep exists, and before the
  // parser (which recurses once for each level of parentheses) can run out of stack.
  let side = "left";
  let occurrences = 0;
  let nesting = 0;
  const term = (): Term => {
    let left = atom();
    while (peek()?.kind === "sym" && OPERATORS.has(peek()?.text ?? "")) {
      pos++;
      left = { kind: "op", left, right: atom() };
    }
    return left;
  };
  const atom = (): Term => {
    if (isSym("(")) {
      if (++nesting > MAX_LAW_NESTING) throw new LawSyntaxError(`the law has parentheses nested more than ${MAX_LAW_NESTING} deep`);
      pos++;
      const inner = term();
      expect(")");
      nesting--;
      return inner;
    }
    const name = ident("a variable or '('");
    if (++occurrences > MAX_LAW_OCCURRENCES) throw new LawSyntaxError(`the ${side} side of the law has more than ${MAX_LAW_OCCURRENCES} occurrences of variables`);
    return { kind: "var", name };
  };

  const left = term();
  expect("=");
  side = "right";
  occurrences = 0;
  const right = term();
  if (pos < tokens.length) throw new LawSyntaxError(`unexpected ${here()} after the law`);

  const variables: string[] = [];
  for (const t of [left, right]) collect(t, variables);
  if (variables.length > MAX_LAW_VARIABLES) throw new LawSyntaxError(`the law has ${variables.length} variables; at most ${MAX_LAW_VARIABLES} are evaluated`);
  if (bound.size > 0 || options.implicit === false) {
    const free = variables.filter((v) => !bound.has(v));
    if (free.length > 0) throw new LawSyntaxError(`${free.join(", ")} ${free.length === 1 ? "is" : "are"} not bound by a '∀'`);
  }
  return { left, right, variables, ...(type !== undefined ? { type } : {}) };
}

function collect(term: Term, into: string[]): void {
  if (term.kind === "var") {
    if (!into.includes(term.name)) into.push(term.name);
  } else {
    collect(term.left, into);
    collect(term.right, into);
  }
}

/**
 * The occurrences of variables in a term, `x * (x * y)` having three: what the evaluator computes
 * for each side of a law at each assignment. Counted with a stack of its own, so that a term of any
 * depth, also one built by hand and not read by `parseLaw`, can be measured.
 */
export function termSize(term: Term): number {
  let size = 0;
  const pending: Term[] = [term];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.kind === "var") size++;
    else pending.push(next.left, next.right);
  }
  return size;
}

/** A term as Lean writes it: `x * y * z` for `(x * y) * z` and `x * (y * z)` for the other nesting. */
export function printTerm(term: Term, symbol = "*"): string {
  if (term.kind === "var") return term.name;
  const left = printTerm(term.left, symbol);
  const right = term.right.kind === "op" ? `(${printTerm(term.right, symbol)})` : printTerm(term.right, symbol);
  return `${left} ${symbol} ${right}`;
}

/** A law as Lean writes it, `∀ x y : M, x * y = y * x` when it has a type to name, else without the `∀`. */
export function printLaw(law: Law, options: { type?: string; symbol?: string } = {}): string {
  const body = `${printTerm(law.left, options.symbol)} = ${printTerm(law.right, options.symbol)}`;
  const type = options.type ?? law.type;
  return type === undefined ? body : `∀ ${law.variables.join(" ")} : ${type}, ${body}`;
}

type Compiled = (assignment: Int32Array, table: readonly number[], size: number) => number;

function compile(term: Term, index: ReadonlyMap<string, number>): Compiled {
  if (term.kind === "var") {
    const i = index.get(term.name) as number;
    return (assignment) => assignment[i] as number;
  }
  const left = compile(term.left, index);
  const right = compile(term.right, index);
  return (assignment, table, size) => table[left(assignment, table, size) * size + right(assignment, table, size)] as number;
}

/** A law compiled for repeated evaluation: the first assignment of values that breaks it, or undefined. */
export function compileLaw(law: Law): (magma: Magma) => number[] | undefined {
  const index = new Map(law.variables.map((v, i) => [v, i] as const));
  const left = compile(law.left, index);
  const right = compile(law.right, index);
  const k = law.variables.length;
  return (magma) => {
    const { size, table } = magma;
    const assignment = new Int32Array(k);
    for (;;) {
      if (left(assignment, table, size) !== right(assignment, table, size)) return Array.from(assignment);
      // The next assignment, as an odometer whose last digit turns fastest.
      let digit = k - 1;
      while (digit >= 0 && (assignment[digit] as number) === size - 1) assignment[digit--] = 0;
      if (digit < 0) return undefined;
      assignment[digit] = (assignment[digit] as number) + 1;
    }
  };
}

/** The first assignment of the law's variables (in `variables` order) that breaks the law in the magma, or undefined when the law holds. */
export function lawWitness(law: Law, magma: Magma): number[] | undefined {
  return compileLaw(law)(magma);
}

/** Whether the law holds in the magma, for every assignment of its variables. */
export function evaluateLaw(law: Law, magma: Magma): boolean {
  return lawWitness(law, magma) === undefined;
}

/**
 * A key that two laws share when they differ only by the names of their variables or by the order
 * of their two sides: `x * y = y` and `b = a * b` have the same key.
 */
export function lawKey(law: Law): string {
  const oriented = (a: Term, b: Term) => {
    const names = new Map<string, string>();
    const write = (t: Term): string => {
      if (t.kind === "var") {
        if (!names.has(t.name)) names.set(t.name, `v${names.size}`);
        return names.get(t.name) as string;
      }
      return `(${write(t.left)}*${write(t.right)})`;
    };
    return `${write(a)}=${write(b)}`;
  };
  const forward = oriented(law.left, law.right);
  const backward = oriented(law.right, law.left);
  return forward <= backward ? forward : backward;
}
