import { maskCommentsAndStrings } from "@seshat/core";
import { MAX_STATEMENT, parseStatement, type Statement, type Term, Unreadable } from "./parse.ts";

/**
 * The domain router (plan §15, step 3): a cheap syntactic analysis of a goal that says which
 * decidable fragment it lies in, and so which decision procedure to try first. It reads the
 * statement only; it proves nothing, and a wrong guess costs one failed try, which the posteriors
 * of the battery learn from.
 */
export const DOMAINS = ["closed", "presburger", "linear_real", "finite", "polynomial_identity", "nonlinear_arith", "bitvector", "propositional", "first_order", "general"] as const;
export type Domain = (typeof DOMAINS)[number];

/** What the router saw in the goal. */
export interface Features {
  /** The sorts of the variables (`ℕ`, `ℝ`, `Fin 5`, `M`...). */
  sorts: string[];
  /** The goal and its hypotheses mention no variable. */
  closed: boolean;
  /** The binders have hypotheses (`(h : a < b)`). */
  hypotheses: number;
  /** Operators and relations used. */
  operators: string[];
  /** A product of two terms that both contain a variable, or a power with a variable base or exponent. */
  nonlinear: boolean;
  /** A division or modulo by something that is not a numeral. */
  divides: boolean;
  /** A function symbol applied to arguments (`f x`) or an operation of a type class on a non-number sort. */
  uninterpreted: boolean;
  quantifiers: boolean;
  /** The conclusion is an equation, an order, a divisibility, or a connective of those. */
  conclusion: "equation" | "order" | "propositional" | "other";
  /** A hypothesis is an equation (so a Gröbner-style tactic may use it). */
  equationHypotheses: boolean;
}

export interface Route {
  /** The domains the goal lies in, the most specific first. `general` when none fits. */
  domains: Domain[];
  /** The tactics the domains send the goal to, decision procedures first, without repeats. */
  tactics: string[];
  features?: Features;
  /** Why the router could not read the goal, when it could not. */
  unreadable?: string;
  /** The exploration moves the goal's syntax calls for (plan change CX1, `movesOf`); `routeStatement` always sets it. */
  moves?: Move[];
}

const NUMBER_SORTS = new Set(["ℕ", "ℤ", "ℝ", "ℚ", "ℂ"]);
const INT_SORTS = new Set(["ℕ", "ℤ"]);
const REAL_SORTS = new Set(["ℝ", "ℚ"]);
const RELATIONS = new Set(["=", "≠", "<", ">", "≤", "≥", "∣"]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "^", "neg"]);
const CONNECTIVES = new Set(["∧", "∨", "¬", "→", "↔"]);

/** The most elements of a finite sort or a bounded domain the router sends to `decide`. */
export const FINITE_LIMIT = 64;

const isNumeral = (t: Term): boolean => t.k === "num" || (t.k === "app" && t.fn === "neg" && t.args.length === 1 && isNumeral(t.args[0] as Term));

function hasVariable(t: Term, vars: ReadonlySet<string>): boolean {
  switch (t.k) {
    case "var":
      return vars.has(t.name);
    case "app":
      return (!t.op && vars.has(t.fn)) || t.args.some((a) => hasVariable(a, vars));
    case "quant":
      return hasVariable(t.body, vars) || t.vars.length > 0;
    default:
      return false;
  }
}

/** Reads the features of a statement. */
export function featuresOf(statement: Statement): Features {
  const sortOf = new Map<string, string>();
  const sorts = new Set<string>();
  const terms: Term[] = [];
  let hypotheses = 0;
  let uninterpreted = false;
  let equationHypotheses = false;
  for (const b of statement.binders) {
    if (b.kind === "var") {
      sortOf.set(b.name, b.type);
      sorts.add(b.type);
      if (b.type.includes("→")) uninterpreted = true;
    } else if (b.kind === "hyp") {
      hypotheses++;
      terms.push(b.prop);
      if (b.prop.k === "app" && b.prop.fn === "=") equationHypotheses = true;
    } else if (!NUMBER_SORTS.has(b.arg)) {
      uninterpreted = true;
    }
  }
  terms.push(statement.conclusion);
  const bound = new Set<string>();
  const variables = new Set<string>(sortOf.keys());
  const operators = new Set<string>();
  let nonlinear = false;
  let divides = false;
  let quantifiers = false;

  const visit = (t: Term): void => {
    switch (t.k) {
      case "app":
        if (t.op) {
          operators.add(t.fn);
          const [a, b] = t.args;
          if (t.fn === "*" && a !== undefined && b !== undefined && !isNumeral(a) && !isNumeral(b) && hasVariable(a, variables) && hasVariable(b, variables)) nonlinear = true;
          if (t.fn === "^" && a !== undefined && b !== undefined && (!isNumeral(b) || hasVariable(a, variables)) && (hasVariable(a, variables) || hasVariable(b, variables))) nonlinear = true;
          if ((t.fn === "/" || t.fn === "%" || t.fn === "∣") && b !== undefined && t.fn !== "∣" && !isNumeral(b)) divides = true;
          if (t.fn === "∣" && a !== undefined && !isNumeral(a)) divides = true;
        } else {
          uninterpreted = true;
        }
        t.args.forEach(visit);
        break;
      case "quant":
        quantifiers = true;
        for (const v of t.vars) {
          bound.add(v.name);
          variables.add(v.name);
          if (v.type !== undefined) {
            sortOf.set(v.name, v.type);
            sorts.add(v.type);
          }
        }
        visit(t.body);
        break;
      default:
    }
  };
  terms.forEach(visit);

  const c = statement.conclusion;
  let conclusion: Features["conclusion"] = "other";
  const kindOf = (t: Term): Features["conclusion"] => {
    if (t.k === "app" && t.op) {
      if (t.fn === "=") return "equation";
      if (RELATIONS.has(t.fn)) return "order";
      if (CONNECTIVES.has(t.fn)) {
        const parts = t.args.map(kindOf);
        if (parts.every((p) => p === "equation")) return "equation";
        return parts.every((p) => p === "equation" || p === "order") ? "order" : "propositional";
      }
    }
    if (t.k === "lit") return "propositional";
    return "other";
  };
  conclusion = kindOf(c);
  if (c.k === "var" || (c.k === "app" && !c.op)) conclusion = "other";

  return {
    sorts: [...sorts],
    closed: variables.size === 0 && bound.size === 0 && !uninterpreted,
    hypotheses,
    operators: [...operators],
    nonlinear,
    divides,
    uninterpreted,
    quantifiers,
    conclusion,
    equationHypotheses,
  };
}

function finiteSort(sort: string): boolean {
  if (sort === "Bool") return true;
  const m = /^Fin (\d+)$/u.exec(sort);
  return m !== null && Number(m[1]) <= FINITE_LIMIT;
}

/** Domains and tactics, per domain: decision procedures first, and `general` last. */
export const DOMAIN_TACTICS: Readonly<Record<Domain, readonly string[]>> = {
  closed: ["decide", "norm_num", "simp"],
  presburger: ["omega", "simp", "norm_num", "decide", "grind"],
  linear_real: ["linarith", "norm_num", "positivity", "grind", "simp"],
  finite: ["decide", "simp", "omega", "grind"],
  polynomial_identity: ["ring", "grind", "norm_num", "simp", "nlinarith", "polyrith"],
  nonlinear_arith: ["nlinarith", "positivity", "linarith", "norm_num", "grind", "polyrith"],
  bitvector: ["bv_decide", "omega", "decide", "simp"],
  propositional: ["simp", "aesop", "grind", "decide"],
  first_order: ["aesop", "grind", "simp", "hammer", "canonical", "exact?"],
  general: ["simp", "aesop", "grind", "norm_num", "exact?", "hammer", "canonical"],
};

/**
 * Routes a statement in signature form. Without a reading the answer is `general`, with the
 * reason: a goal the router cannot read still gets the whole battery.
 */
export function routeStatement(statementText: string): Route & { moves: Move[] } {
  let features: Features;
  try {
    features = featuresOf(parseStatement(statementText));
  } catch (error) {
    if (!(error instanceof Unreadable) && !(error instanceof RangeError)) throw error;
    return { domains: ["general"], tactics: [...DOMAIN_TACTICS.general], unreadable: error.message, moves: movesOf(statementText) };
  }
  return { ...routeFeatures(features), moves: movesOf(statementText, features) };
}

export function routeFeatures(f: Features): Route {
  const domains: Domain[] = [];
  const sorts = f.sorts;
  const numeric = sorts.length > 0 && sorts.every((s) => NUMBER_SORTS.has(s));
  const integers = numeric && sorts.every((s) => INT_SORTS.has(s));
  const reals = numeric && sorts.every((s) => REAL_SORTS.has(s));
  const mixedOk = numeric && sorts.every((s) => INT_SORTS.has(s) || REAL_SORTS.has(s));
  const relational = f.conclusion === "order" || f.conclusion === "equation" || f.conclusion === "propositional";
  const arithmeticOnly = f.operators.every((o) => ARITHMETIC.has(o) || RELATIONS.has(o) || CONNECTIVES.has(o));

  if (f.closed && arithmeticOnly && relational) domains.push("closed");
  if (!f.uninterpreted && sorts.length > 0 && sorts.every((s) => finiteSort(s) || NUMBER_SORTS.has(s)) && sorts.some(finiteSort) && !f.nonlinear) domains.push("finite");
  if (integers && !f.nonlinear && !f.divides && arithmeticOnly && !f.uninterpreted && relational) domains.push("presburger");
  if (reals && !f.nonlinear && !f.divides && arithmeticOnly && !f.uninterpreted && relational && !f.operators.includes("%") && !f.operators.includes("∣")) domains.push("linear_real");
  if (mixedOk && f.nonlinear && !f.uninterpreted && arithmeticOnly) {
    if (f.conclusion === "equation" && f.hypotheses === 0 && !f.divides) domains.push("polynomial_identity");
    else if (f.conclusion === "equation" && f.equationHypotheses && !f.divides) domains.push("polynomial_identity", "nonlinear_arith");
    else if (f.conclusion === "order") domains.push("nonlinear_arith");
  } else if (mixedOk && f.nonlinear === false && f.conclusion === "equation" && f.operators.includes("^") && !f.uninterpreted) {
    domains.push("polynomial_identity");
  }
  if (sorts.length > 0 && sorts.every((s) => s === "Prop" || s === "Bool") && f.conclusion === "propositional") domains.push("propositional");
  if (f.uninterpreted || (sorts.some((s) => !NUMBER_SORTS.has(s) && !finiteSort(s) && s !== "Prop") && !numeric)) domains.push("first_order");
  if (domains.length === 0) domains.push("general");

  const tactics: string[] = [];
  for (const d of domains) for (const t of DOMAIN_TACTICS[d]) if (!tactics.includes(t)) tactics.push(t);
  // The search tactics every goal may need come after the procedures of its domains.
  if (!domains.includes("general")) for (const t of DOMAIN_TACTICS.general) if (!tactics.includes(t)) tactics.push(t);
  return { domains, tactics, features: f };
}

/** The domain a result is filed under: the router's most specific one. */
export const primaryDomain = (route: Route): Domain => route.domains[0] ?? "general";

// --- Exploration moves (plan change CX1) --------------------------------------------------------

/**
 * The twelve exploration moves of plan change CX1 (`plans/plan-change-cpu-exploration.md`): the
 * recurring steps of a search that has no useful derivative, each with the CPU tools that serve it.
 * The router tags a goal with the moves its syntax calls for, beside its domains; the tags order
 * which tools to build and try first, and prove nothing.
 */
export const MOVES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12"] as const;
export type Move = (typeof MOVES)[number];

export const MOVE_NAMES: Readonly<Record<Move, string>> = {
  E1: "small cases up to isomorphism",
  E2: "a witness or construction",
  E3: "a counterexample",
  E4: "a closed form, recurrence or relation",
  E5: "an invariant or monovariant",
  E6: "a certificate of a bound or an impossibility",
  E7: "a change of representation",
  E8: "a split into cases",
  E9: "an extremal object",
  E10: "a rewrite sequence or proof path",
  E11: "an intermediate lemma",
  E12: "growth or asymptotics",
};

/** The longest text `movesOf` reads; a longer one gets no moves (the reader's own limit is far smaller). */
const MAX_MOVES_TEXT = 4 * MAX_STATEMENT;

type Tok = { k: "id" | "num" | "sym"; v: string };

/** A lexer that never throws: identifiers (dotted names whole), numerals, and one symbol per code point, `∀ᶠ`, `∃ᵉ`, `∃!`, `<|` and `|>` kept together. */
function lex(text: string): Tok[] {
  const out: Tok[] = [];
  const word = /[\p{L}_][\p{L}\p{N}_'₀-₉]*(?:\.[\p{L}_][\p{L}\p{N}_'₀-₉]*)*/uy;
  const digits = /\d+(?:\.\d+)?/y;
  let i = 0;
  while (i < text.length) {
    const c = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(c);
    if (/\s/u.test(ch)) {
      i += ch.length;
      continue;
    }
    digits.lastIndex = i;
    const n = digits.exec(text);
    if (n !== null) {
      out.push({ k: "num", v: n[0] });
      i += n[0].length;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === "<|" || pair === "|>") {
      out.push({ k: "sym", v: pair });
      i += 2;
      continue;
    }
    if (ch === "∀" || ch === "∃") {
      const next = text[i + 1];
      const joined = next === "ᶠ" || next === "ᵉ" || next === "!" ? ch + next : ch;
      out.push({ k: "sym", v: joined });
      i += joined.length;
      continue;
    }
    word.lastIndex = i;
    const w = word.exec(text);
    if (w !== null) {
      out.push({ k: "id", v: w[0] });
      i += w[0].length;
      continue;
    }
    out.push({ k: "sym", v: ch });
    i += ch.length;
  }
  return out;
}

const OPEN = new Set(["(", "[", "{", "⟨", "⦃"]);
const CLOSE = new Set([")", "]", "}", "⟩", "⦄"]);
const ORDER = new Set(["≤", "<", "≥", ">"]);
const PROP_SYMBOLS = new Set(["=", "≠", "<", ">", "≤", "≥", "∣", "∈", "∉", "⊆", "↔", "∧", "∨", "¬", "∀", "∃", "∀ᶠ", "∃ᶠ", "∃ᵉ", "∃!"]);
const SEPARATORS = new Set(["∧", "∨", "→", "↔", ",", "¬"]);
const BINDERS = new Set(["∀", "∃", "∃ᵉ", "∃!", "∀ᶠ", "∃ᶠ", "fun", "λ", "∑", "∏", "⨅", "⨆"]);
/** Names a statement uses that are Lean's or Mathlib's, not a quantity the statement names. */
const KNOWN = new Set([
  "Fin", "Finset", "Set", "Filter", "Icc", "Ico", "Ioc", "Ioo", "Iic", "Iio", "Ici", "Ioi", "Irrational", "Prime", "Odd", "Even", "Squarefree", "Tendsto",
  "Monotone", "StrictMono", "Antitone", "StrictAnti", "Summable", "Nonempty", "Infinite", "Finite", "Disjoint", "Transcendental", "Type", "Prop", "Sort",
  "True", "False", "X", "Real", "Nat", "Int", "Rat", "Complex", "ZMod", "Fintype", "SimpleGraph", "Group", "Function", "ℕ", "ℤ", "ℚ", "ℝ", "ℂ", "𝓝",
]);
/** Structures whose small instances can be listed up to isomorphism (E1). */
const STRUCTURES = new Set(["SimpleGraph", "Magma", "Fintype", "Finpartition", "Sym2", "Group", "CommGroup", "Monoid", "CommMonoid", "Semigroup", "AddGroup", "AddCommGroup", "Lattice"]);
const ASYMPTOTIC = ["atTop", "AtTop", "atBot", "=O[", "=o[", "=Θ[", "=Ω[", "~[", "≪", "≫", "Tendsto", "limsup", "liminf", "∀ᶠ", "∃ᶠ", "cofinite", "𝓝", "ensity", "IsBigO", "IsLittleO", "IsEquivalent"];
const EXTREMAL = /^(?:IsLeast|IsGreatest|sSup|sInf|iSup|iInf)$|[Mm]ax|[Mm]in(?:imal|imum)?(?:$|[A-Z])|Largest|Longest|Smallest|Least|Greatest|chromatic/u;
const ARITHMETIC_SYMBOLS = new Set(["^", "*", "!", "∏", "∑", "∣", "%", "+", "-"]);
const CLOSED_NUMERIC = new Set(["^", "*", "+", "-", "/", "!", "(", ")"]);

/** A name that may stand for a quantity the statement names without defining it (`F`, `W`, `N₀`, `LongestSnakeInTheBox`). */
function quantityLike(name: string): boolean {
  if (name.includes(".") || KNOWN.has(name) || /^(?:Is|Has)\p{Lu}/u.test(name)) return false;
  return /^\p{Lu}/u.test(name) || /^\p{L}[₀-₉']*$/u.test(name);
}

const isHypothesisType = (type: Tok[]): boolean => type.some((t) => t.k === "sym" && PROP_SYMBOLS.has(t.v));
const joined = (ts: readonly Tok[]): string => ts.map((t) => t.v).join(" ");

/** The index just after the bracket that closes the one at `open`, or the end. */
function closing(ts: readonly Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < ts.length; i++) {
    const v = (ts[i] as Tok).v;
    if (OPEN.has(v)) depth++;
    else if (CLOSE.has(v) && --depth === 0) return i + 1;
  }
  return ts.length;
}

/** The names a group of binder tokens declares (`x y : T`, `(a b : T)`, `x > 0`, `x ∈ S`), with their types when written. */
function declare(group: readonly Tok[], into: Map<string, string>): void {
  let i = 0;
  const names: string[] = [];
  while (i < group.length) {
    const t = group[i] as Tok;
    if (t.v === "[") {
      i = closing(group, i);
      continue;
    }
    if (t.v === "(" || t.v === "{" || t.v === "⦃") {
      const end = closing(group, i);
      const inner = group.slice(i + 1, end - 1);
      const colon = inner.findIndex((x) => x.v === ":");
      const named = (colon < 0 ? inner : inner.slice(0, colon)).filter((x) => x.k === "id" && x.v !== "_");
      const type = colon < 0 ? "" : joined(inner.slice(colon + 1));
      for (const n of named) if (!into.has(n.v)) into.set(n.v, type);
      i = end;
      continue;
    }
    if (t.v === ":" || t.v === "∈" || t.v === "in" || ORDER.has(t.v) || t.v === "≠" || t.v === "⊆" || t.v === "|") {
      const type = t.v === ":" ? joined(group.slice(i + 1)) : "";
      for (const n of names) if (!into.has(n)) into.set(n, type);
      return;
    }
    if (t.k === "id" && t.v !== "_") names.push(t.v);
    i++;
  }
  for (const n of names) if (!into.has(n)) into.set(n, "");
}

interface Signature {
  /** The variables of the binders (hypotheses left out), with their types. */
  variables: Map<string, string>;
  /** Every name the statement binds: the binders' variables and the names under its quantifiers, lambdas, big operators and set-builders. */
  declared: Map<string, string>;
  /** The tokens after the signature's colon, without a leading `answer(...) ↔`. */
  conclusion: Tok[];
  all: Tok[];
}

function signatureOf(text: string): Signature {
  const all = lex(text);
  let split = -1;
  for (let i = 0, depth = 0; i < all.length; i++) {
    const v = (all[i] as Tok).v;
    if (OPEN.has(v)) depth++;
    else if (CLOSE.has(v)) depth--;
    else if (v === ":" && depth === 0 && all[i + 1]?.v !== "=") {
      split = i;
      break;
    }
  }
  const binders = split < 0 ? [] : all.slice(0, split);
  let conclusion = all.slice(split + 1);
  if (conclusion[0]?.v === "answer" && conclusion[1]?.v === "(" && conclusion[3]?.v === ")" && conclusion[4]?.v === "↔") conclusion = conclusion.slice(5);
  const variables = new Map<string, string>();
  for (let i = 0; i < binders.length; ) {
    const t = binders[i] as Tok;
    if (!OPEN.has(t.v)) {
      i++;
      continue;
    }
    const end = closing(binders, i);
    const inner = binders.slice(i + 1, end - 1);
    const colon = inner.findIndex((x) => x.v === ":");
    if (t.v !== "[" && colon > 0) {
      const names = inner.slice(0, colon).filter((x) => x.k === "id" && x.v !== "_").map((x) => x.v);
      const type = inner.slice(colon + 1);
      const hypothesis = names.every((n) => /^[hH]/u.test(n)) || isHypothesisType(type);
      if (!hypothesis && !/^(?:Type|Sort|Prop)\b/u.test(joined(type))) for (const n of names) variables.set(n, joined(type));
    }
    i = end;
  }
  const declared = new Map(variables);
  for (let i = 0; i < all.length; i++) {
    const t = all[i] as Tok;
    if (t.v === "{") {
      // A set-builder `{x | ...}` or `{(n : ℕ) | ...}`; a set literal `{1, 2}` declares nothing.
      let depth = 0;
      for (let j = i + 1; j < all.length && j < i + 60; j++) {
        const v = (all[j] as Tok).v;
        if (OPEN.has(v)) depth++;
        else if (CLOSE.has(v) && depth-- === 0) break;
        else if (v === "|" && depth === 0) {
          declare(all.slice(i + 1, j), declared);
          break;
        }
      }
      continue;
    }
    if (!(BINDERS.has(t.v) || t.v === "∑'" || t.v === "∏'")) continue;
    const stops = t.v === "∀ᶠ" || t.v === "∃ᶠ" ? new Set(["in"]) : new Set([",", "↦", "=>"]);
    let depth = 0;
    let j = i + 1;
    for (; j < all.length && j < i + 200; j++) {
      const v = (all[j] as Tok).v;
      if (OPEN.has(v)) depth++;
      else if (CLOSE.has(v)) {
        if (depth-- === 0) break;
      } else if (depth === 0 && stops.has(v)) break;
    }
    declare(all.slice(i + 1, j), declared);
  }
  return { variables, declared, conclusion, all };
}

/** Splits tokens into atoms at connectives and commas. */
function atoms(ts: readonly Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  for (const t of ts) {
    if (t.k === "sym" && SEPARATORS.has(t.v)) out.push([]);
    else (out[out.length - 1] as Tok[]).push(t);
  }
  return out.filter((a) => a.length > 0);
}

/** What comes after the last top-level `→` or `,` of a conclusion: the claim its quantifiers and premises lead to. */
function consequent(ts: readonly Tok[]): Tok[] {
  let from = 0;
  for (let i = 0, depth = 0; i < ts.length; i++) {
    const v = (ts[i] as Tok).v;
    if (OPEN.has(v)) depth++;
    else if (CLOSE.has(v)) depth--;
    else if (depth === 0 && (v === "→" || v === ",")) from = i + 1;
  }
  return ts.slice(from);
}

const integerSort = (type: string | undefined): boolean => type === "ℕ" || type === "ℤ";

/**
 * The exploration moves a statement's syntax calls for (plan change CX1), in the order E1 to E12.
 * Read from the text (comments and strings masked), so that a statement the reader cannot read still
 * gets its moves, and from the router's features when it could read it. A guess from syntax: E7, E10
 * and E11 have no syntactic signal and are never tagged. Documented in documentation/classical.md.
 */
export function movesOf(statementText: string, features?: Features): Move[] {
  if (statementText.length > MAX_MOVES_TEXT) return [];
  const text = maskCommentsAndStrings(statementText);
  const { variables, declared, conclusion, all } = signatureOf(text);
  const found = new Set<Move>();
  const asymptotic = ASYMPTOTIC.some((s) => text.includes(s));
  /** Whether the quantifier at `i` is negated: `¬ ∀`, `¬ (∀`, `¬ ∃`, `¬ (∃`. */
  const negated = (ts: readonly Tok[], i: number): boolean => ts[i - 1]?.v === "¬" || (ts[i - 1]?.v === "(" && ts[i - 2]?.v === "¬");
  /** An existential that is negated says there is none: an impossibility, not something to exhibit (`¬ ∃!` is not one). */
  const noneExists = (ts: readonly Tok[], i: number): boolean => (ts[i]?.v === "∃" || ts[i]?.v === "∃ᵉ") && negated(ts, i);

  // E1: a class of finite structures (graphs, groups, magmas, finite sets).
  if (all.some((t) => t.k === "id" && STRUCTURES.has(t.v)) || [...declared.values()].some((type) => /^Finset\b/u.test(type))) found.add("E1");

  // E2: something to exhibit.
  if (conclusion.some((t, i) => ((t.v === "∃" || t.v === "∃ᵉ") && !noneExists(conclusion, i)) || t.v === "∃!" || (t.v === "∀" && negated(conclusion, i)))) found.add("E2");
  if (conclusion.some((t) => t.k === "id" && (/\.Nonempty$/u.test(t.v) || t.v === "IsLeast" || t.v === "IsGreatest"))) found.add("E2");

  // E3: a universal claim over instances one can enumerate or sample, unless it holds only eventually.
  const universal = variables.size > 0 || conclusion.some((t, i) => (t.v === "∀" || t.v === "∀ᵉ") && !negated(conclusion, i));
  if (universal && !asymptotic) found.add("E3");

  // E4: a sequence.
  if ([...declared.values()].some((type) => /^(?:ℕ \+|ℕ|ℤ) →/u.test(type))) found.add("E4");
  if (all.some((t) => t.k === "id" && /^(?:StrictMono|Monotone|StrictAnti|Antitone)$/u.test(t.v))) found.add("E4");
  if (conclusion.some((t) => t.v === "∑" || t.v === "∏") && conclusion.some((t) => t.v === "=") && [...variables.values()].some(integerSort)) found.add("E4");

  // E5: an iteration.
  if (text.includes("^[") || all.some((t) => t.k === "id" && /(?:^|\.)iterate$/u.test(t.v))) found.add("E5");

  // E6: a polynomial inequality, an integer equation, or an impossibility over arithmetic.
  if (features !== undefined) {
    const numeric = features.sorts.length > 0 && features.sorts.every((s) => NUMBER_SORTS.has(s));
    const integers = numeric && features.sorts.every((s) => INT_SORTS.has(s));
    if (numeric && features.nonlinear && features.conclusion === "order" && !features.uninterpreted) found.add("E6").add("E3");
    if (integers && features.nonlinear && features.equationHypotheses) found.add("E6");
  }
  const last = consequent(conclusion);
  // `¬ ∃ xs, P` is read whole: its consequent (after the last comma) is P, without the negation.
  const impossible = (last[0]?.v === "¬" && last[1]?.v !== "∀") || last.some((t) => t.v === "≠" || t.v === "∉") || conclusion.some((_, i) => noneExists(conclusion, i));
  if (impossible && conclusion.some((t) => ARITHMETIC_SYMBOLS.has(t.v))) found.add("E6");

  // E8: a variable bounded by a numeral in a hypothesis, or ranging over a small `Fin n`.
  if ([...declared.values()].some((type) => /^Fin \d+$/u.test(type))) found.add("E8");
  for (let i = 1; i < all.length && !found.has("E8"); i++) {
    const t = all[i] as Tok;
    if (!(t.v === "<" || t.v === "≤") || (all[i - 1] as Tok).k !== "id") continue;
    let depth = 0;
    let numerals = 0;
    let j = i + 1;
    for (; j < all.length; j++) {
      const x = all[j] as Tok;
      if (x.k === "num") numerals++;
      else if (x.v === "(") depth++;
      else if (x.v === ")" && depth > 0) depth--;
      else if (!CLOSED_NUMERIC.has(x.v)) break;
      else if (x.v === ")") break;
    }
    const end = all[j]?.v;
    if (numerals > 0 && depth === 0 && (end === ")" || end === "→")) found.add("E8");
  }

  // E9: an extremal quantity, named, bounded, or pinned to a value.
  if (all.some((t) => (t.k === "id" && EXTREMAL.test(t.v)) || t.v === "⨅" || t.v === "⨆")) found.add("E9");
  for (const atom of atoms(conclusion)) {
    const rel = atom.findIndex((t) => ORDER.has(t.v) || t.v === "=");
    if (rel < 0) continue;
    const ids = atom.filter((t) => t.k === "id");
    const applied = atom.some((t, i) => t.k === "id" && quantityLike(t.v) && !declared.has(t.v) && (atom[i + 1]?.k === "id" || atom[i + 1]?.k === "num" || atom[i + 1]?.v === "("));
    if (ORDER.has((atom[rel] as Tok).v) && applied) found.add("E9");
    // A quantity at numerals against a numeral (`W 3 6 = 32`, `190 ≤ L 9`): an equality or a lower bound also asks for a construction.
    if (ids.length > 0 && ids.every((t) => quantityLike(t.v) && !declared.has(t.v)) && atom.some((t) => t.k === "num") && atom.every((t) => t.k !== "sym" || t.v === (atom[rel] as Tok).v || t.v === "(" || t.v === ")")) {
      found.add("E9");
      const v = (atom[rel] as Tok).v;
      const quantityLeft = atom.slice(0, rel).some((t) => t.k === "id");
      if (v === "=" || ((v === "≤" || v === "<") && !quantityLeft) || ((v === "≥" || v === ">") && quantityLeft)) found.add("E2");
    }
    // A named function of an integer variable, compared with an expression: its values form a sequence (E4).
    if (atom.some((t, i) => t.k === "id" && quantityLike(t.v) && !declared.has(t.v) && atom[i + 1]?.k === "id" && integerSort(declared.get((atom[i + 1] as Tok).v)))) found.add("E4");
  }

  // E12: growth, limits, densities, eventual statements.
  if (asymptotic) found.add("E12");

  return MOVES.filter((m) => found.has(m));
}
