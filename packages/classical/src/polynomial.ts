import type { Term } from "./parse.ts";
import { type Rat, ZERO, ONE, radd, rneg, rsub, rmul, rdiv, rsign, isZero, isInteger, ratOfNumeral } from "./rational.ts";

/**
 * Polynomials over the exact rationals of `rational.ts`, for the certificate stage of the battery (plan change CX4,
 * `certificates.ts`): the goal's polynomials are read into this form, a tool's floating answer is rounded
 * into it, and every identity a certificate rests on is checked here, exactly, before any Lean text is
 * written. Nothing here is trusted by Lean: it only decides which candidates are worth a Lean check.
 */

// --- Polynomials --------------------------------------------------------------------------------

/** An exponent vector, one entry per variable. */
export type Monomial = readonly number[];

const keyOf = (m: Monomial): string => m.join(",");
const monoOf = (key: string): number[] => (key === "" ? [] : key.split(",").map(Number));

/** A polynomial in `nvars` variables with rational coefficients; zero coefficients are never stored. */
export class Poly {
  readonly nvars: number;
  readonly #terms: Map<string, Rat>;

  constructor(nvars: number, terms: Iterable<[Monomial, Rat]> = []) {
    this.nvars = nvars;
    this.#terms = new Map();
    for (const [m, c] of terms) {
      if (m.length !== nvars) throw new RangeError(`a monomial of ${m.length} exponents in a polynomial of ${nvars} variables`);
      this.#add(keyOf(m), c);
    }
  }

  #add(key: string, c: Rat): void {
    if (isZero(c)) return;
    const sum = radd(this.#terms.get(key) ?? ZERO, c);
    if (isZero(sum)) this.#terms.delete(key);
    else this.#terms.set(key, sum);
  }

  static constant(nvars: number, c: Rat): Poly {
    return new Poly(nvars, [[new Array<number>(nvars).fill(0), c]]);
  }

  static variable(nvars: number, i: number): Poly {
    const m = new Array<number>(nvars).fill(0);
    m[i] = 1;
    return new Poly(nvars, [[m, ONE]]);
  }

  /** The terms, in a fixed order: by total degree descending, then by exponents descending. */
  terms(): Array<[number[], Rat]> {
    const out = [...this.#terms].map(([k, c]) => [monoOf(k), c] as [number[], Rat]);
    const deg = (m: readonly number[]): number => m.reduce((a, b) => a + b, 0);
    out.sort(([a], [b]) => deg(b) - deg(a) || compareDesc(a, b));
    return out;
  }

  coefficient(m: Monomial): Rat {
    return this.#terms.get(keyOf(m)) ?? ZERO;
  }

  get size(): number {
    return this.#terms.size;
  }

  isZero(): boolean {
    return this.#terms.size === 0;
  }

  /** The constant, when the polynomial is one. */
  constantValue(): Rat | undefined {
    if (this.#terms.size === 0) return ZERO;
    if (this.#terms.size > 1) return undefined;
    const [[k, c]] = [...this.#terms] as [[string, Rat]];
    return monoOf(k).every((e) => e === 0) ? c : undefined;
  }

  degree(): number {
    let d = 0;
    for (const k of this.#terms.keys()) d = Math.max(d, monoOf(k).reduce((a, b) => a + b, 0));
    return d;
  }

  /** The degree in variable `i`. */
  degreeIn(i: number): number {
    let d = 0;
    for (const k of this.#terms.keys()) d = Math.max(d, monoOf(k)[i] ?? 0);
    return d;
  }

  /** The variables that occur. */
  variables(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.nvars; i++) if (this.degreeIn(i) > 0) out.push(i);
    return out;
  }

  add(other: Poly): Poly {
    const out = new Poly(this.nvars, this.terms());
    for (const [m, c] of other.terms()) out.#add(keyOf(m), c);
    return out;
  }

  scale(c: Rat): Poly {
    return isZero(c) ? new Poly(this.nvars) : new Poly(this.nvars, this.terms().map(([m, k]) => [m, rmul(k, c)]));
  }

  neg(): Poly {
    return this.scale(rneg(ONE));
  }

  sub(other: Poly): Poly {
    return this.add(other.neg());
  }

  mul(other: Poly): Poly {
    const out = new Poly(this.nvars);
    for (const [a, c] of this.terms()) for (const [b, k] of other.terms()) out.#add(keyOf(a.map((e, i) => e + (b[i] as number))), rmul(c, k));
    return out;
  }

  pow(n: number): Poly {
    let out = Poly.constant(this.nvars, ONE);
    for (let i = 0; i < n; i++) out = out.mul(this);
    return out;
  }

  equals(other: Poly): boolean {
    return this.sub(other).isZero();
  }

  /** Every coefficient is an integer. */
  integral(): boolean {
    return [...this.#terms.values()].every(isInteger);
  }

  /** The value at integer residues modulo `m` of a polynomial with integer coefficients. */
  evalMod(values: readonly number[], m: number): number {
    let total = 0;
    for (const [k, c] of this.#terms) {
      let term = Number(((c.n % BigInt(m)) + BigInt(m)) % BigInt(m));
      const mono = monoOf(k);
      for (let i = 0; i < mono.length && term !== 0; i++) for (let e = 0; e < (mono[i] as number); e++) term = (term * (values[i] as number)) % m;
      total = (total + term) % m;
    }
    return total;
  }

  /** Substitutes `subs[i]` for variable `i`; the result lives in `subs[0].nvars` variables. */
  compose(subs: readonly Poly[], nvars: number): Poly {
    let out = new Poly(nvars);
    for (const [m, c] of this.terms()) {
      let term = Poly.constant(nvars, c);
      m.forEach((e, i) => {
        if (e > 0) term = term.mul((subs[i] as Poly).pow(e));
      });
      out = out.add(term);
    }
    return out;
  }
}

function compareDesc(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (b[i] as number) - (a[i] as number);
  return 0;
}

/** The highest exponent `toPoly` reads, and the most terms a read polynomial may have. */
export const MAX_EXPONENT = 12;
export const MAX_TERMS = 400;

/**
 * Reads a term of the goal as a polynomial in `vars`: numerals, the variables, `+`, `-`, `*`, unary minus,
 * `^` by a numeral, and (when `divide`) `/` by a nonzero constant. Anything else, or a polynomial too large
 * to be worth a certificate, gives undefined: the goal is outside the stage's fragment.
 */
export function toPoly(term: Term, vars: readonly string[], options: { divide: boolean; subtract: boolean }): Poly | undefined {
  const n = vars.length;
  const go = (t: Term): Poly | undefined => {
    switch (t.k) {
      case "num": {
        const r = ratOfNumeral(t.text);
        if (r === undefined || (!options.divide && !isInteger(r))) return undefined;
        return Poly.constant(n, r);
      }
      case "var": {
        const i = vars.indexOf(t.name);
        return i < 0 ? undefined : Poly.variable(n, i);
      }
      case "app": {
        if (!t.op) return undefined;
        const [a, b] = t.args;
        if (t.fn === "neg" && t.args.length === 1 && a !== undefined) {
          if (!options.subtract) return undefined;
          return go(a)?.neg();
        }
        if (t.args.length !== 2 || a === undefined || b === undefined) return undefined;
        if (t.fn === "^") {
          if (b.k !== "num" || !/^\d+$/u.test(b.text) || Number(b.text) > MAX_EXPONENT) return undefined;
          const base = go(a);
          return base === undefined ? undefined : small(base.pow(Number(b.text)));
        }
        const left = go(a);
        const right = go(b);
        if (left === undefined || right === undefined) return undefined;
        switch (t.fn) {
          case "+":
            return small(left.add(right));
          case "-":
            return options.subtract ? small(left.sub(right)) : undefined;
          case "*":
            return small(left.mul(right));
          case "/": {
            const c = right.constantValue();
            if (!options.divide || c === undefined || isZero(c)) return undefined;
            return left.scale(rdiv(ONE, c));
          }
          default:
            return undefined;
        }
      }
      default:
        return undefined;
    }
  };
  const small = (p: Poly): Poly | undefined => (p.size > MAX_TERMS ? undefined : p);
  return go(term);
}

// --- Exact linear algebra -----------------------------------------------------------------------

/**
 * One solution of `A x = b` over the rationals by Gauss-Jordan elimination (free unknowns set to 0), or
 * undefined when the system has none. `A` is given by rows of `[column, value]`.
 */
export function solveLinear(rows: ReadonlyArray<ReadonlyArray<readonly [number, Rat]>>, b: readonly Rat[], ncols: number): Rat[] | undefined {
  const m: Array<Map<number, Rat>> = rows.map((r) => {
    const row = new Map<number, Rat>();
    for (const [j, v] of r) if (!isZero(v)) row.set(j, radd(row.get(j) ?? ZERO, v));
    return row;
  });
  const rhs = [...b];
  const pivots: Array<[number, number]> = [];
  let r = 0;
  for (let col = 0; col < ncols && r < m.length; col++) {
    let p = -1;
    for (let i = r; i < m.length; i++) if (!isZero(m[i]?.get(col) ?? ZERO)) {
      p = i;
      break;
    }
    if (p < 0) continue;
    [m[r], m[p]] = [m[p] as Map<number, Rat>, m[r] as Map<number, Rat>];
    [rhs[r], rhs[p]] = [rhs[p] as Rat, rhs[r] as Rat];
    const pivotRow = m[r] as Map<number, Rat>;
    const inv = rdiv(ONE, pivotRow.get(col) as Rat);
    for (const [j, v] of pivotRow) pivotRow.set(j, rmul(v, inv));
    rhs[r] = rmul(rhs[r] as Rat, inv);
    for (let i = 0; i < m.length; i++) {
      if (i === r) continue;
      const row = m[i] as Map<number, Rat>;
      const f = row.get(col);
      if (f === undefined) continue;
      for (const [j, v] of pivotRow) {
        const next = rsub(row.get(j) ?? ZERO, rmul(f, v));
        if (isZero(next)) row.delete(j);
        else row.set(j, next);
      }
      rhs[i] = rsub(rhs[i] as Rat, rmul(f, rhs[r] as Rat));
    }
    pivots.push([r, col]);
    r++;
  }
  for (let i = r; i < m.length; i++) if (!isZero(rhs[i] as Rat)) return undefined;
  const x = new Array<Rat>(ncols).fill(ZERO);
  for (const [row, col] of pivots) x[col] = rhs[row] as Rat;
  return x;
}

/**
 * The exact LDLᵀ factorization of a symmetric rational matrix, when it is positive semidefinite: `L` unit
 * lower triangular, `D` nonnegative. Undefined when a pivot is negative, or zero with a nonzero column below
 * it (the matrix is then not PSD).
 */
export function ldlt(q: readonly (readonly Rat[])[]): { L: Rat[][]; D: Rat[] } | undefined {
  const n = q.length;
  const L: Rat[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? ONE : ZERO)));
  const D: Rat[] = new Array<Rat>(n).fill(ZERO);
  for (let k = 0; k < n; k++) {
    let d = q[k]?.[k] as Rat;
    for (let j = 0; j < k; j++) d = rsub(d, rmul(rmul(L[k]?.[j] as Rat, L[k]?.[j] as Rat), D[j] as Rat));
    if (rsign(d) < 0) return undefined;
    D[k] = d;
    for (let i = k + 1; i < n; i++) {
      let v = q[i]?.[k] as Rat;
      for (let j = 0; j < k; j++) v = rsub(v, rmul(rmul(L[i]?.[j] as Rat, L[k]?.[j] as Rat), D[j] as Rat));
      if (isZero(d)) {
        if (!isZero(v)) return undefined;
        continue;
      }
      (L[i] as Rat[])[k] = rdiv(v, d);
    }
  }
  return { L, D };
}
