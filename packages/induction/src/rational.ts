/**
 * Exact rational arithmetic on `bigint`, for the algorithms of this package that must not round: the guessing of
 * recurrences, which solves linear systems over the rationals. The rationals themselves are `@seshat/classical`'s
 * (`rational.ts`), under the short names this package uses; the linear algebra is this package's.
 */
import { isZero, ONE, type Rat, rat, ZERO, gcd, radd, rdiv, req, rmul, rneg, rshow, rsub } from "@seshat/classical";

export { gcd, isZero, ONE, type Rat, rat, ZERO };
export const add = radd;
export const sub = rsub;
export const mul = rmul;
export const neg = rneg;
export const div = rdiv;
export const eq = req;
export const show = rshow;

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
