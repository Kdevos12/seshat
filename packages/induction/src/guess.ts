import { hashJson, type Json } from "@seshat/core";
import { type ComputeTool, ComputeUnsuited, registryCompute, rtoNumber } from "@seshat/classical";
import { isInterrupted, type ProblemContext } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { admitCounterexample, readCounterexamples, recordDrop } from "./cegis.ts";
import { add, eq, isZero, mul, ONE, type Rat, rat, show } from "./rational.ts";
import { describeRecurrence, guessHolonomic, guessLinearRecurrence, type Recurrence } from "./recurrence.ts";
import { statementProblem } from "./screen.ts";

/**
 * Guessing and growth through `compute.python` (plan change CX8, moves E4 and E12), in line M8's classical step. For an
 * integer column of M8's table (a sequence indexed by n), two questions go to Python on Pyodide:
 *
 * - **closed form**: the recurrence Seshat guessed from the terms (Berlekamp-Massey, else a holonomic guess) goes to sympy's
 *   `rsolve` with the first terms as initial values; the solution comes back as a small JSON tree (integers, rationals, `n`,
 *   sums, products, powers, factorials, binomials);
 * - **growth**: a Richardson extrapolation of the ratios and of the log-log slopes gives the base `μ` and the exponent `α` of
 *   `a(n) ≍ μ^n n^α`, made exact by sympy's `nsimplify` (small denominators), and the constant `C` of `a(n) ~ C μ^n n^α` is
 *   looked up by mpmath's `identify` among combinations of π and e, returned as a tree.
 *
 * The tool is untrusted. Its last line of output is read strictly (`parseClosedForm`, `parseGrowth`): anything else gives
 * nothing. A closed form is evaluated exactly at every n of the table, the counterexample set's objects first (the CEGIS rule,
 * PD5), and is dropped on the first term it disagrees with; a growth is checked against a first-order Richardson estimate of
 * the tail of the terms. What survives becomes a candidate of M8's pool, whose Lean statement Seshat writes itself from the tree
 * (`closedFormStatement`, `growthStatement`); it becomes an `open` claim there, with a `sequence_guess` evidence node. Only a
 * prover's Lean proof through `validate` changes its status. The programs are for `compute.python` only: Sage refuses their
 * imports, so a host without `compute.python` runs none of this (documentation/induction.md, "Guessing and growth").
 */
export const SEQUENCE_GUESS_KIND = "sequence_guess";

/** The capability the programs are written for: never sent to Sage. */
export const GUESS_CAPABILITY = "compute.python";

/** A closed form as the tool may return it, read strictly. `n` is the sequence's index. */
export type ClosedForm =
  | { op: "int"; value: bigint }
  | { op: "rat"; value: Rat }
  | { op: "n" }
  | { op: "pi" }
  | { op: "e" }
  | { op: "add"; args: ClosedForm[] }
  | { op: "mul"; args: ClosedForm[] }
  | { op: "pow"; base: ClosedForm; exp: ClosedForm }
  | { op: "fact"; arg: ClosedForm }
  | { op: "binom"; top: ClosedForm; bottom: ClosedForm };

/** The growth `a(n) ≍ base^n n^exponent`, and the constant of `a(n) ~ constant · base^n n^exponent` when one was identified. */
export interface Growth {
  base: Rat;
  exponent: Rat;
  constant?: ClosedForm;
}

const LIMITS = { nodes: 64, depth: 12, arity: 8, digits: 40, power: 512, factorial: 1000, bits: 200_000, denominator: 12 };
const INTEGER = /^-?(?:0|[1-9]\d{0,39})$/u;
const POSITIVE = /^[1-9]\d{0,39}$/u;

/** Reads a closed-form tree (`["add", ["n"], ["int", "1"]]`); undefined for anything outside the grammar or the size limits. */
export function parseClosedForm(raw: unknown): ClosedForm | undefined {
  let nodes = 0;
  const read = (x: unknown, depth: number): ClosedForm | undefined => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth || !Array.isArray(x) || typeof x[0] !== "string") return undefined;
    const [op, ...rest] = x as [string, ...unknown[]];
    const all = (items: unknown[]): ClosedForm[] | undefined => {
      const out: ClosedForm[] = [];
      for (const item of items) {
        const f = read(item, depth + 1);
        if (f === undefined) return undefined;
        out.push(f);
      }
      return out;
    };
    switch (op) {
      case "int":
        return rest.length === 1 && typeof rest[0] === "string" && INTEGER.test(rest[0]) ? { op, value: BigInt(rest[0]) } : undefined;
      case "rat":
        return rest.length === 2 && typeof rest[0] === "string" && typeof rest[1] === "string" && INTEGER.test(rest[0]) && POSITIVE.test(rest[1]) ? { op, value: rat(BigInt(rest[0]), BigInt(rest[1])) } : undefined;
      case "n":
      case "pi":
      case "e":
        return rest.length === 0 ? { op } : undefined;
      case "add":
      case "mul": {
        if (rest.length < 2 || rest.length > LIMITS.arity) return undefined;
        const args = all(rest);
        return args === undefined ? undefined : { op, args };
      }
      case "pow":
      case "binom": {
        const args = rest.length === 2 ? all(rest) : undefined;
        if (args === undefined) return undefined;
        const [a, b] = args as [ClosedForm, ClosedForm];
        return op === "pow" ? { op, base: a, exp: b } : { op, top: a, bottom: b };
      }
      case "fact": {
        const args = rest.length === 1 ? all(rest) : undefined;
        return args === undefined ? undefined : { op, arg: args[0] as ClosedForm };
      }
      default:
        return undefined;
    }
  };
  return read(raw, 0);
}

const bits = (x: bigint): number => (x < 0n ? -x : x).toString(2).length;

/** The exact value of the closed form at `n`, or undefined where it has none (π, a fractional power, a division by zero, a factorial of a negative number, a size limit). */
export function evalClosedForm(f: ClosedForm, n: bigint): Rat | undefined {
  const integer = (g: ClosedForm, min: bigint, max: bigint): bigint | undefined => {
    const v = evalClosedForm(g, n);
    return v === undefined || v.d !== 1n || v.n < min || v.n > max ? undefined : v.n;
  };
  switch (f.op) {
    case "int":
      return rat(f.value);
    case "rat":
      return f.value;
    case "n":
      return rat(n);
    case "pi":
    case "e":
      return undefined;
    case "add":
    case "mul": {
      let total = f.op === "add" ? rat(0) : ONE;
      for (const g of f.args) {
        const v = evalClosedForm(g, n);
        if (v === undefined) return undefined;
        total = f.op === "add" ? add(total, v) : mul(total, v);
        if (bits(total.n) + bits(total.d) > LIMITS.bits) return undefined;
      }
      return total;
    }
    case "pow": {
      const base = evalClosedForm(f.base, n);
      const k = integer(f.exp, BigInt(-LIMITS.power), BigInt(LIMITS.power));
      if (base === undefined || k === undefined || (k < 0n && isZero(base))) return undefined;
      if ((bits(base.n) + bits(base.d)) * Number(k < 0n ? -k : k) > LIMITS.bits) return undefined;
      const e = k < 0n ? -k : k;
      const value = rat(base.n ** e, base.d ** e);
      return k < 0n ? rat(value.d, value.n) : value;
    }
    case "fact": {
      const m = integer(f.arg, 0n, BigInt(LIMITS.factorial));
      if (m === undefined) return undefined;
      let p = 1n;
      for (let i = 2n; i <= m; i++) p *= i;
      return rat(p);
    }
    case "binom": {
      const top = integer(f.top, 0n, BigInt(LIMITS.factorial));
      const bottom = integer(f.bottom, 0n, BigInt(LIMITS.factorial));
      if (top === undefined || bottom === undefined) return undefined;
      // Lean's `Nat.choose`: 0 when the bottom is larger.
      if (bottom > top) return rat(0);
      let c = 1n;
      for (let i = 0n; i < bottom; i++) c = (c * (top - i)) / (i + 1n);
      return rat(c);
    }
  }
}

/** The value of a closed form without `n` (a constant), as a float; NaN where it has none. */
export function evalConstant(f: ClosedForm): number {
  switch (f.op) {
    case "int":
      return Number(f.value);
    case "rat":
      return rtoNumber(f.value);
    case "n":
      return Number.NaN;
    case "pi":
      return Math.PI;
    case "e":
      return Math.E;
    case "add":
      return f.args.reduce((a, g) => a + evalConstant(g), 0);
    case "mul":
      return f.args.reduce((a, g) => a * evalConstant(g), 1);
    case "pow":
      return evalConstant(f.base) ** evalConstant(f.exp);
    case "fact": {
      const m = evalConstant(f.arg);
      if (!Number.isInteger(m) || m < 0 || m > 170) return Number.NaN;
      let p = 1;
      for (let i = 2; i <= m; i++) p *= i;
      return p;
    }
    case "binom":
      return Number.NaN;
  }
}

/** The closed form in words, for the logs, the gloss and the evidence node (Seshat's printing, not the tool's text). */
export function showClosedForm(f: ClosedForm): string {
  const wrap = (g: ClosedForm): string => (g.op === "add" || g.op === "mul" || (g.op === "int" && g.value < 0n) || g.op === "rat" ? `(${showClosedForm(g)})` : showClosedForm(g));
  switch (f.op) {
    case "int":
      return `${f.value}`;
    case "rat":
      return show(f.value);
    case "n":
    case "pi":
    case "e":
      return f.op;
    case "add":
      return f.args.map(showClosedForm).join(" + ");
    case "mul":
      return f.args.map(wrap).join(" * ");
    case "pow":
      return `${wrap(f.base)}^${wrap(f.exp)}`;
    case "fact":
      return `${wrap(f.arg)}!`;
    case "binom":
      return `C(${showClosedForm(f.top)}, ${showClosedForm(f.bottom)})`;
  }
}

/** A natural-number term in `n` (no subtraction, no division), or undefined: what may stand inside a factorial, a binomial or an exponent. */
function natLean(f: ClosedForm): string | undefined {
  switch (f.op) {
    case "n":
      return "n";
    case "int":
      return f.value >= 0n ? `${f.value}` : undefined;
    case "add":
    case "mul": {
      const parts = f.args.map(natLean);
      return parts.some((p) => p === undefined) ? undefined : `(${parts.join(f.op === "add" ? " + " : " * ")})`;
    }
    default:
      return undefined;
  }
}

const constantInteger = (f: ClosedForm): bigint | undefined => (f.op === "int" ? f.value : f.op === "mul" && f.args.length === 2 && f.args.every((g) => g.op === "int") ? (f.args[0] as { value: bigint }).value * (f.args[1] as { value: bigint }).value : undefined);

/** The closed form as a Lean term of `ℚ` in `n : ℕ`, or undefined outside the exact fragment (π, e, a fractional power, a subtraction inside a factorial). */
export function closedFormLean(f: ClosedForm, field: "ℚ" | "ℝ" = "ℚ"): string | undefined {
  const write = (g: ClosedForm): string | undefined => closedFormLean(g, field);
  switch (f.op) {
    case "int":
      return `(${f.value} : ${field})`;
    case "rat":
      return f.value.d === 1n ? `(${f.value.n} : ${field})` : `((${f.value.n} : ${field}) / ${f.value.d})`;
    case "n":
      return `(n : ${field})`;
    case "pi":
      return field === "ℝ" ? "Real.pi" : undefined;
    case "e":
      return field === "ℝ" ? "(Real.exp 1)" : undefined;
    case "add":
    case "mul": {
      const parts = f.args.map(write);
      return parts.some((p) => p === undefined) ? undefined : `(${parts.join(f.op === "add" ? " + " : " * ")})`;
    }
    case "pow": {
      const base = write(f.base);
      if (base === undefined) return undefined;
      const k = constantInteger(f.exp);
      if (k === 1n || k === -1n) return k === 1n ? base : `${base}⁻¹`;
      if (k !== undefined) return k >= 0n ? `(${base} ^ ${k})` : `(${base} ^ ${-k})⁻¹`;
      if (field === "ℝ" && f.exp.op === "rat") {
        const { n: p, d: q } = f.exp.value;
        if (q === 2n && (p === 1n || p === -1n)) return p === 1n ? `(Real.sqrt ${base})` : `(Real.sqrt ${base})⁻¹`;
        return `(${base} ^ ((${p} : ℝ) / ${q}))`;
      }
      const up = natLean(f.exp);
      if (up !== undefined) return `(${base} ^ ${up})`;
      // `b ^ (-e)` with a natural e: the inverse of `b ^ e`.
      if (f.exp.op === "mul" && f.exp.args.length === 2 && f.exp.args[0]?.op === "int" && f.exp.args[0].value === -1n) {
        const down = natLean(f.exp.args[1] as ClosedForm);
        if (down !== undefined) return `(${base} ^ ${down})⁻¹`;
      }
      return undefined;
    }
    case "fact": {
      const m = natLean(f.arg);
      return m === undefined ? undefined : `((Nat.factorial ${m} : ℕ) : ${field})`;
    }
    case "binom": {
      const top = natLean(f.top);
      const bottom = natLean(f.bottom);
      return top === undefined || bottom === undefined ? undefined : `((Nat.choose ${top} ${bottom} : ℕ) : ${field})`;
    }
  }
}

/** The conjecture that a column with Lean term `lean` (in `n`, of type ℕ) equals the closed form for every n, in signature form. */
export function closedFormStatement(lean: string, f: ClosedForm): string | undefined {
  const rhs = closedFormLean(f);
  return rhs === undefined ? undefined : `(n : ℕ) : ((${lean} : ℕ) : ℚ) = ${rhs}`;
}

const realRat = (r: Rat): string => (r.d === 1n ? `(${r.n} : ℝ)` : `((${r.n} : ℝ) / ${r.d})`);

/**
 * The growth as a conjecture about the column with Lean term `lean`: `Asymptotics.IsEquivalent` with the constant when one was
 * identified, else `Asymptotics.IsTheta`, along `Filter.atTop` and as functions from ℕ to ℝ.
 */
export function growthStatement(lean: string, g: Growth): string | undefined {
  const factors: string[] = [];
  if (g.constant !== undefined) {
    const c = closedFormLean(g.constant, "ℝ");
    if (c === undefined) return undefined;
    factors.push(c);
  }
  if (!eq(g.base, ONE)) factors.push(`${realRat(g.base)} ^ n`);
  if (!isZero(g.exponent)) factors.push(`(n : ℝ) ^ ${realRat(g.exponent)}`);
  if (factors.length === 0) factors.push("(1 : ℝ)");
  const relation = g.constant !== undefined ? "Asymptotics.IsEquivalent" : "Asymptotics.IsTheta";
  return `: ${relation} Filter.atTop (fun n : ℕ => ((${lean} : ℕ) : ℝ)) (fun n : ℕ => ${factors.join(" * ")})`;
}

const SMALL = /^-?\d{1,6}$/u;

/** Reads a growth answer: `{"base": ["4", "1"], "exponent": ["-3", "2"], "constant": tree | null}`; undefined for anything else. */
export function parseGrowth(raw: unknown): Growth | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "base" && k !== "exponent" && k !== "constant")) return undefined;
  const fraction = (x: unknown): Rat | undefined => {
    if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== "string" || typeof x[1] !== "string" || !SMALL.test(x[0]) || !/^[1-9]\d{0,5}$/u.test(x[1])) return undefined;
    const r = rat(BigInt(x[0]), BigInt(x[1]));
    return r.d > BigInt(LIMITS.denominator) ? undefined : r;
  };
  const base = fraction(o.base);
  const exponent = fraction(o.exponent);
  if (base === undefined || exponent === undefined || base.n <= 0n) return undefined;
  if (o.constant === undefined || o.constant === null) return { base, exponent };
  const constant = parseClosedForm(o.constant);
  if (constant === undefined) return undefined;
  const c = evalConstant(constant);
  return Number.isFinite(c) && c > 0 ? { base, exponent, constant } : undefined;
}

/** The first index whose term the closed form does not give (no value, or another one), or undefined when it gives every term. */
export function closedFormDisagreement(f: ClosedForm, terms: readonly bigint[], at: readonly number[] = terms.map((_, i) => i)): number | undefined {
  for (const i of at) {
    const term = terms[i];
    if (term === undefined) continue;
    const v = evalClosedForm(f, BigInt(i));
    if (v === undefined || v.d !== 1n || v.n !== term) return i;
  }
  return undefined;
}

/**
 * Why the terms do not support the growth, or undefined when they do: first-order Richardson estimates of the ratio, of the
 * log-log slope (with the claimed base) and of the constant at the last terms, within 5%, 0.15 and 5%. A necessary check, not a
 * proof: an asymptotic claim is not refuted by finitely many terms, and stays open.
 */
export function growthDisagreement(g: Growth, terms: readonly bigint[]): string | undefined {
  const t = terms.map((x) => Number(x));
  const last = t.length - 1;
  if (last < 3 || t.slice(-4).some((x) => !(x > 0))) return "too few positive terms";
  const mu = rtoNumber(g.base);
  const alpha = rtoNumber(g.exponent);
  const richardson = (s: (k: number) => number): number => last * s(last) - (last - 1) * s(last - 1);
  const ratio = richardson((k) => (t[k] as number) / (t[k - 1] as number));
  if (!(Math.abs(ratio - mu) <= 0.05 * mu)) return `the ratio of the terms tends to about ${ratio.toPrecision(4)}, not ${show(g.base)}`;
  const logB = (k: number): number => Math.log(t[k] as number) - k * Math.log(mu);
  const slope = richardson((k) => (logB(k) - logB(k - 1)) / Math.log(k / (k - 1)));
  if (!(Math.abs(slope - alpha) <= 0.15)) return `the log-log slope of the terms tends to about ${slope.toPrecision(4)}, not ${show(g.exponent)}`;
  if (g.constant !== undefined) {
    const c = evalConstant(g.constant);
    const estimate = richardson((k) => Math.exp(logB(k) - alpha * Math.log(k)));
    if (!(Math.abs(estimate - c) <= 0.05 * c)) return `the constant of the terms tends to about ${estimate.toPrecision(4)}, not ${showClosedForm(g.constant)}`;
  }
  return undefined;
}

/** Python that reads `DATA` (a JSON text written here) first. */
const pythonWith = (data: unknown, body: string): string => `DATA = ${JSON.stringify(JSON.stringify(data))}\n${body}`;

/** The tree printer the programs share: a sympy expression to the JSON tree `parseClosedForm` reads, or a ValueError. */
const TREE = `
def tree(e, depth=0):
    if depth > 12:
        raise ValueError("too deep")
    if e == n:
        return ["n"]
    if e.is_Integer:
        return ["int", str(int(e))]
    if e.is_Rational:
        return ["rat", str(e.p), str(e.q)]
    if e == sympy.pi:
        return ["pi"]
    if e == sympy.E:
        return ["e"]
    if e.is_Add:
        return ["add"] + [tree(x, depth + 1) for x in e.args]
    if e.is_Mul:
        return ["mul"] + [tree(x, depth + 1) for x in e.args]
    if e.is_Pow:
        return ["pow", tree(e.base, depth + 1), tree(e.exp, depth + 1)]
    if isinstance(e, sympy.factorial):
        return ["fact", tree(e.args[0], depth + 1)]
    if isinstance(e, sympy.binomial):
        return ["binom", tree(e.args[0], depth + 1), tree(e.args[1], depth + 1)]
    raise ValueError("outside the closed forms")
`;

/** The `rsolve` program: the recurrence (integer polynomial coefficients) and the first terms in, one JSON line `{"closed": tree | null}` out. */
export function rsolveProgram(rec: Recurrence, initial: readonly bigint[]): string {
  const data = { coefficients: rec.coefficients.map((p) => p.map(String)), initial: initial.slice(0, rec.order).map(String) };
  return pythonWith(
    data,
    `import json
import sympy
DATA = json.loads(DATA)
n = sympy.Symbol("n", integer=True, nonnegative=True)
a = sympy.Function("a")
${TREE}
def poly(cs):
    return sum(sympy.Integer(int(c)) * n ** j for j, c in enumerate(cs))
def ungamma(g):
    x = g.args[0]
    k = sympy.simplify(x - n)
    if k.is_Integer:
        return sympy.factorial(n + k - 1)
    h = sympy.simplify(x - n - sympy.Rational(1, 2))
    if h.is_Integer:
        m = n + h
        return sympy.sqrt(sympy.pi) * sympy.factorial(2 * m) / (4 ** m * sympy.factorial(m))
    return g
rec = sum(poly(cs) * a(n + i) for i, cs in enumerate(DATA["coefficients"]))
init = {a(i): sympy.Integer(int(v)) for i, v in enumerate(DATA["initial"])}
out = {"closed": None}
try:
    sol = sympy.rsolve(rec, a(n), init)
except Exception:
    sol = None
if sol is not None:
    forms = []
    try:
        base = sol.rewrite(sympy.gamma).replace(lambda g: isinstance(g, sympy.gamma), ungamma)
        forms = [sympy.simplify(base), sympy.combsimp(base), base]
    except Exception:
        pass
    forms.append(sol)
    for form in forms:
        try:
            out = {"closed": tree(form)}
            break
        except Exception:
            pass
print(json.dumps(out))
`,
  );
}

/**
 * The growth program: the terms from index `first` (at least 1, all positive) in; Richardson extrapolations of order `order` of
 * the ratios, of the log-log slopes and of the constant, made exact by `nsimplify` and `identify`; one JSON line out, the
 * `parseGrowth` shape, or `{"growth": null}` when an extrapolation does not settle.
 */
export function growthProgram(terms: readonly bigint[], first: number, order = 6): string {
  return pythonWith(
    { terms: terms.map(String), first, order, denominator: LIMITS.denominator },
    `import json
from fractions import Fraction
import mpmath
import sympy
DATA = json.loads(DATA)
mpmath.mp.dps = 60
n = sympy.Symbol("n", integer=True, nonnegative=True)
${TREE}
t = [mpmath.mpf(int(x)) for x in DATA["terms"]]
first = int(DATA["first"])
M = int(DATA["order"])
den = int(DATA["denominator"])
def richardson(s, start):
    m = len(s) - 1 - M
    k = start + m
    total = mpmath.mpf(0)
    for j in range(M + 1):
        total += s[m + j] * mpmath.mpf(k + j) ** M * (-1) ** (M - j) / (mpmath.factorial(j) * mpmath.factorial(M - j))
    return total
def limit(s, start):
    x = richardson(s, start)
    return x, abs(x - richardson(s[:-1], start))
def small(x):
    try:
        q = sympy.nsimplify(mpmath.nstr(x, 15), rational=True, tolerance=sympy.Rational(1, 10 ** 4))
        if q.is_Rational and q.q <= den and abs(x - mpmath.mpf(int(q.p)) / int(q.q)) < mpmath.mpf(10) ** -4:
            return q
    except Exception:
        pass
    f = Fraction(mpmath.nstr(x, 30)).limit_denominator(den)
    if abs(x - mpmath.mpf(f.numerator) / f.denominator) < mpmath.mpf(10) ** -4:
        return sympy.Rational(f.numerator, f.denominator)
    return None
def answer():
    if len(t) < M + 4:
        return {"growth": None}
    ratios = [t[i] / t[i - 1] for i in range(1, len(t))]
    mu_x, mu_err = limit(ratios, first + 1)
    if mu_x <= 0 or mu_err > mpmath.mpf(10) ** -4 * abs(mu_x):
        return {"growth": None}
    mu = small(mu_x)
    if mu is None or mu <= 0:
        return {"growth": None}
    logb = [mpmath.log(t[i]) - (first + i) * mpmath.log(mpmath.mpf(int(mu.p)) / int(mu.q)) for i in range(len(t))]
    slopes = [(logb[i] - logb[i - 1]) / mpmath.log(mpmath.mpf(first + i) / (first + i - 1)) for i in range(1, len(t))]
    alpha_x, alpha_err = limit(slopes, first + 1)
    if alpha_err > mpmath.mpf(10) ** -3:
        return {"growth": None}
    alpha = small(alpha_x)
    if alpha is None:
        return {"growth": None}
    out = {"base": [str(mu.p), str(mu.q)], "exponent": [str(alpha.p), str(alpha.q)], "constant": None}
    consts = [mpmath.exp(logb[i] - (mpmath.mpf(int(alpha.p)) / int(alpha.q)) * mpmath.log(first + i)) for i in range(len(t))]
    c_x, c_err = limit(consts, first)
    if c_x > 0 and c_err < mpmath.mpf(10) ** -5 * c_x:
        found = mpmath.identify(c_x, {"pi": mpmath.pi, "E": mpmath.e}, tol=mpmath.mpf(10) ** -6)
        if found:
            try:
                out["constant"] = tree(sympy.sympify(found, locals={"pi": sympy.pi, "E": sympy.E}))
            except Exception:
                pass
    return out
print(json.dumps(answer()))
`,
  );
}

/** The JSON value the tool printed on the last line of its output, or undefined. */
function lastJson(stdout: string): unknown {
  const last = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1);
  if (last === undefined || last.length > 100_000) return undefined;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return undefined;
  }
}

/** One integer column of the table, as a sequence: its terms from n = 0 (the prefix of exact non-negative integers), and its Lean term in `n` when it has one. */
export interface GuessSequence {
  column: string;
  terms: bigint[];
  lean?: string;
}

/** The data of a `sequence_guess` node: one question to the tool for a column, what it answered and what came of it. */
export interface SequenceGuessData {
  /** The hash of the method, the column and the data sent: a resumed problem does not ask again. */
  key: string;
  /** The problem's claim. */
  target: string;
  column: string;
  method: "rsolve" | "growth";
  /** `found`: a candidate; `none`: the tool found nothing; `malformed`: its answer was not in the shape; `disagrees`: it failed a known term or the tail; `unstated`: no Lean statement could be written. */
  answer: "found" | "none" | "malformed" | "disagrees" | "unstated";
  terms: number;
  recurrence?: string;
  closedForm?: string;
  base?: string;
  exponent?: string;
  constant?: string;
  disagreesAt?: number;
  detail?: string;
  statement?: string;
  informal?: string;
}

/** A candidate for M8's pool, with the evidence node the pool writes on its claim. */
export interface GuessCandidate {
  statement: string;
  informal: string;
  source: string;
  interest: number;
  evidence: SequenceGuessData;
}

/** The interest of a candidate in the pool: an exact closed form checked on every term above a growth. */
const INTEREST = { rsolve: 0.9, equivalent: 0.7, theta: 0.6 };

/** At most this many columns are sent, each at most twice (a closed form, a growth). */
export const GUESS_COLUMNS = 8;

/** The sequence of an integer column: the exact non-negative integers from n = 0, up to the first value that is not one. */
export function sequenceOf(column: string, values: ReadonlyArray<number | null>, lean?: string): GuessSequence {
  const terms: bigint[] = [];
  for (const v of values) {
    if (v === null || !Number.isSafeInteger(v) || v < 0) break;
    terms.push(BigInt(v));
  }
  return { column, terms, ...(lean !== undefined ? { lean } : {}) };
}

/** Whether the terms grow at the end: positive from index 1 and strictly increasing on their last third. */
function grows(terms: readonly bigint[]): boolean {
  if (terms.length < 13 || terms.slice(1).some((t) => t <= 0n)) return false;
  const tail = terms.slice(Math.floor((2 * terms.length) / 3));
  return tail.every((t, i) => i === 0 || t > (tail[i - 1] as bigint));
}

/** Whether the host offers `compute.python`; a registry stand-in without `offers` offers nothing. */
export function offersPython(registry: ProblemContext["registry"]): boolean {
  try {
    return registry.offers(GUESS_CAPABILITY);
  } catch {
    return false;
  }
}

/** The recurrence the closed form is asked for: Berlekamp-Massey's (as M8's classical step), else a holonomic one of order and degree at most 2. */
function recurrenceOf(terms: readonly bigint[]): Recurrence | undefined {
  return guessLinearRecurrence(terms, { maxOrder: 6 }) ?? guessHolonomic(terms, { maxOrder: 2, maxDegree: 2, minSurplus: 6 });
}

export interface GuessSettings {
  timeoutSec: number;
  /** The counterexample set (PD5): its numbers are tried first, and a drop by one is counted. */
  counterexampleSet: boolean;
  /** The compute tool; default: the registry's, for `compute.python` only. */
  compute?: ComputeTool;
}

/**
 * Asks the tool about each sequence, at most twice, and returns the candidates that survive the checks. Every question's
 * outcome other than a candidate is a `sequence_guess` node on the target; a candidate's node is written by the pool on the
 * claim it becomes (`recordGuessEvidence`). A question already answered for the target (a node with its key) is not asked again.
 */
export async function sequenceGuesses(problem: ProblemContext, actor: string, sequences: readonly GuessSequence[], settings: GuessSettings): Promise<GuessCandidate[]> {
  const line = actor.replace(/^line:/u, "");
  const memory = problem.memory.withActor(actor);
  const done = new Map<string, SequenceGuessData>();
  for (const node of memory.nodes(SEQUENCE_GUESS_KIND)) {
    const d = node.data as unknown as SequenceGuessData;
    if (d.target === problem.claimId) done.set(d.key, d);
  }
  const set = settings.counterexampleSet ? readCounterexamples(memory, problem.claimId) : [];
  let tool: ComputeTool | undefined = settings.compute;
  let made = false;
  const out: GuessCandidate[] = [];
  const ask = async (code: string): Promise<unknown> => {
    if (tool === undefined) {
      tool = registryCompute(problem.registry, { actor, scope: `${problem.runId}/${problem.problemId}/${line}.guess` });
      made = true;
    }
    if (tool === undefined) throw new ComputeUnsuited([GUESS_CAPABILITY], "none");
    const answer = await tool.run({ [GUESS_CAPABILITY]: code }, { timeoutSec: settings.timeoutSec, signal: problem.signal });
    return lastJson(answer.stdout);
  };
  const settle = (data: SequenceGuessData): void => {
    if (data.answer === "found" && data.statement !== undefined && data.informal !== undefined) {
      out.push({ statement: data.statement, informal: data.informal, source: `guess:${data.method}`, interest: data.method === "rsolve" ? INTEREST.rsolve : data.constant !== undefined ? INTEREST.equivalent : INTEREST.theta, evidence: data });
      return;
    }
    if (!done.has(data.key)) memory.recordNode({ kind: SEQUENCE_GUESS_KIND, claimId: problem.claimId, data: data as unknown as Json });
  };
  try {
    for (const seq of sequences.slice(0, GUESS_COLUMNS)) {
      const questions: Array<{ method: "rsolve" | "growth"; rec?: Recurrence }> = [];
      const rec = seq.terms.length >= 12 ? recurrenceOf(seq.terms) : undefined;
      if (rec !== undefined) questions.push({ method: "rsolve", rec });
      if (grows(seq.terms)) questions.push({ method: "growth" });
      for (const q of questions) {
        const sent = q.method === "rsolve" ? { coefficients: (q.rec as Recurrence).coefficients.map((p) => p.map(String)), initial: seq.terms.slice(0, (q.rec as Recurrence).order).map(String) } : { terms: seq.terms.slice(1).map(String) };
        const key = hashJson({ method: q.method, column: seq.column, sent, terms: seq.terms.map(String) } as unknown as Json).slice(0, 16);
        const known = done.get(key);
        if (known !== undefined) {
          settle(known);
          continue;
        }
        const data: SequenceGuessData = { key, target: problem.claimId, column: seq.column, method: q.method, answer: "none", terms: seq.terms.length, ...(q.rec !== undefined ? { recurrence: describeRecurrence(q.rec) } : {}) };
        let raw: unknown;
        try {
          raw = await ask(q.method === "rsolve" ? rsolveProgram(q.rec as Recurrence, seq.terms) : growthProgram(seq.terms.slice(1), 1));
        } catch (error) {
          // The tool cannot be reached or refused the call: nothing is recorded, and the later questions are not asked.
          if (isInterrupted(error) || problem.signal.aborted) throw error;
          problem.log(`${line}: the guessing through ${GUESS_CAPABILITY} stopped: ${error instanceof Error ? error.message : String(error)}`);
          return out;
        }
        if (q.method === "rsolve") closedFormOutcome(memory, problem.claimId, line, seq, raw, set, data);
        else growthOutcome(seq, raw, data);
        problem.log(`${line}: ${q.method === "rsolve" ? "a closed form" : "the growth"} of the column ${seq.column} through ${GUESS_CAPABILITY}: ${data.answer}${data.detail !== undefined ? ` (${data.detail})` : ""}`);
        settle(data);
      }
    }
  } finally {
    if (made) await (tool as ComputeTool | undefined)?.release?.();
  }
  return out;
}

/** Reads and checks a closed-form answer into `data`. */
function closedFormOutcome(memory: MemoryStore, claimId: string, line: string, seq: GuessSequence, raw: unknown, set: ReturnType<typeof readCounterexamples>, data: SequenceGuessData): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some((k) => k !== "closed")) {
    Object.assign(data, { answer: "malformed", detail: "the answer is not one JSON object {closed}" });
    return;
  }
  const closedRaw = (raw as { closed?: unknown }).closed;
  if (closedRaw === null || closedRaw === undefined) {
    data.detail = "rsolve found no closed form in the fragment";
    return;
  }
  const f = parseClosedForm(closedRaw);
  if (f === undefined) {
    Object.assign(data, { answer: "malformed", detail: "the closed form is outside the grammar or its limits" });
    return;
  }
  data.closedForm = showClosedForm(f);
  // The counterexample set first (PD5): a number that refuted an earlier candidate, whose term is known.
  const fromSet = set.filter((c) => typeof c.object === "number" && Number.isInteger(c.object) && (c.object as number) >= 0 && (c.object as number) < seq.terms.length);
  const bySet = closedFormDisagreement(f, seq.terms, fromSet.map((c) => c.object as number));
  if (bySet !== undefined) {
    const by = fromSet.find((c) => c.object === bySet) as (typeof fromSet)[number];
    recordDrop(memory, claimId, { line: `line:${line}`, candidate: `guess/${seq.column}/${data.key}`, by, tokensSaved: 0 });
    Object.assign(data, { answer: "disagrees", disagreesAt: bySet, detail: `it fails the known counterexample ${by.id}` });
    return;
  }
  const at = closedFormDisagreement(f, seq.terms);
  if (at !== undefined) {
    admitCounterexample(memory, claimId, { object: at, id: String(at), source: "table_run", refutes: `guess/${seq.column}/closed_form` });
    Object.assign(data, { answer: "disagrees", disagreesAt: at, detail: `it does not give the term at n = ${at}` });
    return;
  }
  const statement = seq.lean !== undefined ? closedFormStatement(seq.lean, f) : undefined;
  finish(data, statement, seq.lean, `the column ${seq.column} is ${data.closedForm} for every n (sympy's rsolve of ${data.recurrence ?? "its recurrence"}; every one of the ${seq.terms.length} terms agrees; unproved)`);
}

/** Reads and checks a growth answer into `data`. */
function growthOutcome(seq: GuessSequence, raw: unknown, data: SequenceGuessData): void {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 1 && (raw as { growth?: unknown }).growth === null) {
    data.detail = "the extrapolations did not settle";
    return;
  }
  const g = parseGrowth(raw);
  if (g === undefined) {
    Object.assign(data, { answer: "malformed", detail: "the answer is not {base, exponent, constant} with small rationals" });
    return;
  }
  Object.assign(data, { base: show(g.base), exponent: show(g.exponent), ...(g.constant !== undefined ? { constant: showClosedForm(g.constant) } : {}) });
  if (eq(g.base, ONE) && isZero(g.exponent)) {
    data.detail = "the terms do not grow";
    return;
  }
  const why = growthDisagreement(g, seq.terms);
  if (why !== undefined) {
    Object.assign(data, { answer: "disagrees", detail: why });
    return;
  }
  const shape = `${g.constant !== undefined ? `${data.constant} * ` : ""}${eq(g.base, ONE) ? "" : `(${data.base})^n * `}n^(${data.exponent})`;
  const statement = seq.lean !== undefined ? growthStatement(seq.lean, g) : undefined;
  finish(data, statement, seq.lean, `the column ${seq.column} grows like ${shape} (${g.constant !== undefined ? "asymptotically equal, the constant by mpmath's identify" : "up to constant factors"}; a Richardson fit of the ${seq.terms.length} terms; unproved)`);
}

function finish(data: SequenceGuessData, statement: string | undefined, lean: string | undefined, informal: string): void {
  if (statement === undefined) {
    Object.assign(data, { answer: "unstated", detail: lean === undefined ? "the column has no Lean term" : "the form has no exact Lean writing", informal });
    return;
  }
  const refused = statementProblem(statement);
  if (refused !== undefined) {
    Object.assign(data, { answer: "unstated", detail: `the statement was refused: ${refused}`, informal });
    return;
  }
  Object.assign(data, { answer: "found", statement, informal });
}

/** Writes a candidate's evidence on the claim it became, once. */
export function recordGuessEvidence(memory: MemoryStore, claimId: string, data: SequenceGuessData): void {
  if (memory.nodes(SEQUENCE_GUESS_KIND, { claimId }).some((n) => (n.data as { key?: string }).key === data.key)) return;
  memory.recordNode({ kind: SEQUENCE_GUESS_KIND, claimId, data: data as unknown as Json });
}
