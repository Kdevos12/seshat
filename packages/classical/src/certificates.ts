import { type LeanChecker, leanTextProblems } from "@seshat/core";
import type { Registry } from "@seshat/registry";
import { parseStatement, type Term, Unreadable, canonicalSort } from "./parse.ts";
import { ldlt, ONE, Poly, type Rat, rat, rcmp, rdiv, rmul, rneg, roundTo, rsign, rsub, radd, isInteger, isZero, solveLinear, toPoly, ZERO } from "./polynomial.ts";
import type { TryRecord } from "./posterior.ts";
import { type Goal, snippetFor, succeeded } from "./tactics.ts";

/**
 * The certificate stage of the battery (plan change CX4, Ruling 47): for a goal the router tags E6 ("a
 * certificate of a bound or an impossibility"), after the tactics and before the ATPs, with no model call,
 * four generators in order: (a) a modular obstruction of an integer equation, (b) the cofactors of an ideal
 * membership written for `linear_combination`, (c) a sum of squares (with Putinar multipliers) for
 * `nlinarith` or `linear_combination`, (d) Bernstein coefficients on a box, joined by interval splitting.
 * Every candidate is a Lean text written here from integers, rationals and the goal's own variable and
 * hypothesis names, never from text a tool wrote; it passes the screen, is checked like a tactic, and goes
 * to `validate` like a tactic's success. The stage changes no status. Documented in documentation/classical.md.
 */
export const CERTIFICATE_METHODS = ["modular", "polyrith", "sos", "bernstein"] as const;
export type CertificateMethod = (typeof CERTIFICATE_METHODS)[number];

/** The name a method's tries carry in `battery_run` and the posteriors: `cert.modular`, ... */
export const certificateTactic = (method: CertificateMethod): string => `cert.${method}`;

export interface CertificateSettings {
  /** The largest modulus (a) tries. */
  maxModulus: number;
  /** The most boxes (d) splits a box into. */
  maxBoxes: number;
  /** Seconds of the battery's budget kept for the stage on a goal tagged E6 (at most half the budget). */
  reserveSec: number;
  /** The methods, in the order they run. */
  methods: readonly CertificateMethod[];
}

export const DEFAULT_CERTIFICATES: CertificateSettings = { maxModulus: 64, maxBoxes: 16, reserveSec: 30, methods: CERTIFICATE_METHODS };

/** The most residue tuples (a) enumerates for one modulus, which is also what `decide` must check. */
export const MAX_RESIDUE_CASES = 4096;
/** Seconds one certificate's Lean check may take. */
export const CERTIFICATE_TRY_SEC = 30;
/** Seconds one compute call may take. */
export const COMPUTE_CALL_SEC = 30;

// --- The compute tool ---------------------------------------------------------------------------

/** What a compute capability (`compute.python`, `compute.sage`) answered: what the code printed, and its last value. */
export interface ComputeAnswer {
  stdout: string;
  result?: string | null;
}

/** The host's compute tool as the stage uses it: one session (scope) per goal. */
export interface ComputeTool {
  /** The capability that answers, for the notes. */
  capability: string;
  run(code: string, options: { timeoutSec: number; signal?: AbortSignal }): Promise<ComputeAnswer>;
  /** Ends the session. */
  release?(): Promise<void>;
}

/**
 * The compute capabilities the stage uses, in order: `compute.python` first, because its pinned package set has
 * both sympy and clarabel (plan change CX3); Sage has sympy, and (c) then fails at the import of clarabel.
 */
export const CERTIFICATE_COMPUTE: readonly string[] = ["compute.python", "compute.sage"];

/** The registry's compute tool for the stage, as tool runs of `actor` in `scope`; undefined when the host offers none. */
export function registryCompute(registry: Pick<Registry, "offers" | "invoke" | "release">, options: { actor: string; scope: string }): ComputeTool | undefined {
  const capability = CERTIFICATE_COMPUTE.find((c) => registry.offers(c));
  if (capability === undefined) return undefined;
  return {
    capability,
    async run(code, { timeoutSec, signal }) {
      const result = await registry.invoke(capability, { code, timeout: timeoutSec }, { actor: options.actor, scope: options.scope, ...(signal !== undefined ? { signal } : {}) });
      const out = (result.output ?? {}) as { stdout?: unknown; result?: unknown };
      return { stdout: typeof out.stdout === "string" ? out.stdout : "", ...(typeof out.result === "string" ? { result: out.result } : {}) };
    },
    release: () => registry.release(options.scope),
  };
}

// --- The goal as polynomials --------------------------------------------------------------------

export type Rel = "=" | "≤" | "<";

/** `lhs rel rhs`, with `≥` and `>` turned around. */
export interface Atom {
  rel: Rel;
  lhs: Poly;
  rhs: Poly;
}

export interface Hypothesis {
  /** The name a proof refers to it by: the goal's own, or a fresh one the prelude introduces. */
  name: string;
  atom: Atom;
}

export type NumberSort = "ℕ" | "ℤ" | "ℚ" | "ℝ" | "ℂ";

/** A goal read as polynomials over one number sort. */
export interface PolyGoal {
  sort: NumberSort;
  vars: string[];
  /** Tactic lines that bring the conclusion's binders and hypotheses into the context (`intro`, `rintro`). */
  prelude: string[];
  hyps: Hypothesis[];
  /** The goal after the prelude: a relation, or `False`. */
  target: { kind: "atom"; atom: Atom } | { kind: "false" };
  /** Makes a name the statement does not use. */
  fresh: (base: string) => string;
}

const SORTS = new Set<string>(["ℕ", "ℤ", "ℚ", "ℝ", "ℂ"]);
const IDENT = /[\p{L}_][\p{L}\p{N}_'₀-₉]*/gu;

function atomOf(t: Term, vars: readonly string[], sort: NumberSort): Atom | undefined {
  if (t.k !== "app" || !t.op || t.args.length !== 2) return undefined;
  const flip = t.fn === "≥" || t.fn === ">";
  const rel: Rel | undefined = t.fn === "=" ? "=" : t.fn === "≤" || t.fn === "≥" ? "≤" : t.fn === "<" || t.fn === ">" ? "<" : undefined;
  if (rel === undefined) return undefined;
  const opts = { divide: sort === "ℚ" || sort === "ℝ" || sort === "ℂ", subtract: sort !== "ℕ" };
  const a = toPoly(t.args[0] as Term, vars, opts);
  const b = toPoly(t.args[1] as Term, vars, opts);
  if (a === undefined || b === undefined) return undefined;
  if (rel !== "=" && sort === "ℂ") return undefined;
  return flip ? { rel, lhs: b, rhs: a } : { rel, lhs: a, rhs: b };
}

/** The conjuncts of `a ∧ b ∧ c`. */
const conjuncts = (t: Term): Term[] => (t.k === "app" && t.op && t.fn === "∧" && t.args.length === 2 ? [...conjuncts(t.args[0] as Term), ...conjuncts(t.args[1] as Term)] : [t]);

/**
 * Reads a statement as a polynomial goal: variables of one number sort (`ℕ`, `ℤ`, `ℚ`, `ℝ`, `ℂ`), hypotheses
 * that are polynomial relations (others are left aside: a certificate need not use them), and a conclusion that
 * is a relation, `≠`, `¬ (a = b)`, `¬ ∃ xs, P ∧ ...`, `False`, behind `∀` binders and `→` hypotheses. Returns
 * the reason when it cannot.
 */
export function readPolyGoal(statement: string): PolyGoal | string {
  let parsed;
  try {
    parsed = parseStatement(statement);
  } catch (error) {
    if (error instanceof Unreadable) return `unreadable: ${error.message}`;
    throw error;
  }
  const used = new Set(statement.match(IDENT) ?? []);
  const fresh = (base: string): string => {
    let name = base;
    for (let i = 0; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  };
  const vars: string[] = [];
  const sorts = new Set<string>();
  const rawHyps: Array<{ name: string; prop: Term }> = [];
  for (const b of parsed.binders) {
    if (b.kind === "inst") return "an instance binder";
    if (b.kind === "var") {
      if (vars.includes(b.name)) return `the variable ${b.name} is bound twice`;
      vars.push(b.name);
      sorts.add(canonicalSort(b.type));
    } else rawHyps.push({ name: b.name, prop: b.prop });
  }
  const prelude: string[] = [];
  const bindAll = (bound: ReadonlyArray<{ name: string; type?: string }>): string | undefined => {
    for (const v of bound) {
      if (v.type === undefined) return "a binder without a type";
      if (vars.includes(v.name)) return `the variable ${v.name} is bound twice`;
      vars.push(v.name);
      sorts.add(canonicalSort(v.type));
    }
    return undefined;
  };
  // Peel the conclusion: `∀` binders and `→` hypotheses are introduced; `≠`, `¬ (a = b)` and `¬ ∃` become a hypothesis and `False`.
  let falseTarget = false;
  let t: Term = parsed.conclusion;
  for (let guard = 0; ; guard++) {
    if (guard > 64) return "too many binders";
    const negated = t.k === "app" && t.op && t.fn === "¬" && t.args.length === 1 ? (t.args[0] as Term) : undefined;
    if (t.k === "quant" && t.q === "∀") {
      const bad = bindAll(t.vars);
      if (bad !== undefined) return bad;
      prelude.push(`intro ${t.vars.map((v) => v.name).join(" ")}`);
      t = t.body;
    } else if (t.k === "app" && t.op && t.fn === "→" && t.args.length === 2) {
      const name = fresh("hcx");
      prelude.push(`intro ${name}`);
      rawHyps.push({ name, prop: t.args[0] as Term });
      t = t.args[1] as Term;
    } else if ((t.k === "app" && t.op && t.fn === "≠" && t.args.length === 2) || (negated?.k === "app" && negated.op && negated.fn === "=")) {
      const name = fresh("hcx");
      prelude.push(`intro ${name}`);
      rawHyps.push({ name, prop: negated ?? { k: "app", fn: "=", args: (t as Extract<Term, { k: "app" }>).args, op: true } });
      falseTarget = true;
      break;
    } else if (negated?.k === "quant" && negated.q === "∃") {
      const bad = bindAll(negated.vars);
      if (bad !== undefined) return bad;
      const parts = conjuncts(negated.body);
      const names = parts.map(() => fresh("hcx"));
      parts.forEach((p, i) => rawHyps.push({ name: names[i] as string, prop: p }));
      prelude.push(`rintro ⟨${[...negated.vars.map((v) => v.name), ...names].join(", ")}⟩`);
      falseTarget = true;
      break;
    } else {
      falseTarget = t.k === "lit" && !t.value;
      break;
    }
  }
  if (vars.length === 0) return "no variable";
  if (sorts.size !== 1) return `the variables are of ${sorts.size} sorts`;
  const sort = [...sorts][0] as string;
  if (!SORTS.has(sort)) return `the sort ${sort} is not a number sort`;
  const s = sort as NumberSort;
  let target: PolyGoal["target"] = { kind: "false" };
  if (!falseTarget) {
    const atom = atomOf(t, vars, s);
    if (atom === undefined) return "the conclusion is not a polynomial relation";
    target = { kind: "atom", atom };
  }
  const hyps: Hypothesis[] = [];
  for (const h of rawHyps) {
    const atom = atomOf(h.prop, vars, s);
    if (atom !== undefined) hyps.push({ name: h.name, atom });
  }
  return { sort: s, vars, prelude, hyps, target, fresh };
}

// --- Lean writers -------------------------------------------------------------------------------

/** A rational as a Lean numeral of the sort: `(3 : ℝ)`, `(-3 / 4 : ℝ)`. */
export function ratLean(r: Rat, sort: string): string {
  return r.d === 1n ? `(${r.n} : ${sort})` : `(${r.n} / ${r.d} : ${sort})`;
}

/** A polynomial as Lean text over the goal's variable names: `x ^ 2 * y - (3 / 4 : ℝ) * x + (1 : ℝ)`. */
export function polyLean(p: Poly, vars: readonly string[], sort: string): string {
  const terms = p.terms();
  if (terms.length === 0) return `(0 : ${sort})`;
  const parts: string[] = [];
  terms.forEach(([m, c], index) => {
    const factors = m.flatMap((e, i) => (e === 0 ? [] : [e === 1 ? (vars[i] as string) : `${vars[i] as string} ^ ${e}`]));
    const negative = rsign(c) < 0;
    const abs = negative ? rneg(c) : c;
    let text: string;
    if (factors.length === 0) text = ratLean(index === 0 ? c : abs, sort);
    else if (abs.n === 1n && abs.d === 1n && (index > 0 || !negative)) text = factors.join(" * ");
    else text = `${ratLean(index === 0 ? c : abs, sort)} * ${factors.join(" * ")}`;
    parts.push(index === 0 ? text : `${negative ? "-" : "+"} ${text}`);
  });
  return parts.join(" ");
}

/** A bullet of a case split: the first line after `· `, the rest indented under it. */
const bullet = (lines: readonly string[]): string[] => lines.map((l, i) => (i === 0 ? `· ${l}` : `  ${l}`));

// --- What the stage proposes --------------------------------------------------------------------

export interface Candidate {
  method: CertificateMethod;
  /** The tactic proof, without `by`. */
  script: string;
  /** What it rests on, for the notes: `mod 4`, `3 squares`, `4 boxes`. */
  detail: string;
}

/** Why a method gave no candidate on a goal. */
export interface CertificateNote {
  method: CertificateMethod;
  note: string;
}

type Generated = { candidates: Candidate[]; note?: string };

// --- (a) Modular obstruction --------------------------------------------------------------------

/** The moduli up to `maxModulus` at which `p = 0` has no solution, by the number of residue tuples, smallest first. */
export function obstructingModuli(p: Poly, maxModulus: number, maxCases = MAX_RESIDUE_CASES): number[] {
  const vs = p.variables();
  const found: Array<{ m: number; cases: number }> = [];
  for (let m = 2; m <= maxModulus; m++) {
    const cases = m ** vs.length;
    if (cases > maxCases) break;
    const values = new Array<number>(p.nvars).fill(0);
    let solvable = false;
    for (let c = 0; c < cases && !solvable; c++) {
      let rest = c;
      for (const v of vs) {
        values[v] = rest % m;
        rest = Math.floor(rest / m);
      }
      if (p.evalMod(values, m) === 0) solvable = true;
    }
    if (!solvable) found.push({ m, cases });
  }
  return found.sort((a, b) => a.cases - b.cases || a.m - b.m).map((f) => f.m);
}

/**
 * (a) An integer equation with no solution modulo some `m`: the equation cast to `ZMod m`, its variables
 * generalized to residues, and `decide` on every residue tuple. Over `ℕ` and `ℤ`; an equation hypothesis
 * makes any goal follow (`exfalso`).
 */
export function modularCandidates(goal: PolyGoal, settings: Pick<CertificateSettings, "maxModulus">): Generated {
  if (goal.sort !== "ℤ" && goal.sort !== "ℕ") return { candidates: [], note: `outside the fragment: the variables are of ${goal.sort}, not ℕ or ℤ` };
  const equations = goal.hyps.filter((h) => h.atom.rel === "=");
  if (equations.length === 0) return { candidates: [], note: "outside the fragment: no integer equation to reduce" };
  const candidates: Candidate[] = [];
  for (const h of equations) {
    const p = h.atom.lhs.sub(h.atom.rhs);
    if (p.variables().length === 0 || !p.integral()) continue;
    for (const m of obstructingModuli(p, settings.maxModulus).slice(0, 2)) {
      const cast = goal.sort === "ℤ" ? "Int.cast : ℤ → ZMod" : "Nat.cast : ℕ → ZMod";
      const hm = goal.fresh("hmod");
      const residues = p.variables().map((v) => ({ v: goal.vars[v] as string, r: goal.fresh("res") }));
      const lines = [
        ...goal.prelude,
        ...(goal.target.kind === "false" ? [] : ["exfalso"]),
        `have ${hm} := congrArg (${cast} ${m}) ${h.name}`,
        `push_cast at ${hm}`,
        `revert ${hm}`,
        ...residues.map(({ v, r }) => `generalize (${v} : ZMod ${m}) = ${r}`),
        `revert ${residues.map((x) => x.r).join(" ")}`,
        "decide",
      ];
      candidates.push({ method: "modular", script: lines.join("\n"), detail: `mod ${m}` });
    }
  }
  return candidates.length > 0 ? { candidates } : { candidates: [], note: `no modulus up to ${settings.maxModulus} obstructs the equation` };
}

// --- Data exchanged with the compute tool -------------------------------------------------------

type WirePoly = Array<[number[], string, string]>;
const wire = (p: Poly): WirePoly => p.terms().map(([m, c]) => [m, `${c.n}`, `${c.d}`]);

/** Reads a polynomial a tool sent back, strictly: undefined at the first thing out of shape. */
function unwire(raw: unknown, nvars: number): Poly | undefined {
  if (!Array.isArray(raw)) return undefined;
  const terms: Array<[number[], Rat]> = [];
  for (const t of raw) {
    if (!Array.isArray(t) || t.length !== 3) return undefined;
    const [m, n, d] = t as unknown[];
    if (!Array.isArray(m) || m.length !== nvars || !m.every((e) => Number.isInteger(e) && (e as number) >= 0 && (e as number) <= 64)) return undefined;
    if (typeof n !== "string" || typeof d !== "string" || !/^-?\d{1,200}$/u.test(n) || !/^[1-9]\d{0,199}$/u.test(d)) return undefined;
    terms.push([m as number[], rat(BigInt(n), BigInt(d))]);
  }
  return new Poly(nvars, terms);
}

/** The JSON object a tool printed on the last line of its output, or undefined. */
function lastJson(answer: ComputeAnswer): unknown {
  const lines = answer.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.at(-1);
  if (last === undefined || last.length > 4_000_000) return undefined;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return undefined;
  }
}

/** Python that reads `DATA` (a JSON text written here) first. Plain Python plus sympy, which Sage has too. */
const pythonWith = (data: unknown, body: string): string => `DATA = ${JSON.stringify(JSON.stringify(data))}\n${body}`;

/**
 * (b)'s program: sympy's Gröbner basis says whether the target lies in the ideal of the hypotheses; then the
 * cofactors, by an ansatz of growing degree solved exactly over `Fraction`. It prints one JSON line.
 */
export const POLYRITH_PY = String.raw`import json
from fractions import Fraction
import sympy
D = json.loads(DATA)
n = int(D["nvars"])
def rd(p):
    return {tuple(int(k) for k in e): Fraction(int(a), int(b)) for e, a, b in p}
gens = [rd(g) for g in D["gens"]]
target = rd(D["target"])
xs = sympy.symbols("v0:%d" % n)
def ex(p):
    return sympy.Add(*[sympy.Rational(c.numerator, c.denominator) * sympy.Mul(*[x ** k for x, k in zip(xs, e)]) for e, c in p.items()])
def deg(p):
    return max([sum(e) for e in p] + [0])
def monos(d, k):
    if k == 0:
        return [()]
    return [(a,) + m for a in range(d + 1) for m in monos(d - a, k - 1)]
def solve(rows, rhs, ncols):
    rows = [dict(r) for r in rows]
    rhs = list(rhs)
    piv = {}
    r = 0
    for col in range(ncols):
        if r == len(rows):
            break
        p = next((i for i in range(r, len(rows)) if rows[i].get(col, 0) != 0), None)
        if p is None:
            continue
        rows[r], rows[p] = rows[p], rows[r]
        rhs[r], rhs[p] = rhs[p], rhs[r]
        inv = Fraction(1) / rows[r][col]
        rows[r] = {j: v * inv for j, v in rows[r].items()}
        rhs[r] = rhs[r] * inv
        for i in range(len(rows)):
            f = rows[i].get(col, 0)
            if i == r or f == 0:
                continue
            for j, v in rows[r].items():
                w = rows[i].get(j, 0) - f * v
                if w == 0:
                    rows[i].pop(j, None)
                else:
                    rows[i][j] = w
            rhs[i] = rhs[i] - f * rhs[r]
        piv[col] = r
        r += 1
    if any(rhs[i] != 0 for i in range(r, len(rows))):
        return None
    x = [Fraction(0)] * ncols
    for col, i in piv.items():
        x[col] = rhs[i]
    return x
G = sympy.groebner([ex(g) for g in gens], *xs, order="grevlex")
out = {"member": bool(G.contains(ex(target))), "cofactors": None}
if out["member"]:
    top = max([deg(target)] + [deg(g) for g in gens])
    for extra in range(int(D["extra"]) + 1):
        bound = top + extra
        cols = [(i, m) for i, g in enumerate(gens) if bound >= deg(g) for m in monos(bound - deg(g), n)]
        eqs = {}
        for j, (i, m) in enumerate(cols):
            for e, c in gens[i].items():
                key = tuple(a + b for a, b in zip(e, m))
                row = eqs.setdefault(key, {})
                row[j] = row.get(j, 0) + c
        if any(k not in eqs for k in target):
            continue
        keys = list(eqs)
        sol = solve([eqs[k] for k in keys], [target.get(k, Fraction(0)) for k in keys], len(cols))
        if sol is not None:
            cof = [[] for _ in gens]
            for j, (i, m) in enumerate(cols):
                if sol[j] != 0:
                    cof[i].append([list(m), str(sol[j].numerator), str(sol[j].denominator)])
            out["cofactors"] = cof
            break
print(json.dumps(out))
`;

/** How many degrees above the goal's the cofactor ansatz of (b) goes. */
const POLYRITH_EXTRA_DEGREE = 2;
/** The most variables (b) and (c) send to the tool. */
const MAX_CERT_VARS = 6;

/**
 * (b) The target equation as a combination of the equation hypotheses, `target = Σ cᵢ · hᵢ`, the cofactors
 * from the compute tool, checked here exactly, written for `linear_combination`.
 */
export async function polyrithCandidates(goal: PolyGoal, compute: ComputeTool | undefined, options: { timeoutSec: number; signal?: AbortSignal }): Promise<Generated> {
  if (goal.target.kind !== "atom" || goal.target.atom.rel !== "=") return { candidates: [], note: "outside the fragment: the conclusion is not an equation" };
  if (goal.sort === "ℕ") return { candidates: [], note: "outside the fragment: ℕ is no ring for linear_combination" };
  const eqs = goal.hyps.filter((h) => h.atom.rel === "=");
  if (eqs.length === 0) return { candidates: [], note: "outside the fragment: no equation hypothesis" };
  if (goal.vars.length > MAX_CERT_VARS) return { candidates: [], note: `outside the fragment: more than ${MAX_CERT_VARS} variables` };
  if (compute === undefined) return { candidates: [], note: "skipped: the host offers no compute tool (compute.python or compute.sage)" };
  const n = goal.vars.length;
  const gens = eqs.map((h) => h.atom.lhs.sub(h.atom.rhs));
  const target = goal.target.atom.lhs.sub(goal.target.atom.rhs);
  const answer = await compute.run(pythonWith({ nvars: n, gens: gens.map(wire), target: wire(target), extra: POLYRITH_EXTRA_DEGREE }, POLYRITH_PY), options);
  const out = lastJson(answer) as { member?: unknown; cofactors?: unknown } | undefined;
  if (out === undefined || typeof out !== "object" || out === null || typeof out.member !== "boolean") return { candidates: [], note: `${compute.capability} gave no answer in the expected form` };
  if (!out.member) return { candidates: [], note: "the conclusion is not in the ideal of the equation hypotheses" };
  if (out.cofactors === null) return { candidates: [], note: `no cofactors up to degree +${POLYRITH_EXTRA_DEGREE}` };
  if (!Array.isArray(out.cofactors) || out.cofactors.length !== gens.length) return { candidates: [], note: `${compute.capability} gave no answer in the expected form` };
  const cofactors: Poly[] = [];
  for (const raw of out.cofactors as unknown[]) {
    const p = unwire(raw, n);
    if (p === undefined) return { candidates: [], note: `${compute.capability} gave no answer in the expected form` };
    cofactors.push(p);
  }
  // The identity is checked here, exactly: a wrong answer is no candidate.
  let sum = new Poly(n);
  cofactors.forEach((c, i) => (sum = sum.add(c.mul(gens[i] as Poly))));
  if (!sum.equals(target)) return { candidates: [], note: `the cofactors ${compute.capability} gave do not combine to the conclusion` };
  if (goal.sort === "ℤ" && !cofactors.every((c) => c.integral())) return { candidates: [], note: "the cofactors have denominators, which ℤ does not have" };
  const terms = cofactors.flatMap((c, i) => (c.isZero() ? [] : [`(${polyLean(c, goal.vars, goal.sort)}) * ${(eqs[i] as Hypothesis).name}`]));
  const script = [...goal.prelude, `linear_combination ${terms.join(" + ")}`].join("\n");
  return { candidates: [{ method: "polyrith", script, detail: `${terms.length} cofactor(s)` }] };
}

// --- (c) Sums of squares ------------------------------------------------------------------------

/** The monomials of total degree at most `d` over the variables `vs` of `n`, each exponent at most `cap[v]`. */
function monomials(n: number, vs: readonly number[], d: number, cap: (v: number) => number, low = 0): number[][] {
  const out: number[][] = [];
  const rec = (i: number, left: number, cur: number[]): void => {
    if (i === vs.length) {
      if (d - left >= low) out.push([...cur]);
      return;
    }
    const v = vs[i] as number;
    for (let e = 0; e <= Math.min(left, cap(v)); e++) {
      cur[v] = e;
      rec(i + 1, left - e, cur);
    }
    cur[v] = 0;
  };
  rec(0, d, new Array<number>(n).fill(0));
  return out;
}

/** The most monomials in one Gram basis, and the most unknowns of the whole program. */
const MAX_BASIS = 36;
const MAX_UNKNOWNS = 2000;

interface Block {
  /** The multiplier: 1, or a hypothesis `0 ≤ g`. */
  g: Poly;
  hyp?: Hypothesis;
  basis: number[][];
  /** The index of the block's first unknown. */
  offset: number;
}

interface SosProgram {
  blocks: Block[];
  rows: Array<Array<[number, Rat]>>;
  rhs: Rat[];
  nx: number;
}

/** The linear constraints `f = Σ g_b · z_bᵀ Q_b z_b` over the upper triangles of the `Q_b`, column by column. */
function sosProgram(f: Poly, blocks: Array<Omit<Block, "offset">>): SosProgram | string {
  const n = f.nvars;
  const rowOf = new Map<string, number>();
  const rows: Array<Map<number, Rat>> = [];
  const placed: Block[] = [];
  let k = 0;
  for (const b of blocks) {
    placed.push({ ...b, offset: k });
    const s = b.basis.length;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i <= j; i++, k++) {
        const w = i === j ? ONE : rat(2);
        for (const [gm, gc] of b.g.terms()) {
          const alpha = (b.basis[i] as number[]).map((e, v) => e + ((b.basis[j] as number[])[v] as number) + (gm[v] as number));
          const key = alpha.join(",");
          let r = rowOf.get(key);
          if (r === undefined) {
            r = rows.length;
            rowOf.set(key, r);
            rows.push(new Map());
          }
          const row = rows[r] as Map<number, Rat>;
          row.set(k, radd(row.get(k) ?? ZERO, rmul(w, gc)));
        }
      }
    }
  }
  for (const [m] of f.terms()) if (!rowOf.has(m.join(","))) return "the basis does not reach every monomial of the polynomial";
  const rhs: Rat[] = new Array<Rat>(rows.length).fill(ZERO);
  for (const [key, r] of rowOf) rhs[r] = f.coefficient(key.split(",").map(Number).slice(0, n));
  return { blocks: placed, rows: rows.map((r) => [...r].filter(([, v]) => !isZero(v))), rhs, nx: k };
}

/** (c)'s program: clarabel maximizes `t` with every Gram matrix `⪰ t·I`, `t ≤ 1`, under the linear constraints. One JSON line. */
export const SOS_PY = String.raw`import json, math
import numpy as np
import scipy.sparse as sp
import clarabel
D = json.loads(DATA)
sizes = [int(s) for s in D["blocks"]]
nx = int(D["nx"])
t = nx
rows, cols, vals, b = [], [], [], []
r = 0
for row, rhs in zip(D["rows"], D["rhs"]):
    for c, v in row:
        rows.append(r)
        cols.append(int(c))
        vals.append(float(v))
    b.append(float(rhs))
    r += 1
neq = r
rows.append(r)
cols.append(t)
vals.append(1.0)
b.append(1.0)
r += 1
k = 0
for s in sizes:
    for j in range(s):
        for i in range(j + 1):
            rows.append(r)
            cols.append(k)
            vals.append(-1.0 if i == j else -math.sqrt(2.0))
            if i == j:
                rows.append(r)
                cols.append(t)
                vals.append(1.0)
            b.append(0.0)
            r += 1
            k += 1
A = sp.csc_matrix((vals, (rows, cols)), shape=(r, nx + 1))
P = sp.csc_matrix((nx + 1, nx + 1))
q = np.zeros(nx + 1)
q[t] = -1.0
cones = [clarabel.ZeroConeT(neq), clarabel.NonnegativeConeT(1)] + [clarabel.PSDTriangleConeT(s) for s in sizes]
settings = clarabel.DefaultSettings()
settings.verbose = False
settings.time_limit = float(D["timeLimit"])
solver = clarabel.DefaultSolver(P, q, A, np.array(b), cones, settings)
sol = solver.solve()
print(json.dumps({"status": str(sol.status), "x": [float(v) for v in sol.x]}))
`;

/** The denominators the Gram matrices are rounded to, coarsest first: the first that gives an exact certificate wins. */
const ROUNDINGS: readonly bigint[] = [1n, 2n, 4n, 10n, 100n, 1000n, 10n ** 4n, 10n ** 5n, 10n ** 6n, 10n ** 7n, 10n ** 8n];

interface SosTerm {
  /** `d · g · l²`. */
  d: Rat;
  block: Block;
  l: Poly;
}

/**
 * Rounds the SDP's answer to rationals, projects it exactly onto the linear constraints, and factors each Gram
 * matrix by exact LDLᵀ. Undefined when no rounding gives positive semidefinite matrices.
 */
export function roundSos(f: Poly, program: SosProgram, x: readonly number[]): SosTerm[] | undefined {
  for (const den of ROUNDINGS) {
    const q: Rat[] = [];
    for (let k = 0; k < program.nx; k++) {
      const r = roundTo(x[k] as number, den);
      if (r === undefined) return undefined;
      q.push(r);
    }
    // Project onto R q = b: q' = q - Rᵀ y with (R Rᵀ) y = R q - b.
    const residual = program.rows.map((row, i) => rsub(row.reduce((acc, [k, v]) => radd(acc, rmul(v, q[k] as Rat)), ZERO), program.rhs[i] as Rat));
    let projected = q;
    if (residual.some((r) => !isZero(r))) {
      const byCol = program.rows.map((row) => new Map(row));
      const gram = program.rows.map((ri) => byCol.map((rj, j) => [j, ri.reduce((acc, [k, v]) => (rj.has(k) ? radd(acc, rmul(v, rj.get(k) as Rat)) : acc), ZERO)] as [number, Rat]));
      const y = solveLinear(gram, residual, program.rows.length);
      if (y === undefined) continue;
      projected = [...q];
      program.rows.forEach((row, i) => {
        for (const [k, v] of row) projected[k] = rsub(projected[k] as Rat, rmul(v, y[i] as Rat));
      });
    }
    const terms: SosTerm[] = [];
    let ok = true;
    for (const block of program.blocks) {
      const s = block.basis.length;
      const m: Rat[][] = Array.from({ length: s }, () => new Array<Rat>(s).fill(ZERO));
      let k = block.offset;
      for (let j = 0; j < s; j++) for (let i = 0; i <= j; i++, k++) {
        (m[i] as Rat[])[j] = projected[k] as Rat;
        (m[j] as Rat[])[i] = projected[k] as Rat;
      }
      const f2 = ldlt(m);
      if (f2 === undefined) {
        ok = false;
        break;
      }
      for (let c = 0; c < s; c++) {
        const d = f2.D[c] as Rat;
        if (isZero(d)) continue;
        let l = new Poly(f.nvars);
        for (let i = c; i < s; i++) {
          const coef = (f2.L[i] as Rat[])[c] as Rat;
          if (!isZero(coef)) l = l.add(new Poly(f.nvars, [[block.basis[i] as number[], coef]]));
        }
        // The sign of a squared term is free: its leading coefficient is made positive, for the reader of the proof.
        const lead = l.terms()[0];
        if (lead !== undefined && rsign(lead[1]) < 0) l = l.neg();
        terms.push({ d, block, l });
      }
    }
    if (!ok) continue;
    // The identity, checked exactly once more: f = Σ d · g · l².
    let sum = new Poly(f.nvars);
    for (const t of terms) sum = sum.add(t.block.g.mul(t.l.mul(t.l)).scale(t.d));
    if (sum.equals(f)) return terms;
  }
  return undefined;
}

/** The Lean texts of a sum of squares: `nlinarith` with the squares as hints, then the identity closed by `linear_combination`. */
function sosScripts(goal: PolyGoal, terms: readonly SosTerm[]): string[] {
  const s = goal.sort;
  const lean = (p: Poly): string => polyLean(p, goal.vars, s);
  const names = new Map<Block, string>();
  const haves: string[] = [];
  for (const t of terms) {
    if (t.block.hyp === undefined || names.has(t.block)) continue;
    const name = goal.fresh("hpos");
    names.set(t.block, name);
    haves.push(`have ${name} : (0 : ${s}) ≤ ${lean(t.block.g)} := by linarith`);
  }
  const hints = terms.map((t) => (t.block.hyp === undefined ? `sq_nonneg (${lean(t.l)})` : `mul_nonneg ${names.get(t.block) as string} (sq_nonneg (${lean(t.l)}))`));
  const hintScript = [...goal.prelude, ...haves, `nlinarith [${hints.join(", ")}]`].join("\n");
  const pieces = terms.map((t) => {
    const g = t.block.hyp === undefined ? "" : ` * (${lean(t.block.g)})`;
    const term = `${ratLean(t.d, s)}${g} * (${lean(t.l)}) ^ 2`;
    const coef = t.block.hyp === undefined ? "mul_nonneg (by norm_num)" : `mul_nonneg (mul_nonneg (by norm_num) ${names.get(t.block) as string})`;
    return { term, proof: `${coef} (sq_nonneg (${lean(t.l)}))` };
  });
  let sumText = (pieces.at(-1) as { term: string }).term;
  let proofText = (pieces.at(-1) as { proof: string }).proof;
  for (let i = pieces.length - 2; i >= 0; i--) {
    sumText = `${(pieces[i] as { term: string }).term} + (${sumText})`;
    proofText = `add_nonneg (${(pieces[i] as { proof: string }).proof}) (${proofText})`;
  }
  const hs = goal.fresh("hsos");
  const identity = [...goal.prelude, ...haves, `have ${hs} : (0 : ${s}) ≤ ${sumText} := ${proofText}`, `linear_combination ${hs}`].join("\n");
  return [hintScript, identity];
}

/**
 * (c) `lhs ≤ rhs` over `ℝ` or `ℚ` as `rhs - lhs = Σ dᵢ lᵢ² (+ Σ g · Σ d l²)`: first a plain sum of squares, then
 * with the hypotheses `0 ≤ g` as Putinar multipliers. The SDP runs in the compute tool (clarabel); the rounding,
 * the projection, the LDLᵀ and the check of the identity run here, exactly.
 */
export async function sosCandidates(goal: PolyGoal, compute: ComputeTool | undefined, options: { timeoutSec: number; signal?: AbortSignal }): Promise<Generated> {
  if (goal.sort !== "ℝ" && goal.sort !== "ℚ") return { candidates: [], note: `outside the fragment: the variables are of ${goal.sort}, not ℝ or ℚ` };
  if (goal.target.kind !== "atom" || goal.target.atom.rel !== "≤") return { candidates: [], note: "outside the fragment: the conclusion is not a non-strict inequality" };
  const f = goal.target.atom.rhs.sub(goal.target.atom.lhs);
  if (f.variables().length === 0) return { candidates: [], note: "outside the fragment: no variable in the inequality" };
  if (goal.vars.length > MAX_CERT_VARS) return { candidates: [], note: `outside the fragment: more than ${MAX_CERT_VARS} variables` };
  const n = f.nvars;
  const multipliers = goal.hyps.filter((h) => h.atom.rel !== "=" && h.atom.rhs.sub(h.atom.lhs).variables().length > 0);
  const attempts: Array<Array<Omit<Block, "offset">>> = [];
  const half = Math.ceil(f.degree() / 2);
  if (f.degree() % 2 === 0) {
    // A plain sum of squares: the Newton polytope's box bounds the basis.
    const vs = f.variables();
    const low = Math.ceil(Math.min(...f.terms().map(([m]) => m.reduce((a, b) => a + b, 0))) / 2);
    attempts.push([{ g: Poly.constant(n, ONE), basis: monomials(n, vs, half, (v) => Math.floor(f.degreeIn(v) / 2), low) }]);
  }
  if (multipliers.length > 0) {
    const vs = [...new Set([...f.variables(), ...multipliers.flatMap((h) => h.atom.rhs.sub(h.atom.lhs).variables())])].sort((a, b) => a - b);
    const blocks: Array<Omit<Block, "offset">> = [{ g: Poly.constant(n, ONE), basis: monomials(n, vs, half, () => half) }];
    for (const h of multipliers) {
      const g = h.atom.rhs.sub(h.atom.lhs);
      const d = Math.floor((2 * half - g.degree()) / 2);
      if (d >= 0) blocks.push({ g, hyp: h, basis: monomials(n, vs, d, () => d) });
    }
    if (blocks.length > 1) attempts.push(blocks);
  }
  if (attempts.length === 0) return { candidates: [], note: "outside the fragment: an odd degree and no hypothesis to multiply" };
  if (compute === undefined) return { candidates: [], note: "skipped: the host offers no compute tool (compute.python with clarabel)" };
  let last = "no sum of squares found";
  for (const blocks of attempts) {
    if (blocks.some((b) => b.basis.length === 0 || b.basis.length > MAX_BASIS)) {
      last = `outside the fragment: a Gram basis of more than ${MAX_BASIS} monomials`;
      continue;
    }
    const program = sosProgram(f, blocks);
    if (typeof program === "string") {
      last = program;
      continue;
    }
    if (program.nx > MAX_UNKNOWNS) {
      last = `outside the fragment: more than ${MAX_UNKNOWNS} unknowns`;
      continue;
    }
    const data = {
      blocks: program.blocks.map((b) => b.basis.length),
      // Not read by the program: the monomials of each Gram basis, for a person reading the call in the journal.
      bases: program.blocks.map((b) => b.basis),
      nx: program.nx,
      rows: program.rows.map((row) => row.map(([k, v]) => [k, Number(v.n) / Number(v.d)])),
      rhs: program.rhs.map((v) => Number(v.n) / Number(v.d)),
      timeLimit: options.timeoutSec,
    };
    const answer = await compute.run(pythonWith(data, SOS_PY), options);
    const out = lastJson(answer) as { status?: unknown; x?: unknown } | undefined;
    if (out === undefined || typeof out !== "object" || out === null || typeof out.status !== "string" || !Array.isArray(out.x) || out.x.length !== program.nx + 1 || !out.x.every((v) => typeof v === "number" && Number.isFinite(v))) {
      last = `${compute.capability} gave no answer in the expected form`;
      continue;
    }
    if (!/Solved/u.test(out.status)) {
      last = `the SDP ended ${out.status.slice(0, 40)}`;
      continue;
    }
    const x = out.x as number[];
    if ((x[program.nx] as number) < -1e-7) {
      last = "the SDP found no positive semidefinite Gram matrix";
      continue;
    }
    const terms = roundSos(f, program, x);
    if (terms === undefined) {
      last = "no rounding of the SDP's answer gave an exact certificate";
      continue;
    }
    if (terms.length === 0) {
      last = "the polynomial is zero";
      continue;
    }
    const detail = `${terms.length} square(s)${blocks.length > 1 ? `, ${blocks.length - 1} multiplier(s)` : ""}`;
    return { candidates: sosScripts(goal, terms).map((script) => ({ method: "sos", script, detail })) };
  }
  return { candidates: [], note: last };
}

// --- (d) Bernstein subdivision ------------------------------------------------------------------

interface Bound {
  value: Rat;
  /** A proof of `0 ≤ x - lo` or of `0 ≤ hi - x`. */
  proof: string;
}

type BoxTree = { kind: "leaf"; coefficients: Array<{ index: number[]; b: Rat }> } | { kind: "split"; v: number; mid: Rat; low: BoxTree; high: BoxTree };

const binom = (n: number, k: number): bigint => {
  let r = 1n;
  for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i);
  return r;
};

/** The Bernstein coefficients of `f` on the box, over the multi-indices `I ≤ deg` of the variables `vs`. */
export function bernsteinCoefficients(f: Poly, vs: readonly number[], lo: readonly Rat[], hi: readonly Rat[]): Array<{ index: number[]; b: Rat }> {
  const n = f.nvars;
  // f(lo + w t), in t.
  const subs = Array.from({ length: n }, (_, v) => (vs.includes(v) ? Poly.constant(n, lo[v] as Rat).add(Poly.variable(n, v).scale(rsub(hi[v] as Rat, lo[v] as Rat))) : Poly.variable(n, v)));
  const g = f.compose(subs, n);
  const degs = vs.map((v) => f.degreeIn(v));
  const grid: number[][] = [[]];
  for (const d of degs) {
    const next: number[][] = [];
    for (const idx of grid) for (let i = 0; i <= d; i++) next.push([...idx, i]);
    grid.splice(0, grid.length, ...next);
  }
  const key = (idx: readonly number[]): string => idx.join(",");
  let coef = new Map<string, Rat>();
  for (const idx of grid) {
    const m = new Array<number>(n).fill(0);
    vs.forEach((v, i) => (m[v] = idx[i] as number));
    coef.set(key(idx), g.coefficient(m));
  }
  // One variable at a time: b_i = Σ_{j ≤ i} C(i, j) / C(n, j) a_j.
  degs.forEach((d, axis) => {
    const next = new Map<string, Rat>();
    for (const idx of grid) {
      let sum = ZERO;
      for (let j = 0; j <= (idx[axis] as number); j++) {
        const other = [...idx];
        other[axis] = j;
        sum = radd(sum, rmul(coef.get(key(other)) as Rat, rat(binom(idx[axis] as number, j), binom(d, j))));
      }
      next.set(key(idx), sum);
    }
    coef = next;
  });
  return grid.map((index) => ({ index, b: coef.get(key(index)) as Rat }));
}

/** The most Bernstein coefficients of one box. */
const MAX_BERNSTEIN_TERMS = 64;

/**
 * (d) `lhs ≤ rhs` (or `<`) over `ℝ` or `ℚ` with every variable of `rhs - lhs` between numeral bounds: the box is
 * split at midpoints until every box's Bernstein coefficients are nonnegative (positive for `<`), each box closed
 * by `linarith` (then `nlinarith`) with the Bernstein products as hints, the boxes joined by `rcases le_total`.
 */
export function bernsteinCandidates(goal: PolyGoal, settings: Pick<CertificateSettings, "maxBoxes">): Generated {
  if (goal.sort !== "ℝ" && goal.sort !== "ℚ") return { candidates: [], note: `outside the fragment: the variables are of ${goal.sort}, not ℝ or ℚ` };
  if (goal.target.kind !== "atom" || goal.target.atom.rel === "=") return { candidates: [], note: "outside the fragment: the conclusion is not an inequality" };
  const strict = goal.target.atom.rel === "<";
  const f = goal.target.atom.rhs.sub(goal.target.atom.lhs);
  const vs = f.variables();
  if (vs.length === 0) return { candidates: [], note: "outside the fragment: no variable in the inequality" };
  const lo: Array<Bound | undefined> = new Array(f.nvars).fill(undefined);
  const hi: Array<Bound | undefined> = new Array(f.nvars).fill(undefined);
  for (const h of goal.hyps) {
    if (h.atom.rel === "=") continue;
    const proof = h.atom.rel === "<" ? `${h.name}.le` : h.name;
    const left = h.atom.lhs.constantValue();
    const right = h.atom.rhs.constantValue();
    const single = (p: Poly): number | undefined => {
      const t = p.terms();
      if (t.length !== 1) return undefined;
      const [[m, c]] = t as [[number[], Rat]];
      const i = m.findIndex((e) => e === 1);
      return c.n === 1n && c.d === 1n && i >= 0 && m.reduce((a, b) => a + b, 0) === 1 ? i : undefined;
    };
    const v1 = single(h.atom.rhs);
    if (left !== undefined && v1 !== undefined && (lo[v1] === undefined || rcmp(left, (lo[v1] as Bound).value) > 0)) lo[v1] = { value: left, proof: `sub_nonneg.2 ${proof}` };
    const v2 = single(h.atom.lhs);
    if (right !== undefined && v2 !== undefined && (hi[v2] === undefined || rcmp(right, (hi[v2] as Bound).value) < 0)) hi[v2] = { value: right, proof: `sub_nonneg.2 ${proof}` };
  }
  const missing = vs.filter((v) => lo[v] === undefined || hi[v] === undefined);
  if (missing.length > 0) return { candidates: [], note: `outside the fragment: ${missing.map((v) => goal.vars[v]).join(", ")} without numeral bounds on both sides` };
  if (vs.some((v) => rcmp((lo[v] as Bound).value, (hi[v] as Bound).value) >= 0)) return { candidates: [], note: "outside the fragment: an empty box" };
  if (vs.reduce((acc, v) => acc * (f.degreeIn(v) + 1), 1) > MAX_BERNSTEIN_TERMS) return { candidates: [], note: `outside the fragment: more than ${MAX_BERNSTEIN_TERMS} Bernstein coefficients a box` };

  let boxes = 0;
  let failure: string | undefined;
  const build = (los: readonly Rat[], his: readonly Rat[]): BoxTree | undefined => {
    const coefficients = bernsteinCoefficients(f, vs, los, his);
    if (coefficients.every((c) => rsign(c.b) > 0 || (!strict && isZero(c.b)))) {
      boxes++;
      return boxes > settings.maxBoxes ? undefined : { kind: "leaf", coefficients };
    }
    // A corner's coefficient is the value there: below zero, the inequality is false on the box.
    const corner = coefficients.find((c) => c.index.every((i, k) => i === 0 || i === f.degreeIn(vs[k] as number)) && (rsign(c.b) < 0 || (strict && isZero(c.b))));
    if (corner !== undefined) {
      failure = "the inequality fails at a corner of a box";
      return undefined;
    }
    if (boxes >= settings.maxBoxes) return undefined;
    let v = vs[0] as number;
    for (const u of vs) if (rcmp(rsub(his[u] as Rat, los[u] as Rat), rsub(his[v] as Rat, los[v] as Rat)) > 0) v = u;
    const mid = rdiv(radd(los[v] as Rat, his[v] as Rat), rat(2));
    const lowHi = [...his];
    lowHi[v] = mid;
    const highLo = [...los];
    highLo[v] = mid;
    const low = build(los, lowHi);
    if (low === undefined) return undefined;
    const high = build(highLo, his);
    return high === undefined ? undefined : { kind: "split", v, mid, low, high };
  };
  const tree = build(lo.map((b) => b?.value ?? ZERO), hi.map((b) => b?.value ?? ZERO));
  if (tree === undefined) return { candidates: [], note: failure ?? `no certificate within ${settings.maxBoxes} boxes` };

  const s = goal.sort;
  const render = (node: BoxTree, los: ReadonlyArray<Bound | undefined>, his: ReadonlyArray<Bound | undefined>, tactic: string): string[] => {
    if (node.kind === "leaf") {
      const hints: string[] = [];
      for (const c of node.coefficients) {
        if (rsign(c.b) <= 0) continue;
        const factors: string[] = [];
        c.index.forEach((i, k) => {
          const v = vs[k] as number;
          const d = f.degreeIn(v);
          const power = (proof: string, e: number): string => (e === 1 ? proof : `pow_nonneg (${proof}) ${e}`);
          if (i > 0) factors.push(power((los[v] as Bound).proof, i));
          if (d - i > 0) factors.push(power((his[v] as Bound).proof, d - i));
        });
        if (factors.length === 0) continue;
        hints.push(factors.reduce((acc, x) => `mul_nonneg (${acc}) (${x})`));
      }
      return [`${tactic} [${hints.join(", ")}]`];
    }
    const name = goal.fresh("hbox");
    const x = goal.vars[node.v] as string;
    const lowHis = [...his];
    lowHis[node.v] = { value: node.mid, proof: `sub_nonneg.2 ${name}` };
    const highLos = [...los];
    highLos[node.v] = { value: node.mid, proof: `sub_nonneg.2 ${name}` };
    return [`rcases le_total ${x} ${ratLean(node.mid, s)} with ${name} | ${name}`, ...bullet(render(node.low, los, lowHis, tactic)), ...bullet(render(node.high, highLos, his, tactic))];
  };
  const detail = `${boxes} box(es)`;
  return {
    candidates: ["linarith", "nlinarith"].map((tactic) => ({ method: "bernstein" as const, script: [...goal.prelude, ...render(tree, lo, hi, tactic)].join("\n"), detail })),
  };
}

// --- The stage ----------------------------------------------------------------------------------

export interface CertificateStageOptions {
  checker: LeanChecker;
  goal: Goal;
  /** The router's primary domain: the posteriors are per (domain, method). */
  domain: string;
  settings: CertificateSettings;
  /** The host's compute tool; without it, (b) and (c) are skipped and say so. */
  compute?: ComputeTool;
  /** Seconds the stage may spend: Lean time plus the compute tool's time. */
  budgetSec: number;
  /** Hands a candidate Lean accepted to `validate`; true when it was accepted. At most `maxSubmissions` calls. */
  submit: (proof: string, method: CertificateMethod) => Promise<boolean>;
  maxSubmissions: number;
  signal?: AbortSignal;
}

export interface CertificateStageResult {
  tries: TryRecord[];
  winner?: { tactic: string; proof: string };
  /** Lean and compute time spent, in milliseconds. */
  cpuMs: number;
  /** Why each method that gave no accepted candidate gave none. */
  notes: CertificateNote[];
  submissions: number;
}

/**
 * The stage on one goal: the methods in order, each one's candidates checked by Lean one at a time with a short
 * time limit, until one is accepted by Lean and `submit` (which is `validate`), or the budget is spent. Each
 * Lean check is a try of `cert.<method>` (a `lean.check` tool run when the checker is the registry's), recorded
 * with its outcome for the posteriors; a compute call is a tool run of the compute capability.
 */
export async function runCertificates(options: CertificateStageOptions): Promise<CertificateStageResult> {
  const tries: TryRecord[] = [];
  const notes: CertificateNote[] = [];
  const budgetMs = options.budgetSec * 1000;
  let spent = 0;
  let submissions = 0;
  const left = (): number => budgetMs - spent;
  const goal = readPolyGoal(options.goal.statement);
  if (typeof goal === "string") {
    for (const method of options.settings.methods) notes.push({ method, note: `outside the fragment: ${goal}` });
    return { tries, cpuMs: 0, notes, submissions };
  }
  for (const method of options.settings.methods) {
    if (options.signal?.aborted) break;
    if (left() < 1000) {
      notes.push({ method, note: "not tried: the battery's budget is spent" });
      continue;
    }
    const timeoutSec = Math.max(1, Math.min(COMPUTE_CALL_SEC, Math.floor(left() / 1000)));
    const started = Date.now();
    let generated: Generated;
    try {
      const call = { timeoutSec, ...(options.signal !== undefined ? { signal: options.signal } : {}) };
      generated =
        method === "modular" ? modularCandidates(goal, options.settings)
          : method === "polyrith" ? await polyrithCandidates(goal, options.compute, call)
            : method === "sos" ? await sosCandidates(goal, options.compute, call)
              : bernsteinCandidates(goal, options.settings);
    } catch (error) {
      if (options.signal?.aborted) break;
      generated = { candidates: [], note: `the compute tool failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 200)}` };
    }
    spent += Date.now() - started;
    if (generated.candidates.length === 0) {
      notes.push({ method, note: generated.note ?? "no candidate" });
      continue;
    }
    let accepted = false;
    for (const candidate of generated.candidates) {
      if (options.signal?.aborted || left() < 1000 || submissions >= options.maxSubmissions) break;
      const screened = leanTextProblems(candidate.script);
      if (screened.length > 0) {
        notes.push({ method, note: `a candidate failed the screen: ${screened[0]}` });
        continue;
      }
      const limit = Math.max(1, Math.min(CERTIFICATE_TRY_SEC, Math.floor(left() / 1000)));
      const t0 = Date.now();
      let record: TryRecord;
      try {
        const [result] = await options.checker.check([{ id: `m10:${certificateTactic(method)}`, code: snippetFor(options.goal, candidate.script) }], { timeoutSec: limit, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
        const used = Math.max(result?.timeMs ?? 0, 0);
        const outcome: TryRecord["outcome"] =
          result === undefined || (options.signal?.aborted === true && !succeeded(result)) ? "aborted"
            : succeeded(result) ? "success"
              : result.status === "timeout" ? "timeout"
                : result.status === "server_error" || result.status === "repl_error" ? "error"
                  : "failed";
        record = { tactic: certificateTactic(method), domain: options.domain, outcome, timeMs: used > 0 ? used : Date.now() - t0 };
      } catch (error) {
        if (!options.signal?.aborted) throw error;
        record = { tactic: certificateTactic(method), domain: options.domain, outcome: "aborted", timeMs: Date.now() - t0 };
      }
      tries.push(record);
      spent += record.timeMs;
      if (record.outcome !== "success") continue;
      submissions++;
      if (await options.submit(candidate.script, method)) {
        accepted = true;
        return { tries, winner: { tactic: certificateTactic(method), proof: candidate.script }, cpuMs: spent, notes, submissions };
      }
      notes.push({ method, note: `Lean accepted the certificate (${candidate.detail}) but validate refused it` });
    }
    if (!accepted && !notes.some((n) => n.method === method)) {
      const mine = tries.filter((t) => t.tactic === certificateTactic(method));
      const count = (o: TryRecord["outcome"]): number => mine.filter((t) => t.outcome === o).length;
      notes.push({ method, note: `Lean accepted none of ${generated.candidates.length} candidate(s) (${generated.candidates[0]?.detail}): ${count("failed")} failed, ${count("timeout")} timed out, ${count("error")} without an answer from Lean, ${generated.candidates.length - mine.length} not checked` });
    }
  }
  return { tries, cpuMs: spent, notes, submissions };
}

/** Whether a method name is one of the stage's. */
export const isCertificateMethod = (name: string): name is CertificateMethod => (CERTIFICATE_METHODS as readonly string[]).includes(name);

/** Whether a try of the battery is one of the certificate stage's. */
export const isCertificateTry = (tactic: string): boolean => tactic.startsWith("cert.");
