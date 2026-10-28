import { Rng } from "@seshat/models";

/**
 * Theory exploration (line M13), in the manner of QuickSpec: enumerate the terms over a signature by size, test
 * them on a structure (here the plain data of a battery, or a free structure), group the terms that agree on
 * every test point, and read an equation off each pair of terms in one group. The equations are then reduced to
 * a minimal set: one that follows from the smaller ones kept so far, by rewriting, is dropped. What comes out is a
 * list of conjectures (the tests are finite): each goes to a prover as an `open` claim, none is a theorem.
 */
export interface FunctionSymbol {
  name: string;
  arity: number;
  /** How Lean writes an application: a template with `{0}`, `{1}` for the arguments, such as `({0} * {1})`. A constant: its text. */
  lean: string;
}

export type XTerm = { kind: "var"; name: string } | { kind: "app"; symbol: string; args: XTerm[] };

/** One place to test terms: how to apply the symbols there, and the values of the variables. */
export interface TestPoint<V> {
  env: Readonly<Record<string, V>>;
  /** The value of an application, or undefined where the operation is not defined. */
  apply: (symbol: string, args: readonly V[]) => V | undefined;
}

export interface Structure<V> {
  symbols: readonly FunctionSymbol[];
  variables: readonly string[];
  points: readonly TestPoint<V>[];
  key: (value: V) => string;
}

export interface ExploreOptions {
  /** The most nodes in a term (a variable or a symbol counts one). Default 5. */
  maxSize?: number;
  /** The most representatives kept in all: the cut on the enumeration. Default 4000. */
  maxTerms?: number;
  /** The most equations returned. Default 200. */
  maxLaws?: number;
}

export interface Equation {
  left: XTerm;
  right: XTerm;
  size: number;
  /** The test points the equation held on. */
  points: number;
}

export interface Exploration {
  /** Terms kept (one per class of terms that agree on the test points), and whether the cap cut the enumeration short. */
  terms: number;
  capped: boolean;
  /** Every equation read from the classes, in order of size. */
  equations: Equation[];
  /** The ones that do not follow from the smaller ones kept before them. */
  minimal: Equation[];
}

export const termSize = (t: XTerm): number => (t.kind === "var" ? 1 : 1 + t.args.reduce((n, a) => n + termSize(a), 0));

/** A term as text, with the symbols' templates. */
export function printXTerm(t: XTerm, symbols: readonly FunctionSymbol[]): string {
  if (t.kind === "var") return t.name;
  const symbol = symbols.find((s) => s.name === t.symbol);
  if (symbol === undefined) throw new RangeError(`no symbol ${t.symbol}`);
  return symbol.lean.replace(/\{(\d+)\}/g, (_, i: string) => printXTerm(t.args[Number(i)] as XTerm, symbols));
}

function valueOf<V>(t: XTerm, point: TestPoint<V>): V | undefined {
  if (t.kind === "var") return point.env[t.name];
  const args: V[] = [];
  for (const a of t.args) {
    const v = valueOf(a, point);
    if (v === undefined) return undefined;
    args.push(v);
  }
  return point.apply(t.symbol, args);
}

/** Enumerates the terms of a structure's signature by size and finds the equations that hold on its test points. */
export function explore<V>(structure: Structure<V>, options: ExploreOptions = {}): Exploration {
  const maxSize = options.maxSize ?? 5;
  const maxTerms = options.maxTerms ?? 4000;
  const maxLaws = options.maxLaws ?? 200;
  const fingerprint = (t: XTerm): string | undefined => {
    const parts: string[] = [];
    for (const point of structure.points) {
      const v = valueOf(t, point);
      parts.push(v === undefined ? "~" : structure.key(v));
    }
    return parts.every((p) => p === "~") ? undefined : parts.join("|");
  };
  const bySize: XTerm[][] = [[]];
  const seen = new Map<string, XTerm>();
  const equations: Equation[] = [];
  let kept = 0;
  let capped = false;
  const consider = (t: XTerm, size: number): void => {
    const fp = fingerprint(t);
    if (fp === undefined) return;
    const rep = seen.get(fp);
    if (rep === undefined) {
      seen.set(fp, t);
      (bySize[size] ??= []).push(t);
      kept++;
    } else {
      equations.push({ left: rep, right: t, size: size + termSize(rep), points: structure.points.length });
    }
  };
  for (const v of structure.variables) consider({ kind: "var", name: v }, 1);
  for (const s of structure.symbols.filter((x) => x.arity === 0)) consider({ kind: "app", symbol: s.name, args: [] }, 1);
  for (let size = 2; size <= maxSize && !capped; size++) {
    for (const s of structure.symbols.filter((x) => x.arity > 0)) {
      for (const args of argumentLists(bySize, s.arity, size - 1)) {
        if (kept >= maxTerms) {
          capped = true;
          break;
        }
        consider({ kind: "app", symbol: s.name, args }, size);
      }
      if (capped) break;
    }
  }
  // Smaller first; at one size the more general (more variables) first, so that an instance never shadows its law.
  equations.sort((a, b) => a.size - b.size || equationVariables(b).length - equationVariables(a).length || textOf(a, structure.symbols).localeCompare(textOf(b, structure.symbols)));
  return { terms: kept, capped, equations: equations.slice(0, maxLaws * 20), minimal: minimalLaws(equations, structure.symbols).slice(0, maxLaws) };
}

/** Every list of `arity` representatives whose sizes add up to `total`. */
function* argumentLists(bySize: readonly XTerm[][], arity: number, total: number): Generator<XTerm[]> {
  if (arity === 1) {
    for (const t of bySize[total] ?? []) yield [t];
    return;
  }
  for (let first = 1; first <= total - (arity - 1); first++) {
    for (const head of bySize[first] ?? []) for (const rest of argumentLists(bySize, arity - 1, total - first)) yield [head, ...rest];
  }
}

const textOf = (e: Equation, symbols: readonly FunctionSymbol[]): string => `${printXTerm(e.left, symbols)} = ${printXTerm(e.right, symbols)}`;

// --- Minimal sets: rewriting ---------------------------------------------------------------------------------

type Subst = Map<string, XTerm>;

function match(pattern: XTerm, term: XTerm, subst: Subst): boolean {
  if (pattern.kind === "var") {
    const bound = subst.get(pattern.name);
    if (bound === undefined) {
      subst.set(pattern.name, term);
      return true;
    }
    return same(bound, term);
  }
  if (term.kind !== "app" || term.symbol !== pattern.symbol || term.args.length !== pattern.args.length) return false;
  return pattern.args.every((p, i) => match(p, term.args[i] as XTerm, subst));
}

function same(a: XTerm, b: XTerm): boolean {
  if (a.kind === "var") return b.kind === "var" && a.name === b.name;
  return b.kind === "app" && a.symbol === b.symbol && a.args.length === b.args.length && a.args.every((x, i) => same(x, b.args[i] as XTerm));
}

function substitute(t: XTerm, subst: Subst): XTerm {
  if (t.kind === "var") return subst.get(t.name) ?? t;
  return { kind: "app", symbol: t.symbol, args: t.args.map((a) => substitute(a, subst)) };
}

/** A total order on terms (size, then text) under which a rewrite must go down: it makes rewriting end. */
function smaller(a: XTerm, b: XTerm, symbols: readonly FunctionSymbol[]): boolean {
  const sa = termSize(a);
  const sb = termSize(b);
  return sa !== sb ? sa < sb : printXTerm(a, symbols) < printXTerm(b, symbols);
}

function normalize(t: XTerm, rules: ReadonlyArray<{ from: XTerm; to: XTerm }>, symbols: readonly FunctionSymbol[], budget: { steps: number }): XTerm {
  let current: XTerm = t.kind === "var" ? t : { kind: "app", symbol: t.symbol, args: t.args.map((a) => normalize(a, rules, symbols, budget)) };
  for (let again = true; again && budget.steps > 0; ) {
    again = false;
    for (const rule of rules) {
      const subst: Subst = new Map();
      if (!match(rule.from, current, subst)) continue;
      const next = substitute(rule.to, subst);
      if (!smaller(next, current, symbols)) continue;
      budget.steps--;
      current = next.kind === "var" ? next : { kind: "app", symbol: next.symbol, args: next.args.map((a) => normalize(a, rules, symbols, budget)) };
      again = true;
      break;
    }
  }
  return current;
}

/** The equations, in order, that do not follow from the ones kept before them by rewriting to normal form. */
export function minimalLaws(equations: readonly Equation[], symbols: readonly FunctionSymbol[]): Equation[] {
  const kept: Equation[] = [];
  const rules: Array<{ from: XTerm; to: XTerm }> = [];
  for (const e of equations) {
    if (same(e.left, e.right)) continue;
    const budget = { steps: 200 };
    if (same(normalize(e.left, rules, symbols, budget), normalize(e.right, rules, symbols, budget))) continue;
    kept.push(e);
    rules.push(smaller(e.right, e.left, symbols) ? { from: e.left, to: e.right } : { from: e.right, to: e.left });
  }
  return kept;
}

// --- Structures --------------------------------------------------------------------------------------------

const VARIABLES = ["x", "y", "z"] as const;

/** The natural numbers with 0, 1, + and *, tried on small values and a seeded sample. */
export function natStructure(options: { seed?: number; max?: number; samples?: number; variables?: number } = {}): Structure<number> {
  const rng = new Rng(options.seed ?? 1);
  const max = options.max ?? 4;
  const names = VARIABLES.slice(0, options.variables ?? 3);
  const points: TestPoint<number>[] = [];
  const apply = (symbol: string, args: readonly number[]): number | undefined => {
    const [a, b] = args as [number, number];
    switch (symbol) {
      case "zero": return 0;
      case "one": return 1;
      case "add": return a + b;
      case "mul": return a * b;
      default: return undefined;
    }
  };
  const total = (max + 1) ** names.length;
  const exhaustive = total <= 200;
  for (let i = 0; i < (exhaustive ? total : (options.samples ?? 150)); i++) {
    const env: Record<string, number> = {};
    names.forEach((n, k) => (env[n] = exhaustive ? Math.floor(i / (max + 1) ** k) % (max + 1) : rng.int(max * 3 + 1)));
    points.push({ env, apply });
  }
  return {
    symbols: [
      { name: "zero", arity: 0, lean: "0" },
      { name: "one", arity: 0, lean: "1" },
      { name: "add", arity: 2, lean: "({0} + {1})" },
      { name: "mul", arity: 2, lean: "({0} * {1})" },
    ],
    variables: names,
    points,
    key: String,
  };
}

/** The free monoid on `a`, `b`, `c`: words under concatenation, with the empty word. Laws that hold in it are the monoid laws. */
export function freeMonoidStructure(options: { seed?: number; samples?: number; maxLength?: number } = {}): Structure<string> {
  const rng = new Rng(options.seed ?? 1);
  const letters = ["a", "b", "c"];
  const word = (): string => Array.from({ length: rng.int((options.maxLength ?? 3) + 1) }, () => letters[rng.int(3)]).join("");
  const apply = (symbol: string, args: readonly string[]): string | undefined => (symbol === "empty" ? "" : symbol === "mul" ? (args[0] as string) + (args[1] as string) : undefined);
  const points: TestPoint<string>[] = Array.from({ length: options.samples ?? 120 }, () => ({ env: { x: word(), y: word(), z: word() }, apply }));
  return {
    symbols: [
      { name: "empty", arity: 0, lean: "1" },
      { name: "mul", arity: 2, lean: "({0} * {1})" },
    ],
    variables: VARIABLES,
    points,
    key: (w) => `"${w}"`,
  };
}

/** A magma: its size and row-major table. */
export interface MagmaModel {
  size: number;
  table: readonly number[];
}

/** The magmas given, with the operation `*`: all the assignments of the variables for a small magma, a sample for a larger one. */
export function magmaStructure(models: readonly MagmaModel[], options: { seed?: number; perModel?: number; symbol?: string } = {}): Structure<number> {
  const rng = new Rng(options.seed ?? 1);
  const symbol = options.symbol ?? "*";
  const points: TestPoint<number>[] = [];
  for (const m of models) {
    const apply = (name: string, args: readonly number[]): number | undefined => (name === "mul" ? m.table[(args[0] as number) * m.size + (args[1] as number)] : undefined);
    const all = m.size ** VARIABLES.length;
    const count = all <= (options.perModel ?? 27) ? all : (options.perModel ?? 27);
    for (let i = 0; i < count; i++) {
      const env: Record<string, number> = {};
      VARIABLES.forEach((n, k) => (env[n] = count === all ? Math.floor(i / m.size ** k) % m.size : rng.int(m.size)));
      points.push({ env, apply });
    }
  }
  return { symbols: [{ name: "mul", arity: 2, lean: `({0} ${symbol} {1})` }], variables: VARIABLES, points, key: String };
}

/** The variables of an equation in order of first appearance, left side first. */
export function equationVariables(e: Equation): string[] {
  const out: string[] = [];
  const walk = (t: XTerm): void => {
    if (t.kind === "var") {
      if (!out.includes(t.name)) out.push(t.name);
    } else t.args.forEach(walk);
  };
  walk(e.left);
  walk(e.right);
  return out;
}

/** An equation as text, without outer parentheses on its sides. */
export function printEquation(e: Equation, symbols: readonly FunctionSymbol[]): string {
  const strip = (s: string): string => (s.startsWith("(") && s.endsWith(")") && balanced(s.slice(1, -1)) ? s.slice(1, -1) : s);
  return `${strip(printXTerm(e.left, symbols))} = ${strip(printXTerm(e.right, symbols))}`;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
