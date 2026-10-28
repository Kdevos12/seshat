/** A Beta posterior over a rate, as the two parameters that define it (the same shape as `@seshat/fleet`'s). */
export interface Beta {
  alpha: number;
  beta: number;
}

/** Nothing observed: Beta(1, 1), flat on [0, 1]. */
export const FLAT: Readonly<Beta> = { alpha: 1, beta: 1 };

/**
 * The counters of an older epoch shrunk toward the prior (plan change PE1 item 3): Beta(a, b) becomes
 * Beta(1 + (a - 1) k, 1 + (b - 1) k). With k = 1 nothing changes, with k = 0 the prior is back. The
 * counters a Beta holds above the prior are what the epoch learned, and k keeps that share of them.
 */
export function shrinkBeta(b: Beta, k: number): Beta {
  if (!(k >= 0 && k <= 1)) throw new RangeError(`the shrinkage k must be between 0 and 1, got ${k}`);
  return { alpha: 1 + (b.alpha - 1) * k, beta: 1 + (b.beta - 1) * k };
}

/** The posterior of `successes` and `failures` over the flat prior; the counts may be fractions (weighted). */
export function betaOfCounts(successes: number, failures: number): Beta {
  return { alpha: 1 + successes, beta: 1 + failures };
}

export function betaMean(b: Beta): number {
  return b.alpha / (b.alpha + b.beta);
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Gamma(x) for x > 0 (Lanczos). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += (LANCZOS[i] as number) / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the regularized incomplete beta function (Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b): the CDF of Beta(a, b) at x. */
export function betaCdf(x: number, b: Beta): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const { alpha: a, beta: c } = b;
  const front = Math.exp(lnGamma(a + c) - lnGamma(a) - lnGamma(c) + a * Math.log(x) + c * Math.log1p(-x));
  return x < (a + 1) / (a + c + 2) ? (front * betaContinuedFraction(x, a, c)) / a : 1 - (front * betaContinuedFraction(1 - x, c, a)) / c;
}

/** The density of Beta(a, b) at x in (0, 1). */
export function betaPdf(x: number, b: Beta): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp(lnGamma(b.alpha + b.beta) - lnGamma(b.alpha) - lnGamma(b.beta) + (b.alpha - 1) * Math.log(x) + (b.beta - 1) * Math.log1p(-x));
}

/**
 * P(X < Y) for independent X ~ `x` and Y ~ `y`: the integral over t of the density of X at t times
 * the chance that Y exceeds t. Exact up to the integration (Simpson's rule on 2000 intervals), and
 * deterministic: the same posteriors always give the same number. Parameters at least 1, as the
 * posteriors of this module always are, keep both densities bounded.
 */
export function probabilityLess(x: Beta, y: Beta): number {
  const n = 2000;
  const h = 1 / n;
  const f = (t: number): number => (t <= 0 || t >= 1 ? edge(t, x, y) : betaPdf(t, x) * (1 - betaCdf(t, y)));
  let sum = f(0) + f(1);
  for (let i = 1; i < n; i++) sum += f(i * h) * (i % 2 === 1 ? 4 : 2);
  return Math.min(1, Math.max(0, (sum * h) / 3));
}

/** The integrand at the ends of (0, 1), where the density is a limit: the density's value there when finite, else 0 (the weight is negligible). */
function edge(t: number, x: Beta, y: Beta): number {
  const at = t <= 0 ? 0 : 1;
  const density = x.alpha === 1 && at === 0 ? x.beta : x.beta === 1 && at === 1 ? x.alpha : 0;
  return density * (1 - betaCdf(at, y));
}
