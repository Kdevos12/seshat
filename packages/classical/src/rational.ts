/**
 * Exact rationals on `bigint`, one implementation for every package that must not round: the certificate stage of the
 * battery (`polynomial.ts`, `certificates.ts`, plan change CX4) and the guessing of recurrences in `@seshat/induction`
 * (its `rational.ts` re-exports these under its own names).
 */

/** A rational `n / d` in lowest terms, `d > 0`. */
export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

const babs = (a: bigint): bigint => (a < 0n ? -a : a);

/** The greatest common divisor of `|a|` and `|b|` (0 for two zeros). */
export function gcd(a: bigint, b: bigint): bigint {
  a = babs(a);
  b = babs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** `n / d` in lowest terms; a denominator of 0 throws. */
export function rat(n: bigint | number, d: bigint | number = 1n): Rat {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new RangeError("a rational with denominator 0");
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return g > 1n ? { n: nn / g, d: dd / g } : { n: nn, d: dd };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

export const radd = (a: Rat, b: Rat): Rat => (a.d === b.d ? rat(a.n + b.n, a.d) : rat(a.n * b.d + b.n * a.d, a.d * b.d));
export const rneg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
export const rsub = (a: Rat, b: Rat): Rat => radd(a, rneg(b));
export const rmul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
export function rdiv(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new RangeError("division by zero");
  return rat(a.n * b.d, a.d * b.n);
}
export const rsign = (a: Rat): -1 | 0 | 1 => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
export const rcmp = (a: Rat, b: Rat): -1 | 0 | 1 => rsign(rsub(a, b));
export const req = (a: Rat, b: Rat): boolean => a.n === b.n && a.d === b.d;
export const isZero = (a: Rat): boolean => a.n === 0n;
export const isInteger = (a: Rat): boolean => a.d === 1n;
export const rtoNumber = (a: Rat): number => Number(a.n) / Number(a.d);
export const rshow = (a: Rat): string => (a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`);

/** A decimal numeral (`3`, `0.25`) as a rational. */
export function ratOfNumeral(text: string): Rat | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (m === null) return undefined;
  const frac = m[2] ?? "";
  return rat(BigInt(`${m[1]}${frac}`), 10n ** BigInt(frac.length));
}

/** The rational nearest `x` with denominator `den`, or undefined when `x` is not finite or too large to be a coefficient. */
export function roundTo(x: number, den: bigint): Rat | undefined {
  if (!Number.isFinite(x) || Math.abs(x) > 1e12) return undefined;
  const scaled = x * Number(den);
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) return undefined;
  return rat(BigInt(Math.round(scaled)), den);
}
