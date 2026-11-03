import { bitsForDigits, constant, floorDiv, fromDecimal, sqrtFixed } from "./fixed.ts";

/**
 * PSLQ (Ferguson and Bailey): an integer relation `a_1 x_1 + ... + a_n x_n = 0` among real numbers known to
 * many digits, in fixed-point arithmetic on `bigint`. The numbers are decimal texts, or the names of constants
 * (`pi`, `ln(2)`, ...). A relation is a numerical coincidence until it is proved: it says how many digits agree
 * and how many digits the relation itself takes to write, and whether the first is enough beyond the second
 * to look like more than chance. It never settles a claim.
 */
export interface IntegerRelation {
  /** The integer coefficients, one for each input number. */
  relation: bigint[];
  /** The number of PSLQ iterations. */
  steps: number;
  /** Decimal digits at which `sum a_i x_i` vanishes (Infinity for an exact zero). */
  agreementDigits: number;
  /** Decimal digits it takes to write the coefficients: the sum of log10(1 + |a_i|). */
  relationDigits: number;
  /** Whether the agreement exceeds the relation's own size by at least `margin` digits (default 10). */
  significant: boolean;
}

export interface PslqOptions {
  /** Digits of every input number that are right. Default: the fewest digits any decimal input is written with, at most 200. */
  digits?: number;
  /** A relation with a coefficient at least this large is not reported. Default 1000. */
  maxCoefficient?: number;
  maxSteps?: number;
  /** Digits by which the agreement must exceed the relation's size to be `significant`. Default 10. */
  margin?: number;
}

const log10Of = (value: bigint): number => {
  const abs = value < 0n ? -value : value;
  if (abs === 0n) return -Infinity;
  const text = abs.toString();
  return text.length - 1 + Math.log10(Number(`0.${text.slice(0, 15)}`) * 10);
};

/** The PSLQ iteration on fixed-point numbers at `bits` bits. Returns the relation and the iterations, or undefined. */
export function pslqFixed(values: readonly bigint[], bits: number, tolBits: number, maxCoefficient: number, maxSteps: number): { relation: bigint[]; steps: number } | undefined {
  const n = values.length;
  if (n < 2) throw new RangeError("PSLQ needs at least two numbers");
  const prec = BigInt(bits);
  const one = 1n << prec;
  const tol = 1n << BigInt(Math.max(0, bits - tolBits));
  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  const roundFixed = (v: bigint): bigint => ((v + (one >> 1n)) >> prec) << prec;
  const x: bigint[] = [0n, ...values];
  if (values.some((v) => v === 0n)) return undefined;
  const g = sqrtFixed((4n << prec) / 3n, bits);
  const grid = (rows: number, columns: number): bigint[][] => Array.from({ length: rows + 1 }, () => Array.from({ length: columns + 1 }, () => 0n));
  const A = grid(n, n);
  const B = grid(n, n);
  const H = grid(n, n);
  for (let i = 1; i <= n; i++) {
    (A[i] as bigint[])[i] = one;
    (B[i] as bigint[])[i] = one;
  }
  const s: bigint[] = Array.from({ length: n + 1 }, () => 0n);
  for (let k = 1; k <= n; k++) {
    let t = 0n;
    for (let j = k; j <= n; j++) t += ((x[j] as bigint) * (x[j] as bigint)) >> prec;
    s[k] = sqrtFixed(t, bits);
  }
  const t0 = s[1] as bigint;
  if (t0 === 0n) return undefined;
  const y: bigint[] = [...x];
  for (let k = 1; k <= n; k++) {
    y[k] = floorDiv((x[k] as bigint) << prec, t0);
    s[k] = floorDiv((s[k] as bigint) << prec, t0);
  }
  for (let i = 1; i <= n; i++) {
    const Hi = H[i] as bigint[];
    if (i <= n - 1) Hi[i] = (s[i] as bigint) !== 0n ? floorDiv((s[i + 1] as bigint) << prec, s[i] as bigint) : 0n;
    for (let j = 1; j < i; j++) {
      const sjj1 = (s[j] as bigint) * (s[j + 1] as bigint);
      Hi[j] = sjj1 !== 0n ? floorDiv((-(y[i] as bigint) * (y[j] as bigint)) << prec, sjj1) : 0n;
    }
  }
  const reduce = (i: number, from: number, onZero: "continue" | "break"): void => {
    for (let j = from; j >= 1; j--) {
      const Hj = H[j] as bigint[];
      const Hi = H[i] as bigint[];
      const hjj = Hj[j] as bigint;
      if (hjj === 0n) {
        // The precision is probably exhausted; the first reduction goes on to the next j, the later ones stop.
        if (onZero === "continue") continue;
        break;
      }
      const t = roundFixed(floorDiv((Hi[j] as bigint) << prec, hjj));
      y[j] = (y[j] as bigint) + ((t * (y[i] as bigint)) >> prec);
      for (let k = 1; k <= j; k++) Hi[k] = (Hi[k] as bigint) - ((t * (Hj[k] as bigint)) >> prec);
      for (let k = 1; k <= n; k++) {
        (A[i] as bigint[])[k] = ((A[i] as bigint[])[k] as bigint) - ((t * ((A[j] as bigint[])[k] as bigint)) >> prec);
        (B[k] as bigint[])[j] = ((B[k] as bigint[])[j] as bigint) + ((t * ((B[k] as bigint[])[i] as bigint)) >> prec);
      }
    }
  };
  for (let i = 2; i <= n; i++) reduce(i, i - 1, "continue");

  for (let step = 1; step <= maxSteps; step++) {
    let m = -1;
    let szmax = -1n;
    for (let i = 1; i < n; i++) {
      const h = (H[i] as bigint[])[i] as bigint;
      const sz = (g ** BigInt(i) * abs(h)) >> (prec * BigInt(i - 1));
      if (sz > szmax) {
        m = i;
        szmax = sz;
      }
    }
    if (m < 0) return undefined;
    [y[m], y[m + 1]] = [y[m + 1] as bigint, y[m] as bigint];
    [H[m], H[m + 1]] = [H[m + 1] as bigint[], H[m] as bigint[]];
    [A[m], A[m + 1]] = [A[m + 1] as bigint[], A[m] as bigint[]];
    for (let i = 1; i <= n; i++) {
      const row = B[i] as bigint[];
      [row[m], row[m + 1]] = [row[m + 1] as bigint, row[m] as bigint];
    }
    if (m <= n - 2) {
      const hmm = (H[m] as bigint[])[m] as bigint;
      const hm1 = (H[m] as bigint[])[m + 1] as bigint;
      const t0 = sqrtFixed((hmm * hmm + hm1 * hm1) >> prec, bits);
      if (t0 === 0n) break;
      const t1 = floorDiv(hmm << prec, t0);
      const t2 = floorDiv(hm1 << prec, t0);
      for (let i = m; i <= n; i++) {
        const Hi = H[i] as bigint[];
        const t3 = Hi[m] as bigint;
        const t4 = Hi[m + 1] as bigint;
        Hi[m] = (t1 * t3 + t2 * t4) >> prec;
        Hi[m + 1] = (-t2 * t3 + t1 * t4) >> prec;
      }
    }
    for (let i = m + 1; i <= n; i++) reduce(i, Math.min(i - 1, m + 1), "break");
    for (let i = 1; i <= n; i++) {
      if (abs(y[i] as bigint) < tol) {
        const vector = Array.from({ length: n }, (_, j) => roundFixed((B[j + 1] as bigint[])[i] as bigint) >> prec);
        if (vector.every((v) => abs(v) < BigInt(maxCoefficient)) && vector.some((v) => v !== 0n)) return { relation: vector, steps: step };
      }
    }
    // A lower bound for the norm of any relation: when it passes the coefficient limit there is none to find.
    let recnorm = 0n;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) recnorm = abs((H[i] as bigint[])[j] as bigint) > recnorm ? abs((H[i] as bigint[])[j] as bigint) : recnorm;
    if (recnorm !== 0n) {
      const norm = ((1n << (2n * prec)) / recnorm >> prec) / 100n;
      if (norm >= BigInt(maxCoefficient)) break;
    }
  }
  return undefined;
}

const isDecimal = (text: string): boolean => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text);

/** The digits a decimal text is written with (after the leading zeros). */
function digitsOf(text: string): number {
  const mantissa = text.replace(/[eE].*$/, "").replace(/^[\s+-]+/, "");
  const [whole = "", frac = ""] = mantissa.split(".");
  return `${whole}${frac}`.replace(/^0+/, "").length || 1;
}

/**
 * An integer relation among numbers, each a decimal text (known to its written digits) or a constant's name
 * (`pi`, `e`, `phi`, `sqrt(m)`, `ln(m)`, `atan(1/k)`, `1`). Returns the relation, or undefined when none with
 * coefficients below `maxCoefficient` is found at the precision the digits allow.
 */
export function findIntegerRelation(inputs: readonly string[], options: PslqOptions = {}): IntegerRelation | undefined {
  const written = inputs.filter(isDecimal).map(digitsOf);
  const digits = options.digits ?? Math.min(200, written.length > 0 ? Math.min(...written) : 100);
  const bits = bitsForDigits(digits) + 24;
  const values = inputs.map((text) => (isDecimal(text) ? fromDecimal(text, bits) : constant(text, bits)));
  const maxCoefficient = options.maxCoefficient ?? 1000;
  // mpmath's default: a tolerance of eps^0.75 where eps is what the digits give.
  const tolBits = Math.floor(0.75 * bitsForDigits(digits));
  const found = pslqFixed(values, bits, tolBits, maxCoefficient, options.maxSteps ?? 100 * inputs.length * inputs.length);
  if (found === undefined) return undefined;
  let total = 0n;
  found.relation.forEach((a, i) => {
    total += a * (values[i] as bigint);
  });
  const residual = log10Of(total < 0n ? -total : total) - bits * Math.log10(2);
  const agreementDigits = total === 0n ? Infinity : Math.min(-residual, bits * Math.log10(2));
  const relationDigits = found.relation.reduce((sum, a) => sum + Math.log10(1 + Number(a < 0n ? -a : a)), 0);
  return { relation: found.relation, steps: found.steps, agreementDigits, relationDigits, significant: agreementDigits - relationDigits >= (options.margin ?? 10) };
}

/** A relation as an equation in words, `1*pi + -16*atan(1/5) + 4*atan(1/239) = 0`, with the zero coefficients left out. */
export function describeRelation(relation: readonly bigint[], names: readonly string[]): string {
  const parts = relation.flatMap((a, i) => (a === 0n ? [] : [`${a} * ${names[i] ?? `x${i + 1}`}`]));
  return `${parts.join(" + ")} = 0`;
}
