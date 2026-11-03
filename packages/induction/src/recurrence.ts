import { add, div, isZero, mul, neg, nullspace, type Rat, rat, sub, toIntegers, ZERO } from "./rational.ts";

/**
 * Guessing recurrences from the first terms of a sequence (gfun's guess-then-prove, documentation/induction.md).
 * Guessing is a conjecture machine: a recurrence found from N terms is a claim about all of them, and only
 * Lean proves it. The two guessers demand an overdetermined system, since a solution of a system with as
 * many unknowns as equations proves nothing: `surplus` is the number of equations beyond the unknowns.
 */

/**
 * A recurrence `P_0(n) f(n) + P_1(n) f(n+1) + ... + P_r(n) f(n+r) = 0` for every n from 0, with integer
 * polynomials. `coefficients[i]` is the polynomial `P_i`, lowest degree first. A recurrence with constant
 * coefficients has polynomials of degree 0.
 */
export interface Recurrence {
  kind: "linear" | "holonomic";
  /** r: the span of the indexes. */
  order: number;
  /** The largest degree of a coefficient polynomial. */
  degree: number;
  coefficients: bigint[][];
  /** The terms it was read from. */
  terms: number;
  /** Equations beyond unknowns (Berlekamp-Massey: terms beyond twice the order): how overdetermined the guess is. */
  surplus: number;
  /** Values of n in range at which the leading polynomial vanishes: there the recurrence does not determine the next term. */
  singular: number[];
}

/** Evaluates the polynomial (lowest degree first) at an integer. */
export function evalPolynomial(poly: readonly bigint[], at: bigint): bigint {
  let value = 0n;
  for (let i = poly.length - 1; i >= 0; i--) value = value * at + (poly[i] as bigint);
  return value;
}

const asRat = (terms: readonly (bigint | number)[]): Rat[] => terms.map((t) => rat(t));

/**
 * The shortest linear recurrence with constant coefficients that generates the terms, over the rationals
 * (Berlekamp-Massey): `s_n = c_1 s_{n-1} + ... + c_L s_{n-L}` for every n from L. Returns the coefficients
 * `c_1..c_L`; an empty list for a sequence of zeros. The recurrence is unique when 2L is at most the number of
 * terms, and the caller decides how much more than that it asks for.
 */
export function berlekampMassey(terms: readonly (bigint | number)[]): Rat[] {
  const s = asRat(terms);
  let c: Rat[] = [rat(1)];
  let b: Rat[] = [rat(1)];
  let l = 0;
  let m = 1;
  let bd: Rat = rat(1);
  for (let n = 0; n < s.length; n++) {
    let d = s[n] as Rat;
    for (let i = 1; i <= l; i++) d = add(d, mul(c[i] ?? ZERO, s[n - i] as Rat));
    if (isZero(d)) {
      m++;
      continue;
    }
    const factor = div(d, bd);
    const next = [...c];
    while (next.length < b.length + m) next.push(ZERO);
    for (let i = 0; i < b.length; i++) next[i + m] = sub(next[i + m] as Rat, mul(factor, b[i] as Rat));
    if (2 * l <= n) {
      b = c;
      bd = d;
      l = n + 1 - l;
      m = 1;
    } else {
      m++;
    }
    c = next;
  }
  const out: Rat[] = [];
  for (let i = 1; i <= l; i++) out.push(neg(c[i] ?? ZERO));
  return out;
}

export interface GuessOptions {
  /** The most equations beyond the unknowns that must remain; a guess with fewer is not made. Default 2. */
  minSurplus?: number;
  /** The largest order tried. Default 6. */
  maxOrder?: number;
  /** The largest degree of a coefficient polynomial (holonomic guess only). Default 3. */
  maxDegree?: number;
}

/** The recurrence with constant coefficients that generates the terms, as a `Recurrence`, or undefined when the terms leave too little surplus. */
export function guessLinearRecurrence(terms: readonly (bigint | number)[], options: GuessOptions = {}): Recurrence | undefined {
  const minSurplus = options.minSurplus ?? 2;
  const maxOrder = options.maxOrder ?? 6;
  const c = berlekampMassey(terms);
  const l = c.length;
  if (l === 0 || l > maxOrder) return undefined;
  const surplus = terms.length - 2 * l;
  if (surplus < minSurplus) return undefined;
  // f(n+l) - c_1 f(n+l-1) - ... - c_l f(n) = 0 with the denominators cleared.
  const vector = Array.from({ length: l + 1 }, () => ZERO);
  vector[l] = rat(1);
  for (let i = 1; i <= l; i++) vector[l - i] = neg(c[i - 1] as Rat);
  const ints = toIntegers(vector);
  return { kind: "linear", order: l, degree: 0, coefficients: ints.map((v) => [v]), terms: terms.length, surplus, singular: singularPoints(ints.map((v) => [v]), terms.length) };
}

/**
 * A recurrence with polynomial coefficients (a P-recursive, or holonomic, sequence), by linear algebra over the
 * rationals: for the orders and degrees in turn, from the fewest unknowns, the integer vectors `P_i(n)` with
 * `sum P_i(n) f(n+i) = 0` for every n the terms cover. The first (order, degree) whose system has a solution
 * and still has `minSurplus` equations beyond its unknowns is taken, and its first basis vector. This is
 * gfun's `guess`: Catalan numbers come out of `(n + 2) f(n+1) = (4 n + 2) f(n)`.
 */
export function guessHolonomic(terms: readonly (bigint | number)[], options: GuessOptions = {}): Recurrence | undefined {
  const minSurplus = options.minSurplus ?? 2;
  const maxOrder = options.maxOrder ?? 6;
  const maxDegree = options.maxDegree ?? 3;
  const s = terms.map((t) => BigInt(t));
  const shapes: Array<{ r: number; d: number; unknowns: number }> = [];
  for (let r = 1; r <= maxOrder; r++) for (let d = 0; d <= maxDegree; d++) shapes.push({ r, d, unknowns: (r + 1) * (d + 1) });
  shapes.sort((x, y) => x.unknowns - y.unknowns || x.r - y.r);
  for (const { r, d, unknowns } of shapes) {
    const equations = s.length - r;
    if (equations - unknowns < minSurplus) continue;
    const matrix: Rat[][] = [];
    for (let n = 0; n < equations; n++) {
      const row: Rat[] = [];
      for (let i = 0; i <= r; i++) {
        const value = s[n + i] as bigint;
        let power = 1n;
        for (let j = 0; j <= d; j++) {
          row.push(rat(power * value));
          power *= BigInt(n);
        }
      }
      matrix.push(row);
    }
    const basis = nullspace(matrix, unknowns);
    const first = basis[0];
    if (first === undefined) continue;
    const ints = toIntegers(first);
    const coefficients: bigint[][] = [];
    for (let i = 0; i <= r; i++) coefficients.push(ints.slice(i * (d + 1), (i + 1) * (d + 1)));
    // The solution must really use the top term, or it is a recurrence of lower order that a lower shape would have found.
    const top = coefficients[r] as bigint[];
    if (top.every((v) => v === 0n)) continue;
    const degree = Math.max(...coefficients.map((p) => polyDegree(p)));
    return { kind: "holonomic", order: r, degree, coefficients: trimmed(coefficients), terms: s.length, surplus: equations - unknowns, singular: singularPoints(coefficients, s.length) };
  }
  return undefined;
}

function polyDegree(poly: readonly bigint[]): number {
  for (let j = poly.length - 1; j >= 0; j--) if (poly[j] !== 0n) return j;
  return 0;
}

function trimmed(coefficients: bigint[][]): bigint[][] {
  const width = Math.max(...coefficients.map((p) => polyDegree(p))) + 1;
  return coefficients.map((p) => p.slice(0, width).concat(Array.from({ length: Math.max(0, width - p.length) }, () => 0n)));
}

function singularPoints(coefficients: readonly (readonly bigint[])[], terms: number): number[] {
  const top = coefficients[coefficients.length - 1] ?? [];
  const out: number[] = [];
  for (let n = 0; n < terms; n++) if (evalPolynomial(top, BigInt(n)) === 0n) out.push(n);
  return out;
}

/** Whether the recurrence holds on the terms, every equation it covers. */
export function recurrenceHolds(rec: Recurrence, terms: readonly (bigint | number)[]): boolean {
  const s = terms.map((t) => BigInt(t));
  for (let n = 0; n + rec.order < s.length; n++) {
    let total = 0n;
    for (let i = 0; i <= rec.order; i++) total += evalPolynomial(rec.coefficients[i] as bigint[], BigInt(n)) * (s[n + i] as bigint);
    if (total !== 0n) return false;
  }
  return true;
}

/**
 * The next terms the recurrence predicts after the given ones, or fewer when it cannot say (the leading
 * polynomial vanishes there, or the quotient is not an integer: the sequence is then not integral, which
 * the guesser's caller should read as a sign that the guess is wrong).
 */
export function predictTerms(rec: Recurrence, terms: readonly (bigint | number)[], count: number): bigint[] {
  const s = terms.map((t) => BigInt(t));
  const out: bigint[] = [];
  for (let k = 0; k < count; k++) {
    const n = s.length - rec.order;
    if (n < 0) break;
    const lead = evalPolynomial(rec.coefficients[rec.order] as bigint[], BigInt(n));
    if (lead === 0n) break;
    let rest = 0n;
    for (let i = 0; i < rec.order; i++) rest += evalPolynomial(rec.coefficients[i] as bigint[], BigInt(n)) * (s[n + i] as bigint);
    if (rest % lead !== 0n) break;
    const next = -rest / lead;
    s.push(next);
    out.push(next);
  }
  return out;
}

/** A polynomial as Lean text, parenthesized when it is a sum or a negative number, so that it can be a factor. */
const polyText = (poly: readonly bigint[], variable: string): string => {
  const parts: string[] = [];
  poly.forEach((c, j) => {
    if (c === 0n) return;
    const mono = j === 0 ? "" : j === 1 ? variable : `${variable} ^ ${j}`;
    const coeff = c < 0n ? `(${c})` : `${c}`;
    parts.push(mono === "" ? coeff : c === 1n ? mono : `${coeff} * ${mono}`);
  });
  if (parts.length === 0) return "0";
  const first = parts[0] as string;
  return parts.length === 1 && !first.includes(" ") ? first : `(${parts.join(" + ")})`;
};

/**
 * The recurrence as a conjecture in Lean's signature form, about a function `fn` from ℕ (to `codomain`, ℕ or ℤ),
 * evaluated in ℤ: `(n : ℕ) : (n + 2) * (f (n + 1) : ℤ) = ...`. The statement is a claim to be proved, not a fact.
 */
export function recurrenceStatement(rec: Recurrence, options: { fn: string; variable?: string }): string {
  const v = options.variable ?? "n";
  const cast = `(${v} : ℤ)`;
  const terms: string[] = [];
  for (let i = 0; i <= rec.order; i++) {
    const poly = rec.coefficients[i] as bigint[];
    if (poly.every((c) => c === 0n)) continue;
    const arg = i === 0 ? v : `${v} + ${i}`;
    terms.push(`${polyText(poly, cast)} * (${options.fn} (${arg}) : ℤ)`);
  }
  return `(${v} : ℕ) : ${terms.join(" + ")} = 0`;
}

/** The recurrence in words, for a briefing. */
export function describeRecurrence(rec: Recurrence): string {
  const sums = rec.coefficients.map((p, i) => `${polyText(p, "n")} f(n+${i})`).join(" + ");
  return `${sums} = 0 (${rec.kind}, order ${rec.order}, degree ${rec.degree}, ${rec.terms} terms, ${rec.surplus} equations beyond the unknowns)`;
}
