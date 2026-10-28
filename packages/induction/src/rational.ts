/**
 * Exact rational arithmetic on `bigint`, for the algorithms of this package that must not round:
 * the guessing of recurrences, which solves linear systems over the rationals.
 */
export interface Rat {
  /** The numerator. */
  readonly n: bigint;
  /** The denominator: above 0, and coprime to the numerator. */
  readonly d: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rat(n: bigint | number, d: bigint | number = 1n): Rat {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den === 0n) throw new RangeError("a rational with denominator 0");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return g <= 1n ? { n: num, d: den } : { n: num / g, d: den / g };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

export const add = (a: Rat, b: Rat): Rat => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
export const neg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
export const isZero = (a: Rat): boolean => a.n === 0n;
export const eq = (a: Rat, b: Rat): boolean => a.n === b.n && a.d === b.d;

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new RangeError("division by the rational 0");
  return rat(a.n * b.d, a.d * b.n);
}

export function show(a: Rat): string {
  return a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`;
}

/**
 * The nullspace of a matrix over the rationals, as a basis of vectors `v` with `matrix * v = 0`
 * (Gauss-Jordan elimination). The rows may be fewer than the columns.
 */
export function nullspace(matrix: readonly (readonly Rat[])[], columns: number): Rat[][] {
  const rows = matrix.map((row) => [...row]);
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < columns && r < rows.length; c++) {
    let p = r;
    while (p < rows.length && isZero(rows[p]?.[c] ?? ZERO)) p++;
    if (p === rows.length) continue;
    [rows[r], rows[p]] = [rows[p] as Rat[], rows[r] as Rat[]];
    const pivotRow = rows[r] as Rat[];
    const pivot = pivotRow[c] as Rat;
    for (let k = 0; k < columns; k++) pivotRow[k] = div(pivotRow[k] as Rat, pivot);
    for (let i = 0; i < rows.length; i++) {
      if (i === r) continue;
      const row = rows[i] as Rat[];
      const factor = row[c] as Rat;
      if (isZero(factor)) continue;
      for (let k = 0; k < columns; k++) row[k] = sub(row[k] as Rat, mul(factor, pivotRow[k] as Rat));
    }
    pivots.push(c);
    r++;
  }
  const free = [...Array(columns).keys()].filter((c) => !pivots.includes(c));
  return free.map((f) => {
    const v = Array.from({ length: columns }, () => ZERO);
    v[f] = ONE;
    pivots.forEach((pc, i) => {
      v[pc] = neg((rows[i] as Rat[])[f] as Rat);
    });
    return v;
  });
}

/** A vector of rationals scaled to coprime integers (the first nonzero entry positive). */
export function toIntegers(vector: readonly Rat[]): bigint[] {
  let lcm = 1n;
  for (const x of vector) lcm = (lcm / gcd(lcm, x.d)) * x.d;
  const ints = vector.map((x) => (x.n * lcm) / x.d);
  let g = 0n;
  for (const v of ints) g = gcd(g, v);
  if (g > 1n) for (let i = 0; i < ints.length; i++) ints[i] = (ints[i] as bigint) / g;
  const first = ints.find((v) => v !== 0n);
  return first !== undefined && first < 0n ? ints.map((v) => -v) : ints;
}
