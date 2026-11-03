import { parseStatement, type Statement, type Term, Unreadable } from "./parse.ts";

/**
 * Translation of Lean goals to SMT-LIB and TPTP (plan §15, step 5). The fragment, documented in
 * documentation/classical.md:
 *
 * - variables of `ℕ`, `ℤ`, `ℝ`, `ℚ` (`ℚ` is read as a real, `ℕ` as an integer with a sign
 *   constraint), `Prop` variables, and abstract types `(M : Type*)` with the operations of their
 *   instance binders (`[Mul M]`, `[Add M]`) and function or predicate variables between those sorts;
 * - `+ - * / % ^ neg`, with `^` by a numeral up to 8, `/` of reals by a nonzero numeral, `∣` by a
 *   numeral, truncated subtraction on `ℕ`;
 * - `= ≠ < ≤ > ≥`, `∧ ∨ ¬ → ↔`, `True`, `False`, `∀`/`∃` over typed variables;
 * - hypotheses as assumptions and premises (lemma statements) as closed universal assertions.
 *
 * Anything else (sets, `Finset`, sums, casts, named lemmas inside a term, bounded quantifiers) is
 * outside the fragment, and the translation says why. A translation is not a proof: its answers are
 * candidates until Lean reconstructs them.
 */
export class Outside extends Error {}

export type Ty = "Int" | "Real" | "Prop" | { sort: string };
const isUninterpreted = (t: Ty): t is { sort: string } => typeof t === "object";
const tyKey = (t: Ty): string => (typeof t === "string" ? t : t.sort);

export type IR =
  | { k: "lit"; v: string; ty: "Int" | "Real" }
  | { k: "var"; name: string; ty: Ty }
  | { k: "op"; op: "add" | "sub" | "mul" | "div" | "mod" | "neg" | "pow"; args: IR[]; ty: Ty; nat?: boolean }
  | { k: "app"; fn: string; args: IR[]; ty: Ty }
  | { k: "rel"; op: "=" | "≠" | "<" | "≤" | ">" | "≥" | "dvd"; args: IR[] }
  | { k: "conn"; op: "and" | "or" | "not" | "imp" | "iff"; args: IR[] }
  | { k: "quant"; q: "all" | "ex"; vars: Array<{ name: string; ty: Ty }>; body: IR }
  | { k: "bool"; v: boolean };

/** A symbol the problem declares. */
export interface FunDecl {
  name: string;
  args: Ty[];
  ret: Ty;
}

export interface Assertion {
  /** The name in the solver's input, which the unsat core and the proof report. */
  name: string;
  kind: "hypothesis" | "premise" | "domain" | "goal";
  /** The Lean name: the hypothesis or the lemma. */
  lean: string;
  formula: IR;
}

export interface Problem {
  sorts: string[];
  consts: Array<{ name: string; ty: Ty }>;
  funs: FunDecl[];
  assertions: Assertion[];
}

export interface PremiseInput {
  name: string;
  /** The lemma's statement in signature form. */
  statement: string;
}

interface Env {
  vars: Map<string, Ty>;
  funs: Map<string, { args: Ty[]; ret: Ty }>;
  /** Instance operations on uninterpreted sorts: `add_M`, `mul_M`. */
  ops: Map<string, string>;
  /** The variables of `ℕ`, whose subtraction truncates. */
  nat: Set<string>;
}

const NUMBER_TY: Readonly<Record<string, Ty>> = { ℕ: "Int", ℤ: "Int", ℝ: "Real", ℚ: "Real" };
const OP_FOR_CLASS: Readonly<Record<string, { symbol: string; op: string }>> = { Mul: { symbol: "*", op: "mul" }, Add: { symbol: "+", op: "add" }, Sub: { symbol: "-", op: "sub" }, Div: { symbol: "/", op: "div" } };

/**
 * Lowers a goal and its premises to a problem: the hypotheses and the premises as assertions, and
 * the goal as the last one (a solver then refutes its negation). Throws `Outside` with the reason.
 */
export function lower(goal: string, premises: readonly PremiseInput[] = []): Problem {
  let statement: Statement;
  try {
    statement = parseStatement(goal);
  } catch (error) {
    if (error instanceof Unreadable) throw new Outside(error.message);
    throw error;
  }
  const problem: Problem = { sorts: [], consts: [], funs: [], assertions: [] };
  const env: Env = { vars: new Map(), funs: new Map(), ops: new Map(), nat: new Set() };
  const natVars = new Set<string>();

  const declareSort = (sort: string): void => {
    if (!problem.sorts.includes(sort)) problem.sorts.push(sort);
  };
  // Pass 1: the variables and instances, so that hypotheses can mention variables declared after them.
  for (const b of statement.binders) {
    if (b.kind === "var") {
      if (/^Type/u.test(b.type)) {
        declareSort(b.name);
        continue;
      }
      declare(b.name, b.type);
    } else if (b.kind === "inst") {
      const spec = OP_FOR_CLASS[b.cls];
      if (spec !== undefined && !(b.arg in NUMBER_TY)) env.ops.set(`${spec.symbol}\u0000${b.arg}`, `${spec.op}_${b.arg}`);
      else if (!(b.arg in NUMBER_TY)) throw new Outside(`the instance ${b.text}`);
    }
  }

  function declare(name: string, type: string): void {
    const parts = type.split(/\s*→\s*/u);
    const tys = parts.map((p) => tyOf(p, problem));
    if (tys.length === 1) {
      const ty = tys[0] as Ty;
      env.vars.set(name, ty);
      problem.consts.push({ name, ty });
      if (type === "ℕ") {
        natVars.add(name);
        env.nat.add(name);
      }
    } else {
      const ret = tys[tys.length - 1] as Ty;
      const args = tys.slice(0, -1);
      env.funs.set(name, { args, ret });
      problem.funs.push({ name, args, ret });
    }
  }

  const ctx = { env, problem };
  for (const name of natVars) {
    problem.assertions.push({ name: `d_${name}`, kind: "domain", lean: name, formula: { k: "rel", op: "≥", args: [{ k: "var", name, ty: "Int" }, { k: "lit", v: "0", ty: "Int" }] } });
  }
  let count = 0;
  for (const b of statement.binders) {
    if (b.kind !== "hyp") continue;
    problem.assertions.push({ name: `h_${++count}`, kind: "hypothesis", lean: b.name, formula: prop(elab(b.prop, ctx, [])) });
  }
  // Premises: each statement closed by its own binders.
  premises.forEach((p, i) => {
    problem.assertions.push({ name: `p_${i + 1}`, kind: "premise", lean: p.name, formula: closePremise(p.statement, problem) });
  });
  problem.assertions.push({ name: "goal", kind: "goal", lean: "goal", formula: prop(elab(statement.conclusion, ctx, [])) });
  return problem;
}

function tyOf(type: string, problem: { sorts: string[] }): Ty {
  const t = NUMBER_TY[type];
  if (t !== undefined) return t;
  if (type === "Prop" || type === "Bool") return "Prop";
  if (problem.sorts.includes(type)) return { sort: type };
  throw new Outside(`the type ${type}`);
}

/** A premise `(a b : T) (h : P) : Q` as `∀ a b, P → Q`, over the sorts of the problem. */
function closePremise(statement: string, problem: Problem): IR {
  let s: Statement;
  try {
    s = parseStatement(statement);
  } catch (error) {
    if (error instanceof Unreadable) throw new Outside(`a premise: ${error.message}`);
    throw error;
  }
  const env: Env = { vars: new Map(), funs: new Map(), ops: new Map(), nat: new Set() };
  // The problem's function symbols and operations are the premise's too.
  for (const f of problem.funs) env.funs.set(f.name, { args: f.args, ret: f.ret });
  const vars: Array<{ name: string; ty: Ty }> = [];
  const nat: string[] = [];
  const instOps = new Map<string, string>();
  for (const b of s.binders) {
    if (b.kind === "var") {
      if (/^Type/u.test(b.type)) throw new Outside("a premise over an abstract type it quantifies itself");
      const ty = tyOf(b.type, problem);
      env.vars.set(b.name, ty);
      vars.push({ name: b.name, ty });
      if (b.type === "ℕ") {
        nat.push(b.name);
        env.nat.add(b.name);
      }
    } else if (b.kind === "inst") {
      const spec = OP_FOR_CLASS[b.cls];
      if (spec === undefined || problem.sorts.indexOf(b.arg) < 0) throw new Outside(`a premise with the instance ${b.text}`);
      instOps.set(`${spec.symbol}\u0000${b.arg}`, `${spec.op}_${b.arg}`);
    }
  }
  for (const [k, v] of instOps) env.ops.set(k, v);
  const ctx = { env, problem };
  const hyps = s.binders.flatMap((b) => (b.kind === "hyp" ? [prop(elab(b.prop, ctx, []))] : []));
  const guards: IR[] = nat.map((name) => ({ k: "rel", op: "≥", args: [{ k: "var", name, ty: "Int" }, { k: "lit", v: "0", ty: "Int" }] }));
  const conclusion = prop(elab(s.conclusion, ctx, []));
  let body: IR = conclusion;
  const premisesOf = [...guards, ...hyps];
  if (premisesOf.length > 0) body = { k: "conn", op: "imp", args: [premisesOf.reduce((a, b) => ({ k: "conn", op: "and", args: [a, b] })), conclusion] };
  return vars.length === 0 ? body : { k: "quant", q: "all", vars, body };
}

const prop = (t: IR): IR => {
  if (t.k === "rel" || t.k === "conn" || t.k === "quant" || t.k === "bool") return t;
  if ((t.k === "var" || t.k === "app") && t.ty === "Prop") return t;
  throw new Outside("a term where a proposition was expected");
};

interface Ctx {
  env: Env;
  problem: Problem;
}

const retag = (t: IR, ty: Ty): IR => (t.k === "lit" && typeof ty === "string" && (ty === "Int" || ty === "Real") ? { ...t, ty } : t);

/** Elaborates a term. `scope` lists the quantified variables in scope (with their sorts, in `ctx.env.vars`). */
function elab(term: Term, ctx: Ctx, scope: readonly string[]): IR {
  const { env } = ctx;
  switch (term.k) {
    case "num":
      return { k: "lit", v: term.text, ty: term.text.includes(".") ? "Real" : "Int" };
    case "lit":
      return { k: "bool", v: term.value };
    case "var": {
      const ty = env.vars.get(term.name);
      if (ty !== undefined) return { k: "var", name: term.name, ty };
      if (env.funs.has(term.name)) throw new Outside(`the function ${term.name} used without arguments`);
      throw new Outside(`the name ${term.name}, which is no variable of the statement`);
    }
    case "quant": {
      const saved = new Map(env.vars);
      const vars: Array<{ name: string; ty: Ty }> = [];
      const guards: IR[] = [];
      for (const v of term.vars) {
        if (v.type === undefined) throw new Outside("a quantified variable without a type");
        const ty = tyOf(v.type, ctx.problem);
        env.vars.set(v.name, ty);
        vars.push({ name: v.name, ty });
        if (v.type === "ℕ") env.nat.add(v.name);
        if (v.type === "ℕ") guards.push({ k: "rel", op: "≥", args: [{ k: "var", name: v.name, ty: "Int" }, { k: "lit", v: "0", ty: "Int" }] });
      }
      let body = prop(elab(term.body, ctx, [...scope, ...vars.map((v) => v.name)]));
      env.vars.clear();
      for (const [k, v] of saved) env.vars.set(k, v);
      if (guards.length > 0) {
        const g = guards.reduce((a, b) => ({ k: "conn", op: "and", args: [a, b] }));
        body = term.q === "∀" ? { k: "conn", op: "imp", args: [g, body] } : { k: "conn", op: "and", args: [g, body] };
      }
      return { k: "quant", q: term.q === "∀" ? "all" : "ex", vars, body };
    }
    case "app":
      return term.op ? elabOperator(term, ctx, scope) : elabApplication(term, ctx, scope);
  }
}

function elabApplication(term: Extract<Term, { k: "app" }>, ctx: Ctx, scope: readonly string[]): IR {
  const f = ctx.env.funs.get(term.fn);
  if (f === undefined) throw new Outside(`the function ${term.fn}, which is no variable of the statement`);
  if (f.args.length !== term.args.length) throw new Outside(`${term.fn} applied to ${term.args.length} arguments, not ${f.args.length}`);
  const args = term.args.map((a, i) => retag(elab(a, ctx, scope), f.args[i] as Ty));
  args.forEach((a, i) => sameTy(tyOfIR(a), f.args[i] as Ty, `an argument of ${term.fn}`));
  return { k: "app", fn: term.fn, args, ty: f.ret };
}

function tyOfIR(t: IR): Ty {
  switch (t.k) {
    case "lit":
      return t.ty;
    case "var":
    case "op":
    case "app":
      return t.ty;
    default:
      return "Prop";
  }
}

function sameTy(a: Ty, b: Ty, what: string): void {
  if (tyKey(a) !== tyKey(b)) throw new Outside(`${what} mixes ${tyKey(a)} and ${tyKey(b)} (casts are outside the fragment)`);
}

function numeral(t: IR): string | undefined {
  if (t.k === "lit") return t.v;
  if (t.k === "op" && t.op === "neg" && t.args[0]?.k === "lit") return `-${t.args[0].v}`;
  return undefined;
}

function elabOperator(term: Extract<Term, { k: "app" }>, ctx: Ctx, scope: readonly string[]): IR {
  const op = term.fn;
  const args = term.args.map((a) => elab(a, ctx, scope));
  if (op === "∧" || op === "∨" || op === "→" || op === "↔") {
    return { k: "conn", op: op === "∧" ? "and" : op === "∨" ? "or" : op === "→" ? "imp" : "iff", args: args.map(prop) };
  }
  if (op === "¬") return { k: "conn", op: "not", args: [prop(args[0] as IR)] };
  if (op === "∈" || op === "∉" || op === "⊆") throw new Outside("set membership");
  // Arithmetic and relations: both sides get the same type; a numeral takes the type of the other side.
  const a = args[0] as IR;
  const b = args[1];
  if (op === "neg") {
    const ty = tyOfIR(a);
    if (ty === "Prop" || isUninterpreted(ty)) throw new Outside("negation of a non-number");
    return { k: "op", op: "neg", args: [a], ty };
  }
  if (b === undefined) throw new Outside(`the operator ${op}`);
  let ty: Ty = a.k === "lit" && b.k !== "lit" ? tyOfIR(b) : tyOfIR(a);
  if (a.k === "lit" && b.k === "lit") ty = a.ty === "Real" || b.ty === "Real" ? "Real" : "Int";
  const left = retag(a, ty);
  const right = retag(b, ty);
  sameTy(tyOfIR(left), tyOfIR(right), `the operator ${op}`);
  const natural = isNatural(term, ctx);
  switch (op) {
    case "=":
    case "≠":
    case "<":
    case "≤":
    case ">":
    case "≥":
      if (isUninterpreted(ty) && !(op === "=" || op === "≠")) throw new Outside(`the order ${op} on an abstract type`);
      return { k: "rel", op, args: [left, right] };
    case "∣": {
      if (numeral(left) === undefined || numeral(left) === "0") throw new Outside("a divisibility by something that is no nonzero numeral");
      if (ty !== "Int") throw new Outside("divisibility over the reals");
      return { k: "rel", op: "dvd", args: [left, right] };
    }
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      if (isUninterpreted(ty)) {
        const name = ctx.env.ops.get(`${op}\u0000${ty.sort}`);
        if (name === undefined) throw new Outside(`the operation ${op} on ${ty.sort} has no instance binder`);
        if (!ctx.problem.funs.some((f) => f.name === name)) ctx.problem.funs.push({ name, args: [ty, ty], ret: ty });
        return { k: "app", fn: name, args: [left, right], ty };
      }
      if (ty === "Prop") throw new Outside(`the operator ${op} on propositions`);
      if (op === "/" && ty === "Real") {
        const d = numeral(right);
        if (d === undefined || Number(d) === 0) throw new Outside("a division of reals by something that is no nonzero numeral");
      }
      if ((op === "/" || op === "%") && ty === "Int" && numeral(right) === undefined) throw new Outside("a division of integers by something that is no numeral");
      if (op === "%" && ty === "Real") throw new Outside("modulo over the reals");
      const name = op === "+" ? "add" : op === "-" ? "sub" : op === "*" ? "mul" : op === "/" ? "div" : "mod";
      return { k: "op", op: name, args: [left, right], ty, ...(op === "-" && natural ? { nat: true } : {}) };
    }
    case "^": {
      const e = numeral(b);
      if (e === undefined || !/^\d+$/u.test(e) || Number(e) > 8) throw new Outside("a power whose exponent is no numeral up to 8");
      return { k: "op", op: "pow", args: [a, { k: "lit", v: e, ty: "Int" }], ty: tyOfIR(a) };
    }
    default:
      throw new Outside(`the operator ${op}`);
  }
}

/** Whether a subtraction is on natural numbers: some variable in it is a `ℕ` (recorded by the domain assertion). */
function isNatural(term: Extract<Term, { k: "app" }>, ctx: Ctx): boolean {
  if (term.fn !== "-") return false;
  const names = new Set<string>();
  const walk = (t: Term): void => {
    if (t.k === "var") names.add(t.name);
    else if (t.k === "app") t.args.forEach(walk);
  };
  walk(term);
  return [...names].some((n) => ctx.env.nat.has(n));
}

// --- SMT-LIB -----------------------------------------------------------------------------------

const SMT_PLAIN = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const SMT_RESERVED = new Set(["and", "or", "not", "ite", "let", "div", "mod", "abs", "forall", "exists", "true", "false", "distinct", "assert", "Int", "Real", "Bool", "to_real", "to_int", "is_int", "as", "par", "sat", "unsat", "model", "check"]);

function smtSymbol(name: string): string {
  if (/[|\\]/u.test(name)) throw new Outside(`the name ${name}`);
  return SMT_PLAIN.test(name) && !SMT_RESERVED.has(name) ? name : `|${name}|`;
}

const smtTy = (t: Ty): string => (t === "Int" ? "Int" : t === "Real" ? "Real" : t === "Prop" ? "Bool" : smtSymbol(t.sort));

function smtNumber(v: string, ty: "Int" | "Real"): string {
  const neg = v.startsWith("-");
  const digits = neg ? v.slice(1) : v;
  const body = ty === "Real" ? (digits.includes(".") ? digits : `${digits}.0`) : digits;
  return neg ? `(- ${body})` : body;
}

export function smtTerm(t: IR): string {
  switch (t.k) {
    case "lit":
      return smtNumber(t.v, t.ty);
    case "bool":
      return t.v ? "true" : "false";
    case "var":
      return smtSymbol(t.name);
    case "app":
      return `(${smtSymbol(t.fn)} ${t.args.map(smtTerm).join(" ")})`;
    case "op": {
      const [a, b] = t.args.map(smtTerm) as [string, string | undefined];
      switch (t.op) {
        case "add":
          return `(+ ${a} ${b})`;
        case "sub":
          return t.nat === true ? `(ite (>= ${a} ${b}) (- ${a} ${b}) 0)` : `(- ${a} ${b})`;
        case "mul":
          return `(* ${a} ${b})`;
        case "div":
          return t.ty === "Real" ? `(/ ${a} ${b})` : `(div ${a} ${b})`;
        case "mod":
          return `(mod ${a} ${b})`;
        case "neg":
          return `(- ${a})`;
        case "pow": {
          const n = Number(numeral(t.args[1] as IR));
          if (n === 0) return t.ty === "Real" ? "1.0" : "1";
          return n === 1 ? a : `(* ${Array.from({ length: n }, () => a).join(" ")})`;
        }
      }
      return a;
    }
    case "rel": {
      const [a, b] = t.args.map(smtTerm) as [string, string];
      switch (t.op) {
        case "=":
          return `(= ${a} ${b})`;
        case "≠":
          return `(not (= ${a} ${b}))`;
        case "<":
          return `(< ${a} ${b})`;
        case "≤":
          return `(<= ${a} ${b})`;
        case ">":
          return `(> ${a} ${b})`;
        case "≥":
          return `(>= ${a} ${b})`;
        case "dvd":
          return `(= (mod ${b} ${a}) 0)`;
      }
      return a;
    }
    case "conn": {
      const parts = t.args.map(smtTerm);
      switch (t.op) {
        case "and":
          return `(and ${parts.join(" ")})`;
        case "or":
          return `(or ${parts.join(" ")})`;
        case "not":
          return `(not ${parts[0]})`;
        case "imp":
          return `(=> ${parts[0]} ${parts[1]})`;
        case "iff":
          return `(= ${parts[0]} ${parts[1]})`;
      }
      return parts[0] as string;
    }
    case "quant":
      return `(${t.q === "all" ? "forall" : "exists"} (${t.vars.map((v) => `(${smtSymbol(v.name)} ${smtTy(v.ty)})`).join(" ")}) ${smtTerm(t.body)})`;
  }
}

export interface SmtProblem {
  text: string;
  /** The names asserted under `:named`, with what they stand for. */
  named: Array<{ name: string; kind: Assertion["kind"]; lean: string }>;
}

/**
 * The SMT-LIB script that refutes the goal: the hypotheses and premises are asserted, the negation
 * of the goal last, with names so that `unsat` comes with a core. `unsat` means the goal follows.
 */
export function toSmtLib(problem: Problem, options: { cores?: boolean } = {}): SmtProblem {
  const lines: string[] = ["(set-logic ALL)"];
  if (options.cores !== false) lines.push("(set-option :produce-unsat-cores true)");
  for (const s of problem.sorts) lines.push(`(declare-sort ${smtSymbol(s)} 0)`);
  for (const c of problem.consts) lines.push(`(declare-const ${smtSymbol(c.name)} ${smtTy(c.ty)})`);
  for (const f of problem.funs) lines.push(`(declare-fun ${smtSymbol(f.name)} (${f.args.map(smtTy).join(" ")}) ${smtTy(f.ret)})`);
  const named: SmtProblem["named"] = [];
  for (const a of problem.assertions) {
    const formula = a.kind === "goal" ? `(not ${smtTerm(a.formula)})` : smtTerm(a.formula);
    lines.push(`(assert (! ${formula} :named ${a.name}))`);
    named.push({ name: a.name, kind: a.kind, lean: a.lean });
  }
  lines.push("(check-sat)");
  if (options.cores !== false) lines.push("(get-unsat-core)");
  return { text: `${lines.join("\n")}\n`, named };
}

// --- TPTP --------------------------------------------------------------------------------------

function tptpName(name: string, prefix: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/u.test(ch) ? ch : `_u${ch.codePointAt(0)?.toString(16)}`;
  return `${prefix}${out}`;
}

const tptpTy = (t: Ty): string => (t === "Int" ? "$int" : t === "Real" ? "$real" : t === "Prop" ? "$o" : tptpName(t.sort, "s_"));

export function tptpTerm(t: IR, bound: ReadonlySet<string> = new Set()): string {
  switch (t.k) {
    case "lit": {
      const neg = t.v.startsWith("-");
      const digits = neg ? t.v.slice(1) : t.v;
      const body = t.ty === "Real" && !digits.includes(".") ? `${digits}.0` : digits;
      return neg ? `$uminus(${body})` : body;
    }
    case "bool":
      return t.v ? "$true" : "$false";
    case "var":
      return bound.has(t.name) ? tptpName(t.name, "X_") : tptpName(t.name, "c_");
    case "app":
      return t.args.length === 0 ? tptpName(t.fn, "f_") : `${tptpName(t.fn, "f_")}(${t.args.map((a) => tptpTerm(a, bound)).join(",")})`;
    case "op": {
      const [a, b] = t.args.map((a) => tptpTerm(a, bound)) as [string, string | undefined];
      switch (t.op) {
        case "add":
          return `$sum(${a},${b})`;
        case "sub":
          return t.nat === true ? `$ite($greatereq(${a},${b}),$difference(${a},${b}),0)` : `$difference(${a},${b})`;
        case "mul":
          return `$product(${a},${b})`;
        case "div":
          return t.ty === "Real" ? `$quotient(${a},${b})` : `$quotient_e(${a},${b})`;
        case "mod":
          return `$remainder_e(${a},${b})`;
        case "neg":
          return `$uminus(${a})`;
        case "pow": {
          const n = Number(numeral(t.args[1] as IR));
          if (n === 0) return t.ty === "Real" ? "1.0" : "1";
          return Array.from({ length: n - 1 }).reduce<string>((acc) => `$product(${acc},${a})`, a);
        }
      }
      return a;
    }
    case "rel": {
      const [a, b] = t.args.map((a) => tptpTerm(a, bound)) as [string, string];
      switch (t.op) {
        case "=":
          return `(${a} = ${b})`;
        case "≠":
          return `(${a} != ${b})`;
        case "<":
          return `$less(${a},${b})`;
        case "≤":
          return `$lesseq(${a},${b})`;
        case ">":
          return `$greater(${a},${b})`;
        case "≥":
          return `$greatereq(${a},${b})`;
        case "dvd":
          return `(${tptpTerm({ k: "op", op: "mod", args: [t.args[1] as IR, t.args[0] as IR], ty: "Int" }, bound)} = 0)`;
      }
      return a;
    }
    case "conn": {
      const parts = t.args.map((a) => tptpTerm(a, bound));
      switch (t.op) {
        case "and":
          return `(${parts.join(" & ")})`;
        case "or":
          return `(${parts.join(" | ")})`;
        case "not":
          return `(~ ${parts[0]})`;
        case "imp":
          return `(${parts[0]} => ${parts[1]})`;
        case "iff":
          return `(${parts[0]} <=> ${parts[1]})`;
      }
      return parts[0] as string;
    }
    case "quant": {
      const body = tptpTerm(t.body, new Set([...bound, ...t.vars.map((v) => v.name)]));
      return `(${t.q === "all" ? "!" : "?"}[${t.vars.map((v) => `${tptpName(v.name, "X_")}:${tptpTy(v.ty)}`).join(",")}]: ${body})`;
    }
  }
}

export interface TptpProblem {
  text: string;
  /** TPTP formula name to what it stands for. */
  named: Array<{ name: string; kind: Assertion["kind"]; lean: string }>;
}

/** The TPTP (TFF) problem: the hypotheses and premises as axioms, the goal as the conjecture. */
export function toTptp(problem: Problem): TptpProblem {
  const lines: string[] = [];
  for (const s of problem.sorts) lines.push(`tff(${tptpName(s, "s_")}_type, type, ${tptpName(s, "s_")}: $tType).`);
  for (const c of problem.consts) lines.push(`tff(${tptpName(c.name, "c_")}_type, type, ${tptpName(c.name, "c_")}: ${tptpTy(c.ty)}).`);
  for (const f of problem.funs) {
    const sig = f.args.length === 0 ? tptpTy(f.ret) : `${f.args.length === 1 ? tptpTy(f.args[0] as Ty) : `(${f.args.map(tptpTy).join(" * ")})`} > ${tptpTy(f.ret)}`;
    lines.push(`tff(${tptpName(f.name, "f_")}_type, type, ${tptpName(f.name, "f_")}: ${sig}).`);
  }
  const named: TptpProblem["named"] = [];
  for (const a of problem.assertions) {
    const role = a.kind === "goal" ? "conjecture" : "axiom";
    lines.push(`tff(${a.name}, ${role}, ${tptpTerm(a.formula)}).`);
    named.push({ name: a.name, kind: a.kind, lean: a.lean });
  }
  return { text: `${lines.join("\n")}\n`, named };
}
