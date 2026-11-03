import { parseStatement, type Statement, type Term, Unreadable } from "./parse.ts";

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
export function routeStatement(statementText: string): Route {
  let statement: Statement;
  try {
    statement = parseStatement(statementText);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { domains: ["general"], tactics: [...DOMAIN_TACTICS.general], unreadable: error.message };
  }
  return routeFeatures(featuresOf(statement));
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
