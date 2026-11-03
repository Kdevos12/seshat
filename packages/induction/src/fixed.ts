/**
 * Fixed-point real numbers on `bigint`, for PSLQ and the constants it works on. A real `x` at precision
 * `bits` is the integer `round(x * 2^bits)`. Nothing here is a floating-point number, so the digits are what
 * they are said to be; the series are summed until their terms vanish at the working precision, with 32 guard
 * bits, and the error of a constant is a few units in the last place.
 */

const GUARD = 32;

/** Floor division, as Python's `//`: `bigint` division truncates toward zero. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("the square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** The square root of a fixed-point number. */
export function sqrtFixed(x: bigint, bits: number): bigint {
  return isqrt(x << BigInt(bits));
}

const one = (bits: number): bigint => 1n << BigInt(bits);

/** Parses a decimal such as `-3.14159` to fixed point at `bits` (rounded down). */
export function fromDecimal(text: string, bits: number): bigint {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text);
  if (m === null || ((m[2] ?? "") === "" && (m[3] ?? "") === "")) throw new SyntaxError(`not a decimal number: ${JSON.stringify(text)}`);
  const digits = `${m[2] ?? ""}${m[3] ?? ""}`;
  const exponent = Number(m[4] ?? 0) - (m[3] ?? "").length;
  let numerator = BigInt(digits === "" ? "0" : digits) << BigInt(bits);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  const value = numerator / denominator;
  return m[1] === "-" ? -value : value;
}

/** A fixed-point number as a decimal with `digits` digits after the point (truncated). */
export function toDecimal(x: bigint, bits: number, digits: number): string {
  const negative = x < 0n;
  const abs = negative ? -x : x;
  const scaled = (abs * 10n ** BigInt(digits)) >> BigInt(bits);
  const text = scaled.toString().padStart(digits + 1, "0");
  const head = text.slice(0, text.length - digits);
  const tail = text.slice(text.length - digits);
  return `${negative ? "-" : ""}${head}${digits > 0 ? `.${tail}` : ""}`;
}

/** The number of bits that hold `digits` decimal digits. */
export const bitsForDigits = (digits: number): number => Math.ceil(digits * Math.log2(10));

/** pi by the Gauss-Legendre iteration (the arithmetic-geometric mean), which converges quadratically. */
export function pi(bits: number): bigint {
  const w = bits + GUARD;
  const W = BigInt(w);
  const o = one(w);
  let a = o;
  let b = sqrtFixed(o >> 1n, w);
  let t = o >> 2n;
  let p = 1n;
  for (let i = 0; i < Math.ceil(Math.log2(w)) + 2; i++) {
    const an = (a + b) >> 1n;
    b = sqrtFixed((a * b) >> W, w);
    const d = a - an;
    t -= p * ((d * d) >> W);
    a = an;
    p <<= 1n;
  }
  const s = a + b;
  const s2 = (s * s) >> W;
  return ((s2 << W) / (t << 2n)) >> BigInt(GUARD);
}

/** e, as the sum of 1/k!. */
export function e(bits: number): bigint {
  const w = bits + GUARD;
  let term = one(w);
  let sum = term;
  for (let k = 1; term !== 0n; k++) {
    term /= BigInt(k);
    sum += term;
  }
  return sum >> BigInt(GUARD);
}

/** atan(1/k) for an integer k above 1, by its series. */
export function atanInverse(k: number, bits: number): bigint {
  const w = bits + GUARD;
  const kk = BigInt(k) * BigInt(k);
  let power = one(w) / BigInt(k);
  let sum = power;
  for (let j = 1; power !== 0n; j++) {
    power /= kk;
    const term = power / BigInt(2 * j + 1);
    sum += j % 2 === 1 ? -term : term;
  }
  return sum >> BigInt(GUARD);
}

/** atanh(z) for a fixed-point z with |z| below 1/2, by its series (working precision given). */
function atanh(z: bigint, w: number): bigint {
  const z2 = (z * z) >> BigInt(w);
  let power = z;
  let sum = z;
  for (let j = 1; power !== 0n; j++) {
    power = (power * z2) >> BigInt(w);
    sum += power / BigInt(2 * j + 1);
  }
  return sum;
}

/** The natural logarithm of an integer above 0. */
export function ln(m: number, bits: number): bigint {
  if (!Number.isInteger(m) || m < 1) throw new RangeError(`ln is defined here for integers from 1, not ${m}`);
  const w = bits + GUARD;
  // ln m = k ln 2 + ln x with x = m / 2^k in [1, 2): z = (x - 1) / (x + 1) is at most 1/3.
  let k = 0;
  while (2 ** (k + 1) <= m) k++;
  const x = (BigInt(m) << BigInt(w)) >> BigInt(k);
  const numerator = x - one(w);
  const denominator = x + one(w);
  const lnx = 2n * atanh((numerator << BigInt(w)) / denominator, w);
  const two = 2n * atanh(one(w) / 3n, w);
  return (BigInt(k) * two + lnx) >> BigInt(GUARD);
}

/** The square root of an integer. */
export function sqrtInt(m: number, bits: number): bigint {
  const w = bits + GUARD;
  return sqrtFixed(BigInt(m) << BigInt(w), w) >> BigInt(GUARD);
}

/** The golden ratio. */
export function phi(bits: number): bigint {
  return (one(bits) + sqrtInt(5, bits)) >> 1n;
}

/** The constants a caller may name: `1`, `pi`, `e`, `phi`, `sqrt(m)`, `ln(m)` and `atan(1/k)`. */
export function constant(name: string, bits: number): bigint {
  switch (name) {
    case "1":
      return one(bits);
    case "pi":
      return pi(bits);
    case "e":
      return e(bits);
    case "phi":
      return phi(bits);
  }
  const root = /^sqrt\((\d+)\)$/.exec(name);
  if (root !== null) return sqrtInt(Number(root[1]), bits);
  const log = /^ln\((\d+)\)$/.exec(name);
  if (log !== null) return ln(Number(log[1]), bits);
  const atan = /^atan\(1\/(\d+)\)$/.exec(name);
  if (atan !== null) return atanInverse(Number(atan[1]), bits);
  throw new RangeError(`unknown constant ${JSON.stringify(name)}; the constants are 1, pi, e, phi, sqrt(m), ln(m) and atan(1/k)`);
}
