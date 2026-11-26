import { assertLeanSafe, UnsafeText } from "./screen.ts";
import type { SmtOutput } from "./solvers.ts";

/**
 * Two recipes that write SMT-LIB for the existing `smt.z3` capability and read its answer strictly (plan change CX7):
 *
 * - `findInvariant`: a loop or process given as transitions (integer variables, `init`, `step`, `property`) becomes a
 *   set of constrained Horn clauses (`(set-logic HORN)`, z3's Spacer engine); the invariant z3 returns becomes the Lean
 *   statement "it holds initially, every step keeps it, and it implies the property", an `open` conjecture (move E5).
 * - `findOptimum`: a small extremal question (integer variables, linear or 0/1 constraints, an objective) goes to z3's
 *   Optimize engine (`maximize` or `minimize`); the optimum becomes the Lean statement "it is reached, and no point
 *   under the constraints does better", an `open` claim.
 *
 * Every formula the user gives and every formula z3 answers is read into one small syntax tree (integers, the given
 * variables, `+ - *`, comparisons, `and or not =>`), and both the SMT-LIB and the Lean text are written from that tree:
 * no text of a model or of z3 reaches Lean as it was written. Anything outside the tree (a `let`, an `ite`, a
 * quantifier, a string, an unbounded optimum) is no answer: the outcome is `malformed`, and nothing becomes a claim.
 * z3's answer is evidence at most (Ruling 13): a status changes only when a Lean proof goes through `validate`.
 */

// --- S-expressions ---------------------------------------------------------------------------------

export type Sexp = string | Sexp[];

const ATOM = /^[A-Za-z0-9_!'.+\-*<>=/]+$/u;
const MAX_NODES = 4000;

/** The S-expressions of a text, or `undefined` when it holds anything but atoms and parentheses (a string, a comment, a quoted symbol, a keyword). */
export function readSexps(text: string): Sexp[] | undefined {
  const tokens = text.match(/[()]|[^\s()]+/gu) ?? [];
  if (tokens.length > MAX_NODES) return undefined;
  const stack: Sexp[][] = [[]];
  for (const token of tokens) {
    if (token === "(") {
      if (stack.length > 64) return undefined;
      stack.push([]);
    } else if (token === ")") {
      if (stack.length === 1) return undefined;
      const done = stack.pop() as Sexp[];
      (stack[stack.length - 1] as Sexp[]).push(done);
    } else {
      if (!ATOM.test(token)) return undefined;
      (stack[stack.length - 1] as Sexp[]).push(token);
    }
  }
  return stack.length === 1 ? (stack[0] as Sexp[]) : undefined;
}

// --- The syntax tree -------------------------------------------------------------------------------

/** An integer term over the variables (by position; `next` for the state after a step). */
export type LinTerm =
  | { t: "num"; v: bigint }
  | { t: "var"; i: number; next: boolean }
  | { t: "add" | "sub" | "mul"; a: LinTerm[] };

export type LinFormula =
  | { f: "const"; v: boolean }
  | { f: "cmp"; op: "<=" | "<" | ">=" | ">" | "="; a: LinTerm; b: LinTerm }
  | { f: "and" | "or"; a: LinFormula[] }
  | { f: "not"; a: LinFormula }
  | { f: "implies"; a: LinFormula; b: LinFormula };

/** What a symbol stands for: a variable (by position, now or after the step). */
type Names = ReadonlyMap<string, { i: number; next: boolean }>;

class Outside extends Error {}

const CMP = new Set(["<=", "<", ">=", ">", "="]);

function term(s: Sexp, names: Names): LinTerm {
  if (typeof s === "string") {
    if (/^\d{1,40}$/u.test(s)) return { t: "num", v: BigInt(s) };
    const v = names.get(s);
    if (v === undefined) throw new Outside(`the symbol ${s.slice(0, 40)}`);
    return { t: "var", ...v };
  }
  const [head, ...args] = s;
  if (head === "+" || head === "*") {
    if (args.length < 2) throw new Outside(`a ${head} with ${args.length} argument(s)`);
    return { t: head === "+" ? "add" : "mul", a: args.map((x) => term(x, names)) };
  }
  if (head === "-") {
    if (args.length < 1) throw new Outside("a - with no argument");
    // A negative literal, as z3 prints one: `(- 7)`.
    if (args.length === 1 && typeof args[0] === "string" && /^\d{1,40}$/u.test(args[0])) return { t: "num", v: -BigInt(args[0]) };
    return { t: "sub", a: args.map((x) => term(x, names)) };
  }
  throw new Outside(`the term ${typeof head === "string" ? head.slice(0, 40) : "(...)"}`);
}

function formula(s: Sexp, names: Names): LinFormula {
  if (s === "true" || s === "false") return { f: "const", v: s === "true" };
  if (typeof s === "string") throw new Outside(`the formula ${s.slice(0, 40)}`);
  const [head, ...args] = s;
  if (typeof head !== "string") throw new Outside("a formula with no operator");
  if (CMP.has(head)) {
    if (args.length < 2) throw new Outside(`a ${head} with ${args.length} argument(s)`);
    const ts = args.map((x) => term(x, names));
    const op = head as "<=" | "<" | ">=" | ">" | "=";
    const pairs: LinFormula[] = ts.slice(1).map((b, k) => ({ f: "cmp", op, a: ts[k] as LinTerm, b }));
    return pairs.length === 1 ? (pairs[0] as LinFormula) : { f: "and", a: pairs };
  }
  if (head === "and" || head === "or") return { f: head, a: args.map((x) => formula(x, names)) };
  if (head === "not" && args.length === 1) return { f: "not", a: formula(args[0] as Sexp, names) };
  if (head === "=>" && args.length >= 2) {
    // Right-associative, as SMT-LIB reads it.
    const fs = args.map((x) => formula(x, names));
    return fs.slice(0, -1).reduceRight<LinFormula>((b, a) => ({ f: "implies", a, b }), fs[fs.length - 1] as LinFormula);
  }
  throw new Outside(`the operator ${head.slice(0, 40)}`);
}

function size(x: LinTerm | LinFormula): number {
  if ("t" in x) return x.t === "num" || x.t === "var" ? 1 : 1 + x.a.reduce((n, y) => n + size(y), 0);
  switch (x.f) {
    case "const":
      return 1;
    case "cmp":
      return 1 + size(x.a) + size(x.b);
    case "and":
    case "or":
      return 1 + x.a.reduce((n, y) => n + size(y), 0);
    case "not":
      return 1 + size(x.a);
    case "implies":
      return 1 + size(x.a) + size(x.b);
  }
}

// --- Writers and the evaluator ---------------------------------------------------------------------

/** The SMT-LIB of a term or formula: the variables as `s<i>` (now) and `t<i>` (after the step), never as the user named them. */
export function linSmt(x: LinTerm | LinFormula): string {
  if ("t" in x) {
    if (x.t === "num") return x.v < 0n ? `(- ${-x.v})` : `${x.v}`;
    if (x.t === "var") return `${x.next ? "t" : "s"}${x.i}`;
    return `(${x.t === "add" ? "+" : x.t === "sub" ? "-" : "*"} ${x.a.map(linSmt).join(" ")})`;
  }
  switch (x.f) {
    case "const":
      return x.v ? "true" : "false";
    case "cmp":
      return `(${x.op} ${linSmt(x.a)} ${linSmt(x.b)})`;
    case "and":
    case "or":
      return x.a.length === 0 ? (x.f === "and" ? "true" : "false") : `(${x.f} ${x.a.map(linSmt).join(" ")})`;
    case "not":
      return `(not ${linSmt(x.a)})`;
    case "implies":
      return `(=> ${linSmt(x.a)} ${linSmt(x.b)})`;
  }
}

const LEAN_CMP = { "<=": "≤", "<": "<", ">=": "≥", ">": ">", "=": "=" } as const;

/** The Lean text of a term or formula over `Int`, from integers and the given names only (`x'` after the step). */
export function linLean(x: LinTerm | LinFormula, names: readonly string[]): string {
  const go = (y: LinTerm | LinFormula): string => linLean(y, names);
  if ("t" in x) {
    if (x.t === "num") return x.v < 0n ? `(${x.v} : Int)` : `${x.v}`;
    if (x.t === "var") return `${names[x.i] as string}${x.next ? "'" : ""}`;
    if (x.t === "sub" && x.a.length === 1) return `(-${go(x.a[0] as LinTerm)})`;
    return `(${x.a.map(go).join(x.t === "add" ? " + " : x.t === "sub" ? " - " : " * ")})`;
  }
  switch (x.f) {
    case "const":
      return x.v ? "True" : "False";
    case "cmp":
      return `(${go(x.a)} ${LEAN_CMP[x.op]} ${go(x.b)})`;
    case "and":
    case "or":
      return x.a.length === 0 ? (x.f === "and" ? "True" : "False") : x.a.length === 1 ? go(x.a[0] as LinFormula) : `(${x.a.map(go).join(x.f === "and" ? " ∧ " : " ∨ ")})`;
    case "not":
      return `(¬${go(x.a)})`;
    case "implies":
      return `(${go(x.a)} → ${go(x.b)})`;
  }
}

/** The value of a term at a point (the state now; the tree's `next` variables are not read here). */
export function linValue(x: LinTerm, point: readonly bigint[]): bigint {
  if (x.t === "num") return x.v;
  if (x.t === "var") return point[x.i] as bigint;
  const vs = x.a.map((y) => linValue(y, point));
  if (x.t === "add") return vs.reduce((a, b) => a + b, 0n);
  if (x.t === "mul") return vs.reduce((a, b) => a * b, 1n);
  return vs.length === 1 ? -(vs[0] as bigint) : vs.slice(1).reduce((a, b) => a - b, vs[0] as bigint);
}

/** Whether a formula holds at a point. */
export function linHolds(x: LinFormula, point: readonly bigint[]): boolean {
  switch (x.f) {
    case "const":
      return x.v;
    case "cmp": {
      const a = linValue(x.a, point);
      const b = linValue(x.b, point);
      return x.op === "<=" ? a <= b : x.op === "<" ? a < b : x.op === ">=" ? a >= b : x.op === ">" ? a > b : a === b;
    }
    case "and":
      return x.a.every((y) => linHolds(y, point));
    case "or":
      return x.a.some((y) => linHolds(y, point));
    case "not":
      return !linHolds(x.a, point);
    case "implies":
      return !linHolds(x.a, point) || linHolds(x.b, point);
  }
}

// --- Specs -----------------------------------------------------------------------------------------

/** A loop or process over integer variables: SMT-LIB formulas, the state after a step written with a prime (`x'`). */
export interface TransitionSystem {
  /** A name for the logs and the evidence node. */
  name: string;
  /** 1 to 8 integer variables, plain identifiers. */
  vars: string[];
  /** The initial states, over `vars`. */
  init: string;
  /** One step, over `vars` and their primed copies, such as `(and (< x 10) (= x' (+ x 1)))`. */
  step: string;
  /** What should hold in every reachable state, over `vars`. */
  property: string;
  /** z3's time limit, 1 to 300 seconds; 20 when not given. */
  timeoutSec?: number;
}

/** A small extremal question over integer variables (a 0/1 variable is a bit). */
export interface OptimumSpec {
  name: string;
  vars: string[];
  /** SMT-LIB formulas over `vars`, all of which must hold. */
  constraints: string[];
  /** An SMT-LIB integer term over `vars`. */
  objective: string;
  sense: "maximize" | "minimize";
  timeoutSec?: number;
}

export interface ParsedSystem {
  spec: TransitionSystem;
  init: LinFormula;
  step: LinFormula;
  property: LinFormula;
}

export interface ParsedOptimum {
  spec: OptimumSpec;
  constraints: LinFormula[];
  objective: LinTerm;
}

/** Words a variable may not be called: SMT-LIB's and Lean's own, and the names the recipes write. */
const RESERVED = new Set(
  "and or not true false let forall exists ite distinct mod div abs fun have show from at by do then else if in match with end open theorem lemma def where Type Prop Sort Int Nat True False obj inv sorry this calc example instance structure class namespace section variable universe import export deriving mutual axiom notation macro syntax"
    .split(" "),
);
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/u;
const MAX_FORMULA = 4000;

function variables(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new TypeError(`${where}.vars is a list of 1 to 8 variable names`);
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !VARIABLE.test(v) || RESERVED.has(v) || /^[st]\d+$/u.test(v)) throw new TypeError(`${where}.vars: ${JSON.stringify(v)} is not a plain variable name`);
    if (seen.has(v)) throw new TypeError(`${where}.vars names ${v} twice`);
    seen.add(v);
  }
  return raw as string[];
}

function one(text: unknown, where: string, names: Names, kind: "formula" | "term"): LinFormula | LinTerm {
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_FORMULA) throw new TypeError(`${where} is an SMT-LIB ${kind} of at most ${MAX_FORMULA} characters`);
  const read = readSexps(text);
  if (read === undefined || read.length !== 1) throw new TypeError(`${where} is not one SMT-LIB ${kind} (atoms and parentheses only)`);
  try {
    return kind === "formula" ? formula(read[0] as Sexp, names) : term(read[0] as Sexp, names);
  } catch (error) {
    if (error instanceof Outside) throw new TypeError(`${where} is outside the recipe's fragment: ${error.message}`);
    throw error;
  }
}

function timeoutOf(raw: unknown, where: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 300) throw new TypeError(`${where}.timeoutSec is an integer from 1 to 300`);
  return raw;
}

function nameOf(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !/^[\w.-]{1,60}$/u.test(raw)) throw new TypeError(`${where}.name is a short name (letters, digits, _ . -)`);
  return raw;
}

function namesOf(vars: readonly string[], primed: boolean): Names {
  const names = new Map<string, { i: number; next: boolean }>();
  vars.forEach((v, i) => {
    names.set(v, { i, next: false });
    if (primed) names.set(`${v}'`, { i, next: true });
  });
  return names;
}

/** Reads and checks a transition system given as data (a line's option); throws a `TypeError` that names `where`. */
export function parseTransitionSystem(raw: unknown, where: string): ParsedSystem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError(`${where} is an object with name, vars, init, step and property`);
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !["name", "vars", "init", "step", "property", "timeoutSec"].includes(k));
  if (extra.length > 0) throw new TypeError(`${where} has unknown field(s) ${extra.join(", ")}`);
  const vars = variables(r.vars, where);
  const now = namesOf(vars, false);
  const timeoutSec = timeoutOf(r.timeoutSec, where);
  const spec: TransitionSystem = { name: nameOf(r.name, where), vars, init: r.init as string, step: r.step as string, property: r.property as string, ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
  return {
    spec,
    init: one(r.init, `${where}.init`, now, "formula") as LinFormula,
    step: one(r.step, `${where}.step`, namesOf(vars, true), "formula") as LinFormula,
    property: one(r.property, `${where}.property`, now, "formula") as LinFormula,
  };
}

/** Reads and checks an optimum question given as data; throws a `TypeError` that names `where`. */
export function parseOptimumSpec(raw: unknown, where: string): ParsedOptimum {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError(`${where} is an object with name, vars, constraints, objective and sense`);
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !["name", "vars", "constraints", "objective", "sense", "timeoutSec"].includes(k));
  if (extra.length > 0) throw new TypeError(`${where} has unknown field(s) ${extra.join(", ")}`);
  const vars = variables(r.vars, where);
  const names = namesOf(vars, false);
  if (r.sense !== "maximize" && r.sense !== "minimize") throw new TypeError(`${where}.sense is maximize or minimize`);
  if (!Array.isArray(r.constraints) || r.constraints.length > 32) throw new TypeError(`${where}.constraints is a list of at most 32 SMT-LIB formulas`);
  const constraints = r.constraints.map((c, i) => one(c, `${where}.constraints[${i}]`, names, "formula") as LinFormula);
  const timeoutSec = timeoutOf(r.timeoutSec, where);
  const spec: OptimumSpec = { name: nameOf(r.name, where), vars, constraints: r.constraints as string[], objective: r.objective as string, sense: r.sense, ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
  return { spec, constraints, objective: one(r.objective, `${where}.objective`, names, "term") as LinTerm };
}

// --- Scripts ---------------------------------------------------------------------------------------

const binders = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `(${prefix}${i} Int)`).join(" ");
const args = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

/** The Horn clauses of a transition system for Spacer: `inv` holds initially, is kept by a step, and excludes every state where the property fails. */
export function chcScript(sys: ParsedSystem): string {
  const n = sys.spec.vars.length;
  return [
    "(set-logic HORN)",
    `(declare-fun inv (${Array(n).fill("Int").join(" ")}) Bool)`,
    `(assert (forall (${binders(n, "s")}) (=> ${linSmt(sys.init)} (inv ${args(n, "s")}))))`,
    `(assert (forall (${binders(n, "s")} ${binders(n, "t")}) (=> (and (inv ${args(n, "s")}) ${linSmt(sys.step)}) (inv ${args(n, "t")}))))`,
    `(assert (forall (${binders(n, "s")}) (=> (and (inv ${args(n, "s")}) (not ${linSmt(sys.property)})) false)))`,
    "(check-sat)",
    "",
  ].join("\n");
}

/** The Optimize script of a question: the constraints, `obj` equal to the objective, `maximize` or `minimize`, then the objectives. */
export function optimumScript(q: ParsedOptimum): string {
  const n = q.spec.vars.length;
  return [
    ...Array.from({ length: n }, (_, i) => `(declare-const s${i} Int)`),
    "(declare-const obj Int)",
    ...q.constraints.map((c) => `(assert ${linSmt(c)})`),
    `(assert (= obj ${linSmt(q.objective)}))`,
    `(${q.spec.sense} obj)`,
    "(check-sat)",
    "(get-objectives)",
    "",
  ].join("\n");
}

// --- Statements ------------------------------------------------------------------------------------

const all = (names: readonly string[], body: string): string => `(∀ ${names.join(" ")} : Int, ${body})`;

/** The Lean statement an invariant makes: it holds initially, a step keeps it, and it implies the property. Screened. */
export function invariantStatement(sys: ParsedSystem, inv: LinFormula): string {
  const v = sys.spec.vars;
  const primed = v.map((x) => `${x}'`);
  const after = renameNext(inv);
  const text = `: ${all(v, `${linLean(sys.init, v)} → ${linLean(inv, v)}`)} ∧ ${all([...v, ...primed], `${linLean(inv, v)} → ${linLean(sys.step, v)} → ${linLean(after, v)}`)} ∧ ${all(v, `${linLean(inv, v)} → ${linLean(sys.property, v)}`)}`;
  assertLeanSafe(text, "the invariant's statement");
  return text;
}

/** The Lean statement an optimum makes: a point under the constraints reaches it, and none does better. Screened. */
export function optimumStatement(q: ParsedOptimum, value: bigint): string {
  const v = q.spec.vars;
  const obj = linLean(q.objective, v);
  const val = linLean({ t: "num", v: value }, v);
  const cs = q.constraints.map((c) => linLean(c, v));
  const bound = q.spec.sense === "maximize" ? `${obj} ≤ ${val}` : `${val} ≤ ${obj}`;
  const text = `: (∃ ${v.join(" ")} : Int, ${[...cs, `${obj} = ${val}`].join(" ∧ ")}) ∧ ${all(v, [...cs, bound].join(" → "))}`;
  assertLeanSafe(text, "the optimum's statement");
  return text;
}

/** The formula with every variable read after the step. */
function renameNext(x: LinFormula): LinFormula {
  const t = (y: LinTerm): LinTerm => (y.t === "num" ? y : y.t === "var" ? { ...y, next: true } : { t: y.t, a: y.a.map(t) });
  switch (x.f) {
    case "const":
      return x;
    case "cmp":
      return { ...x, a: t(x.a), b: t(x.b) };
    case "and":
    case "or":
      return { f: x.f, a: x.a.map(renameNext) };
    case "not":
      return { f: "not", a: renameNext(x.a) };
    case "implies":
      return { f: "implies", a: renameNext(x.a), b: renameNext(x.b) };
  }
}

// --- Reading z3's answers --------------------------------------------------------------------------

/** What a recipe got: a claim's statement, or why there is none. `unsafe` is Spacer's `unsat`: some reachable state breaks the property. */
export type RecipeAnswer = "invariant" | "optimum" | "unsafe" | "infeasible" | "unknown" | "timeout" | "error" | "malformed";

export interface InvariantOutcome {
  answer: Extract<RecipeAnswer, "invariant" | "unsafe" | "unknown" | "timeout" | "error" | "malformed">;
  /** For `invariant`: the invariant as the recipe rewrote it in SMT-LIB, its Lean statement. */
  invariant?: string;
  statement?: string;
  detail?: string;
  elapsedMs?: number;
}

export interface OptimumOutcome {
  answer: Extract<RecipeAnswer, "optimum" | "infeasible" | "unknown" | "timeout" | "error" | "malformed">;
  /** For `optimum`: the value, the point z3 gave (checked here against the constraints), the Lean statement. */
  value?: string;
  witness?: Record<string, string>;
  statement?: string;
  detail?: string;
  elapsedMs?: number;
}

/** The definitions of a model: `((define-fun ...) ...)` or `(model (define-fun ...) ...)`. */
function definitions(s: Sexp): Sexp[][] | undefined {
  if (typeof s === "string") return undefined;
  const body = s[0] === "model" ? s.slice(1) : s;
  return body.every((d) => Array.isArray(d) && d[0] === "define-fun" && d.length === 5) ? (body as Sexp[][]) : undefined;
}

/** An integer value as z3 prints it: `7` or `(- 7)`. */
function integer(s: Sexp | undefined): bigint | undefined {
  if (typeof s === "string") return /^\d{1,40}$/u.test(s) ? BigInt(s) : undefined;
  if (Array.isArray(s) && s.length === 2 && s[0] === "-" && typeof s[1] === "string" && /^\d{1,40}$/u.test(s[1])) return -BigInt(s[1]);
  return undefined;
}

/** Reads Spacer's answer to `chcScript`: `sat` with exactly one definition of `inv` over the state's variables, in the fragment. */
export function readInvariant(sys: ParsedSystem, out: SmtOutput): InvariantOutcome {
  const at = { elapsedMs: out.elapsedMs };
  if (out.status === "unsat") return { answer: "unsafe", ...at };
  if (out.status !== "sat") return { answer: out.status, ...(out.detail !== undefined ? { detail: out.detail } : {}), ...at };
  const bad = (detail: string): InvariantOutcome => ({ answer: "malformed", detail, ...at });
  const read = readSexps(out.model ?? "");
  if (read === undefined || read.length !== 1) return bad("the model is not one S-expression of atoms");
  const defs = definitions(read[0] as Sexp);
  if (defs === undefined || defs.length !== 1 || defs[0]?.[1] !== "inv" || defs[0]?.[3] !== "Bool") return bad("the model is not one definition of inv");
  const params = defs[0][2];
  const n = sys.spec.vars.length;
  if (!Array.isArray(params) || params.length !== n || !params.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && p[1] === "Int")) return bad(`inv does not take ${n} integers`);
  const names = new Map((params as string[][]).map((p, i) => [p[0] as string, { i, next: false }] as const));
  if (names.size !== n) return bad("inv names a parameter twice");
  let inv: LinFormula;
  try {
    inv = formula(defs[0][4] as Sexp, names);
  } catch (error) {
    if (error instanceof Outside) return bad(`the invariant is outside the fragment: ${error.message}`);
    throw error;
  }
  if (size(inv) > 400) return bad("the invariant is too large");
  try {
    return { answer: "invariant", invariant: linSmt(inv), statement: invariantStatement(sys, inv), ...at };
  } catch (error) {
    if (error instanceof UnsafeText) return bad(error.message);
    throw error;
  }
}

/** Reads Optimize's answer to `optimumScript` with the model: `sat`, `(objectives (obj V))` with V an integer, then a model whose point meets every constraint and gives V. */
export function readOptimum(q: ParsedOptimum, out: SmtOutput): OptimumOutcome {
  const at = { elapsedMs: out.elapsedMs };
  if (out.status === "unsat") return { answer: "infeasible", ...at };
  if (out.status !== "sat") return { answer: out.status, ...(out.detail !== undefined ? { detail: out.detail } : {}), ...at };
  const bad = (detail: string): OptimumOutcome => ({ answer: "malformed", detail, ...at });
  const read = readSexps(out.model ?? "");
  if (read === undefined || read.length !== 2) return bad("the answer is not the objectives and a model");
  const [objectives, model] = read as [Sexp, Sexp];
  if (!Array.isArray(objectives) || objectives.length !== 2 || objectives[0] !== "objectives" || !Array.isArray(objectives[1]) || objectives[1].length !== 2 || objectives[1][0] !== "obj") return bad("the objectives are not (objectives (obj V))");
  const value = integer(objectives[1][1]);
  if (value === undefined) return bad("the optimum is not an integer (unbounded, or not printed as one)");
  const defs = definitions(model);
  if (defs === undefined) return bad("the model is not a list of definitions");
  const n = q.spec.vars.length;
  const point: bigint[] = Array(n).fill(0n);
  for (const d of defs) {
    const m = typeof d[1] === "string" ? /^s(\d)$/u.exec(d[1]) : null;
    if (d[1] === "obj") continue;
    if (m === null || Number(m[1]) >= n || !Array.isArray(d[2]) || d[2].length !== 0 || d[3] !== "Int") return bad(`the model defines ${typeof d[1] === "string" ? d[1].slice(0, 40) : "(...)"}`);
    const v = integer(d[4]);
    if (v === undefined) return bad("a value of the model is not an integer");
    point[Number(m[1])] = v;
  }
  // z3's point is checked here: it must meet every constraint and reach the value it printed.
  if (!q.constraints.every((c) => linHolds(c, point))) return bad("the model's point breaks a constraint");
  if (linValue(q.objective, point) !== value) return bad("the model's point does not reach the printed optimum");
  try {
    return { answer: "optimum", value: `${value}`, witness: Object.fromEntries(q.spec.vars.map((v, i) => [v, `${point[i]}`])), statement: optimumStatement(q, value), ...at };
  } catch (error) {
    if (error instanceof UnsafeText) return bad(error.message);
    throw error;
  }
}

// --- Running a recipe ------------------------------------------------------------------------------

/** The `smt.z3` capability as a function (`registrySolvers(...).smt`). */
export type SmtCall = (input: { smtlib: string; timeoutSec: number; model?: boolean }, signal?: AbortSignal) => Promise<SmtOutput>;

/** Runs Spacer on a transition system and reads its invariant strictly. */
export async function findInvariant(smt: SmtCall, sys: ParsedSystem, signal?: AbortSignal): Promise<InvariantOutcome> {
  return readInvariant(sys, await smt({ smtlib: chcScript(sys), timeoutSec: sys.spec.timeoutSec ?? 20, model: true }, signal));
}

/** Runs Optimize on a question and reads its optimum strictly. */
export async function findOptimum(smt: SmtCall, q: ParsedOptimum, signal?: AbortSignal): Promise<OptimumOutcome> {
  return readOptimum(q, await smt({ smtlib: optimumScript(q), timeoutSec: q.spec.timeoutSec ?? 20, model: true }, signal));
}
